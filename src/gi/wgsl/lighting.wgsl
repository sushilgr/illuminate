// Deferred lighting: shades the G-buffer with the cascade solution.
// Bindings: scene and direct-light bindings, c0Tex, fluTex, CAM,
//           gAlbedo (rgb base colour), gNormal (xyz world normal, a roughness),
//           gEmissive (rgb emitted radiance, a metalness), gDepth, causticTex, litOut.

struct Camera {
  invViewProj: mat4x4f,
  camPos: vec4f,       // xyz, w = 1 for an orthographic camera
  size: vec4f,         // x, y render size, z = caustic gain
  forward: vec4f,      // xyz view direction (used by the orthographic camera)
  haze: vec4f,         // rgb scattering tint, a = anisotropy g
}

// In-scattered light and transmittance of the haze between the camera and a surface.
// Direct sun is marched with its real visibility, which is what draws shafts; everything
// else comes from the fluence volume (mean radiance of cascade 1 at each of its probes).
fn hazeBetween(a: vec3f, b: vec3f, px: vec2u) -> vec4f {
  let sigma = G.flags.z;
  if (sigma <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let len = length(b - a);
  let dir = (b - a) / max(len, 1e-4);
  let steps = 12;
  let dt = len / f32(steps);
  // An interleaved offset hides the step pattern without noise that would need history.
  let jitter = f32((px.x * 5u + px.y * 3u) % 8u) / 8.0;
  var L = vec3f(0.0);
  var T = 1.0;
  let g = CAM.haze.a;
  let cosS = dot(dir, G.sunDir.xyz);
  let phase = (1.0 - g * g) / (4.0 * PI * pow(max(1.0 + g * g - 2.0 * g * cosS, 1e-3), 1.5));
  let lo = G.domainMin.xyz;
  let ext = G.gridVox.xyz * G.domainMin.w;
  for (var i = 0; i < steps; i++) {
    let p = a + dir * ((f32(i) + jitter) * dt);
    let uvw = (p - lo) / ext;
    if (any(uvw < vec3f(0.0)) || any(uvw > vec3f(1.0))) { continue; }
    var Li = vec3f(0.0);
    if (G.sunIrr.w > 0.5) {
      let ap = apertureSun(p, G.sunDir.xyz);
      if (ap.x > 0.0) {
        Li += G.sunIrr.rgb * (ap.x * phase) * shadowMarch(p, G.sunDir.xyz, ap.y - 3.0 * G.domainMin.w, G.sunDir.w, false);
      }
    }
    let f = textureSampleLevel(fluTex, samp, uvw, 0.0);
    if (f.a > 1e-3) { Li += f.rgb / f.a; }
    let op = 1.0 - exp(-sigma * dt);
    L += T * op * Li * CAM.haze.rgb;
    T *= 1.0 - op;
  }
  return vec4f(L, T);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(CAM.size.xy);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let px = vec2i(id.xy);
  let depth = textureLoad(gDepth, px, 0);
  let uv = (vec2f(id.xy) + vec2f(0.5)) / CAM.size.xy;
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let wp = CAM.invViewProj * ndc;
  let x = wp.xyz / wp.w;
  let mode = i32(G.counts.z + 0.5);
  // View ray.
  var ro = CAM.camPos.xyz;
  var rd: vec3f;
  if (CAM.camPos.w > 0.5) {
    let nearP = CAM.invViewProj * vec4f(ndc.xy, 0.0, 1.0);
    ro = nearP.xyz / nearP.w;
    rd = CAM.forward.xyz;
  } else {
    let farP = CAM.invViewProj * vec4f(ndc.xy, 0.5, 1.0);
    rd = normalize(farP.xyz / farP.w - ro);
  }

  if (depth >= 1.0) {
    // Nothing rendered: exterior seen through an opening, or the cutaway surround.
    var bg = vec3f(0.0);
    var alpha = 0.0;
    let u = worldToUvw(ro);
    if (all(u > vec3f(0.0)) && all(u < vec3f(1.0))) {
      alpha = 1.0;
      bg = skyRadiance(rd);
      if (G.sunIrr.w > 0.5) {
        // The sun's disc: its irradiance spread over its solid angle.
        let tanS = G.sunDir.w;
        let cosS = 1.0 / sqrt(1.0 + tanS * tanS);
        let disc = smoothstep(cosS - 2e-5, cosS + 2e-5, dot(rd, G.sunDir.xyz));
        bg += disc * G.sunIrr.rgb / (PI * tanS * tanS);
      }
    }
    textureStore(litOut, px, vec4f(bg, alpha));
    return;
  }

  let base = textureLoad(gAlbedo, px, 0).rgb;
  let nr = textureLoad(gNormal, px, 0);
  let n = normalize(nr.xyz);
  let rough = nr.a;
  let em4 = textureLoad(gEmissive, px, 0);
  let em = em4.rgb;
  let metal = em4.a;
  let albedo = base * (1.0 - 0.85 * metal);

  let ga = gatherIrradiance(x, n, 4);
  var Ed = directIrradiance(x, n, true);
  if (G.flags.y > 0.5) { Ed += textureLoad(causticTex, px, 0).rgb * CAM.size.z; }
  var L = em + albedo / PI * (ga.E + Ed);

  // Cone-traced reflection for glossy and metallic surfaces.
  var spec = vec3f(0.0);
  if (G.flags.x > 0.5 && rough < 0.6) {
    let v = -rd;
    let r = reflect(rd, n);
    let h = G.domainMin.w;
    let tanH = clamp(0.03 + 1.1 * rough * rough, 0.03, 0.8);
    let hit = marchCone(x + n * (G.rc2.x + 0.3 * h), r, 0.4 * h, 14.0, 0.0, tanH, max(dot(n, r), 0.05), 48);
    var Ls = hit.J;
    if (hit.tHit < NO_HIT) { Ls += (1.0 - hit.cov) * hit.T * hit.LHit; }
    let f0 = mix(vec3f(0.04), base, metal);
    let fres = f0 + (vec3f(1.0) - f0) * pow(1.0 - max(dot(n, v), 0.0), 5.0);
    spec = fres * Ls * (1.0 - rough * (1.0 - metal));
    L += spec;
  }

  // Diagnostic views.
  if (mode == 1) { L = (ga.E + Ed) / PI; }
  else if (mode == 2) { L = base; }
  else if (mode == 3) { L = n * 0.5 + vec3f(0.5); }
  else if (mode == 4) { L = vec3f(ga.vis); }
  else if (mode == 5) {
    // Signed distance of the voxel proxy at the shaded point (should be ~0 on surfaces).
    let d = sdfAt(x) / G.domainMin.w;
    L = vec3f(saturate(d), saturate(1.0 - abs(d)), saturate(-d));
  }
  else if (mode == 6) {
    // One cascade 0 direction, as stored.
    let k = u32(G.counts.w + 0.5) % C0_DIRS;
    let f = c0Sample(probePoint(x, n), k);
    L = select(vec3f(1.0, 0.0, 1.0), f.rgb / max(f.a, 1e-3), f.a > 1e-3);
  }
  else if (mode == 7) {
    // Radiance cache at the surface.
    let r = textureSampleLevel(radTex, samp, worldToUvw(x + n * 0.75 * G.domainMin.w), 0.0);
    L = r.rgb / max(r.a, 1e-3);
  }
  else if (mode == 8) { L = Ed / PI; }
  else if (mode == 9) { L = ga.E / PI; }
  else if (mode == 10) { L = spec; }

  if (mode == 0 && G.flags.z > 0.0) {
    let hz = hazeBetween(ro, x, id.xy);
    L = L * hz.a + hz.rgb;
  }
  textureStore(litOut, px, vec4f(L, 1.0));
}
