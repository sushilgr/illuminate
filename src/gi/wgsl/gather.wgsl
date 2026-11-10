// Final gather shared by the radiance cache (bounce feedback) and the deferred lighting pass.
// Requires scene.wgsl plus c0Tex: cascade 0 after merging, premultiplied by probe validity.
// Layout of c0Tex: 4 x 4 direction tiles, each tile holding the probe grid (x, y), depth = z.

fn c0Sample(x: vec3f, k: u32) -> vec4f {
  let g = G.probe0.xyz;
  let pu = (x - G.domainMin.xyz) / G.probe0.w;
  let q = clamp(pu, vec3f(0.5), g - vec3f(0.5));
  let tile = vec2f(f32(k % 4u), f32(k / 4u));
  let uvw = vec3f((tile.x * g.x + q.x) / (4.0 * g.x), (tile.y * g.y + q.y) / (4.0 * g.y), q.z / g.z);
  return textureSampleLevel(c0Tex, samp, uvw, 0.0);
}

struct Gather {
  E: vec3f,     // irradiance
  vis: f32,     // cosine-weighted near-field visibility (diagnostic)
}

// Irradiance at surface point x with normal n.
// Each cascade 0 direction is continued from the surface itself: a short cone covers
// [0, tNear] at full spatial resolution ("cascade -1"), then the interpolated cascade 0
// value supplies everything beyond tNear.
fn gatherIrradiance(x: vec3f, n: vec3f, nearSteps: i32) -> Gather {
  let h = G.domainMin.w;
  let tN = G.rc.x;
  let tanH = coneTan(C0_RES);
  let xo = x + n * (G.rc2.x + 0.2 * h);
  let xs = x + n * (0.75 * G.probe0.w);
  var E = vec3f(0.0);
  var ws = 0.0;
  var vs = 0.0;
  for (var k = 0u; k < C0_DIRS; k++) {
    let w = G.dirs[k].xyz;
    let c = dot(n, w);
    let wt = cosWeight(c);
    if (wt <= 0.0) { continue; }
    ws += wt;
    let nr = marchCone(xo, w, 0.3 * h, tN, tanH, max(c, 0.0), nearSteps);
    var L = nr.J;
    if (nr.beta > 0.004) {
      let f = c0Sample(xs, k);
      if (f.a > 1e-3) { L += nr.beta * f.rgb / f.a; }
    }
    vs += wt * nr.beta;
    E += wt * L;
  }
  let inv = 1.0 / max(ws, 1e-4);
  return Gather(E * (PI * inv), vs * inv);
}

// Soft visibility towards the sun, traced through the distance field.
fn sunVisibility(x: vec3f, n: vec3f) -> f32 {
  if (G.sunIrr.w < 0.5) { return 0.0; }
  let h = G.domainMin.w;
  let s = G.sunDir.xyz;
  let ndl = dot(n, s);
  if (ndl <= 0.0) { return 0.0; }
  let k = 1.0 / max(G.sunDir.w, 1e-3);
  let p0 = x + n * (G.rc2.x + 0.25 * h);
  var t = 0.5 * h;
  var res = 1.0;
  for (var i = 0; i < 64; i++) {
    let p = p0 + s * t;
    let uvw = worldToUvw(p);
    if (any(uvw < vec3f(0.0)) || any(uvw > vec3f(1.0))) { break; }
    let d = textureSampleLevel(geomTex, samp, uvw, 0.0).a - 0.3 * G.rc2.x;
    if (d < 0.0) { return 0.0; }
    res = min(res, k * d / t);
    t += max(d, 0.4 * h);
  }
  return smoothstep(0.0, 1.0, res);
}
