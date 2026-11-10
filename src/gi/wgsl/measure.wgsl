// Light meter: evaluates the final gather at arbitrary points (diagnostics, validation, UI readouts).
// Bindings: G, samp, geomTex, radTex, jTex/jtA/jtB, c0Tex, pts (storage, read), outE (storage, read_write).

struct MeterPoint { p: vec4f, n: vec4f }

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&pts)) { return; }
  let m = pts[id.x];
  let n = normalize(m.n.xyz);
  let ga = gatherIrradiance(m.p.xyz, n, 4);
  var E = ga.E;
  if (G.sunIrr.w > 0.5) {
    E += G.sunIrr.rgb * max(dot(n, G.sunDir.xyz), 0.0) * sunVisibility(m.p.xyz, n);
  }
  outE[id.x] = vec4f(E, ga.vis);
}
