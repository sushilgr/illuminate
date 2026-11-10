// Radiance cache: outgoing radiance of every surface voxel, read by cascade rays when they hit.
//   L = Le + (albedo / pi) * bounceGain * (E_gather + E_sun)
// E_gather comes from the cascades of the previous solver iteration, which turns the
// cascade solve into a Jacobi iteration of the rendering equation: iteration k holds
// k bounces. Emission (bounce 0) and the sun term are always from the current frame.
// Bindings: G, samp, geomTex, albedoTex, emitTex, radTex (previous iteration), jTex/jtA/jtB, c0Tex, radOut.

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = vec3u(G.gridVox.xyz);
  if (any(id >= dims)) { return; }
  let h = G.domainMin.w;
  let d = textureLoad(geomTex, vec3i(id), 0).r;
  // Only voxels that a surface lookup can touch (it samples 0.75 h outside the surface).
  if (d > 1.85 * h || d < -1.1 * h) {
    textureStore(radOut, id, vec4f(0.0));
    return;
  }
  let p = G.domainMin.xyz + (vec3f(id) + vec3f(0.5)) * h;
  let n = sdfNormalCentral(p);
  let xs = p - n * d;
  let le = textureLoad(emitTex, vec3i(id), 0).rgb;
  var E = vec3f(0.0);
  if (G.rc2.y > 0.0) {
    E = gatherIrradiance(xs, n, 3).E;
    if (G.sunIrr.w > 0.5) {
      E += G.sunIrr.rgb * max(dot(n, G.sunDir.xyz), 0.0) * sunVisibility(xs, n);
    }
  }
  let albedo = textureLoad(albedoTex, vec3i(id), 0).rgb;
  let L = le + albedo * (G.rc2.y / PI) * E;
  textureStore(radOut, id, vec4f(L, 1.0));
}
