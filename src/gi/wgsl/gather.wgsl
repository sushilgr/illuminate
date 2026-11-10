// Final gather shared by the radiance cache (bounce feedback), the deferred lighting pass and
// the light meter. Requires scene.wgsl plus c0Tex: cascade 0 after merging, premultiplied by
// probe validity. Layout of c0Tex: 8 x 8 direction tiles, each holding the probe grid in (x, y).

fn c0Sample(x: vec3f, k: u32) -> vec4f {
  let g = G.probe0.xyz;
  let pu = (x - G.domainMin.xyz) / G.probe0.w;
  let q = clamp(pu, vec3f(0.5), g - vec3f(0.5));
  let tile = vec2f(f32(k % C0_RES), f32(k / C0_RES));
  let n = f32(C0_RES);
  let uvw = vec3f((tile.x * g.x + q.x) / (n * g.x), (tile.y * g.y + q.y) / (n * g.y), q.z / g.z);
  return textureSampleLevel(c0Tex, samp, uvw, 0.0);
}

// Where to read cascade 0 for a surface point. The lookup is pushed off the surface along
// the normal. Probes behind the surface's tangent plane are either buried (their texels are
// zero and drop out of the filter) or on the far side of a thin wall, where they would bleed
// that side's light through. The push therefore grows with the filter weight that falls on
// probes behind the plane; it varies continuously, so it leaves no seams.
fn probePoint(x: vec3f, n: vec3f) -> vec3f {
  let ds = G.probe0.w;
  let xs = x + n * (0.75 * ds);
  let pu = (xs - G.domainMin.xyz) / ds - vec3f(0.5);
  let b = floor(pu);
  let f = pu - b;
  var behind = 0.0;
  for (var i = 0; i < 8; i++) {
    let o = vec3f(f32(i & 1), f32((i >> 1) & 1), f32((i >> 2) & 1));
    let wv = mix(vec3f(1.0) - f, f, o);
    let U = G.domainMin.xyz + (b + o + vec3f(0.5)) * ds;
    if (dot(U - x, n) < 0.0) { behind += wv.x * wv.y * wv.z; }
  }
  return x + n * (ds * min(0.75 + 3.0 * behind, 1.75));
}

struct Gather {
  E: vec3f,     // irradiance
  vis: f32,     // cosine-weighted near-field visibility (diagnostic)
}

// Irradiance at surface point x with normal n.
//
// The 64 directions of cascade 0 are cosine-weighted individually. They are grouped 2 x 2
// into 16 coarse cones that are traced from the surface itself over [0, tNear] at full
// spatial resolution ("cascade -1"); what a cone lets through is continued by the
// interpolated cascade 0 values of its four directions. The cone overshoots tNear slightly so
// that thin geometry between the surface and the probes' own interval start is not missed.
fn gatherIrradiance(x: vec3f, n: vec3f, nearSteps: i32) -> Gather {
  let h = G.domainMin.w;
  let tN = G.rc.x;
  let tanH = coneTan(f32(COARSE_RES));
  let xo = x + n * (G.rc2.x + 0.2 * h);
  let xs = probePoint(x, n);
  var E = vec3f(0.0);
  var ws = 0.0;
  var vs = 0.0;
  for (var kc = 0u; kc < COARSE_RES * COARSE_RES; kc++) {
    let cx = 2u * (kc % COARSE_RES);
    let cy = 2u * (kc / COARSE_RES);
    var wc: array<f32, 4>;
    var kf: array<u32, 4>;
    var wk = 0.0;
    var wdir = vec3f(0.0);
    for (var j = 0u; j < 4u; j++) {
      let k = (cy + (j >> 1u)) * C0_RES + cx + (j & 1u);
      let dir = G.dirs[k].xyz;
      let wt = cosWeight(dot(n, dir), 0.25);
      kf[j] = k;
      wc[j] = wt;
      wk += wt;
      wdir += wt * dir;
    }
    if (wk <= 0.0) { continue; }
    ws += wk;
    // The cone follows the weighted mean of its directions, which keeps it above the surface.
    let w = normalize(wdir);
    let c = dot(n, w);
    let nr = marchCone(xo, w, 0.3 * h, tN, 0.5 * G.probe0.w, tanH, max(c, 0.0), nearSteps);
    var L = wk * nr.J;
    if (nr.tHit < NO_HIT) {
      L += wk * (1.0 - nr.cov) * nr.LHit;
    } else {
      let beta = 1.0 - nr.cov;
      vs += wk * beta;
      if (beta > 0.004) {
        for (var j = 0u; j < 4u; j++) {
          if (wc[j] <= 0.0) { continue; }
          let f = c0Sample(xs, kf[j]);
          if (f.a > 1e-3) { L += beta * wc[j] * f.rgb / f.a; }
        }
      }
    }
    E += L;
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
    let d = textureSampleLevel(geomTex, samp, uvw, 0.0).r - 0.3 * G.rc2.x;
    if (d < 0.0) { return 0.0; }
    res = min(res, k * d / t);
    t += max(d, 0.4 * h);
  }
  return smoothstep(0.0, 1.0, res);
}
