// Deferred lighting: shades the G-buffer with the cascade solution.
// Bindings: G, CAM, samp, geomTex, radTex, jTex/jtA/jtB, c0Tex,
//           gAlbedo, gNormal, gEmissive (texture_2d), gDepth (texture_depth_2d), litOut.

struct Camera {
  invViewProj: mat4x4f,
  camPos: vec4f,       // xyz, w = unused
  size: vec4f,         // x, y render size
}

fn heat(t: f32) -> vec3f {
  let x = saturate(t);
  return saturate(vec3f(1.5 - abs(4.0 * x - 3.0), 1.5 - abs(4.0 * x - 2.0), 1.5 - abs(4.0 * x - 1.0)));
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

  if (depth >= 1.0) {
    // Nothing rendered: exterior seen through an aperture, or the cutaway surround.
    let far = CAM.invViewProj * vec4f(ndc.xy, 0.5, 1.0);
    let w = normalize(far.xyz / far.w - CAM.camPos.xyz);
    var bg = vec3f(0.0);
    let u = worldToUvw(CAM.camPos.xyz);
    if (all(u > vec3f(0.0)) && all(u < vec3f(1.0))) { bg = skyRadiance(w); }
    textureStore(litOut, px, vec4f(bg, 0.0));
    return;
  }

  let albedo = textureLoad(gAlbedo, px, 0).rgb;
  let nraw = textureLoad(gNormal, px, 0).xyz;
  let n = normalize(nraw);
  let em = textureLoad(gEmissive, px, 0).rgb;

  let ga = gatherIrradiance(x, n, 4);
  var E = ga.E;
  var sunE = vec3f(0.0);
  if (G.sunIrr.w > 0.5) {
    sunE = G.sunIrr.rgb * max(dot(n, G.sunDir.xyz), 0.0) * sunVisibility(x, n);
  }
  var L = em + albedo / PI * (E + sunE);

  // Diagnostic views.
  if (mode == 1) { L = (E + sunE) / PI; }
  else if (mode == 2) { L = albedo; }
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
    let f = c0Sample(x + n * (0.75 * G.probe0.w), k);
    L = select(vec3f(1.0, 0.0, 1.0), f.rgb / max(f.a, 1e-3), f.a > 1e-3);
  }
  else if (mode == 7) {
    // Radiance cache at the surface.
    let r = textureSampleLevel(radTex, samp, worldToUvw(x + n * 0.75 * G.domainMin.w), 0.0);
    L = r.rgb / max(r.a, 1e-3);
  }
  else if (mode == 8) { L = sunE / PI; }
  textureStore(litOut, px, vec4f(L, 1.0));
}
