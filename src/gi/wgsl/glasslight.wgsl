// Lighting of glass surfaces, per pixel of the glass layer: the cone-traced reflection and
// the light scattered by frost. The refracted view through the glass is composed afterwards
// in the forward optics pass, which reads these two images.
// Bindings: scene and direct-light bindings, c0Tex, CAM (Camera),
//           ggNormal (xyz world normal, a frost after etching), ggAux (r F0, g 1 if glass), ggDepth,
//           gDepth (opaque depth), reflOut, scatOut.

struct Camera {
  invViewProj: mat4x4f,
  camPos: vec4f,
  size: vec4f,
  forward: vec4f,
  haze: vec4f,
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(CAM.size.xy);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let px = vec2i(id.xy);
  let depth = textureLoad(ggDepth, px, 0);
  if (depth >= 1.0 || depth > textureLoad(gDepth, px, 0)) {
    textureStore(reflOut, px, vec4f(0.0));
    textureStore(scatOut, px, vec4f(0.0));
    return;
  }
  let uv = (vec2f(id.xy) + vec2f(0.5)) / CAM.size.xy;
  let ndc = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  let wp = CAM.invViewProj * ndc;
  let x = wp.xyz / wp.w;
  var rd: vec3f;
  if (CAM.camPos.w > 0.5) { rd = CAM.forward.xyz; } else { rd = normalize(x - CAM.camPos.xyz); }
  let nr = textureLoad(ggNormal, px, 0);
  var n = normalize(nr.xyz);
  if (dot(n, rd) > 0.0) { n = -n; }
  let frost = nr.a;
  let f0 = textureLoad(ggAux, px, 0).r;
  let h = G.domainMin.w;

  // Reflection: a cone that widens with the frost.
  let r = reflect(rd, n);
  let tanH = clamp(0.02 + 0.5 * frost, 0.02, 0.6);
  let hit = marchCone(x + n * (2.0 * h), r, 0.5 * h, 14.0, 0.0, tanH, 1e6, 48);
  var Lr = hit.J;
  if (hit.tHit < NO_HIT) { Lr += (1.0 - hit.cov) * hit.T * hit.LHit; }
  let fres = f0 + (1.0 - f0) * pow(1.0 - max(dot(n, -rd), 0.0), 5.0);
  // Sun glint.
  if (G.sunIrr.w > 0.5) {
    let tanS = max(G.sunDir.w, 0.02 + 0.3 * frost);
    let cosS = 1.0 / sqrt(1.0 + tanS * tanS);
    let g = smoothstep(cosS, mix(cosS, 1.0, 0.5), dot(r, G.sunDir.xyz));
    if (g > 0.0) {
      let ap = apertureSun(x, G.sunDir.xyz);
      if (ap.x > 0.0) {
        Lr += g * ap.x * G.sunIrr.rgb / (PI * tanS * tanS) * shadowMarch(x + n * (2.0 * h), G.sunDir.xyz, ap.y - 3.0 * h, G.sunDir.w, false);
      }
    }
  }
  textureStore(reflOut, px, vec4f(Lr * fres, fres));

  // Frost scatters what arrives on both faces.
  var scat = vec3f(0.0);
  if (frost > 0.01) {
    let xf = x + n * (2.0 * h);
    let xb = x - n * (2.0 * h + 0.06);
    let E = gatherIrradiance(xf, n, 2).E + directIrradiance(xf, n, false)
          + gatherIrradiance(xb, -n, 2).E + directIrradiance(xb, -n, false);
    scat = E * (frost * 0.8 / (2.0 * PI));
  }
  textureStore(scatOut, px, vec4f(scat, 1.0));
}
