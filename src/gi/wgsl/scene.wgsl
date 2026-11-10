// Scene queries against the voxelised representation.
// Requires bindings: G (Globals), samp, geomTex (rgb albedo, a signed distance),
// radTex (premultiplied outgoing radiance, a validity), jTex / jtA / jtB (thin emitters).

fn worldToUvw(p: vec3f) -> vec3f {
  return (p - G.domainMin.xyz) / (G.gridVox.xyz * G.domainMin.w);
}

fn sdfAt(p: vec3f) -> f32 {
  return textureSampleLevel(geomTex, samp, worldToUvw(p), 0.0).a;
}

// Forward-difference gradient; d0 is the distance already sampled at p.
fn sdfNormal(p: vec3f, d0: f32) -> vec3f {
  let e = G.domainMin.w * 0.8;
  let g = vec3f(
    sdfAt(p + vec3f(e, 0.0, 0.0)) - d0,
    sdfAt(p + vec3f(0.0, e, 0.0)) - d0,
    sdfAt(p + vec3f(0.0, 0.0, e)) - d0);
  let l = length(g);
  if (l < 1e-6) { return vec3f(0.0, 1.0, 0.0); }
  return g / l;
}

fn sdfNormalCentral(p: vec3f) -> vec3f {
  let e = G.domainMin.w * 0.8;
  let g = vec3f(
    sdfAt(p + vec3f(e, 0.0, 0.0)) - sdfAt(p - vec3f(e, 0.0, 0.0)),
    sdfAt(p + vec3f(0.0, e, 0.0)) - sdfAt(p - vec3f(0.0, e, 0.0)),
    sdfAt(p + vec3f(0.0, 0.0, e)) - sdfAt(p - vec3f(0.0, 0.0, e)));
  let l = length(g);
  if (l < 1e-6) { return vec3f(0.0, 1.0, 0.0); }
  return g / l;
}

// Outgoing radiance of the surface nearest to p. The lookup is pushed just outside the
// surface so that a thin wall never blends in the radiance of its far side.
fn surfaceRadiance(p: vec3f, d: f32) -> vec3f {
  let n = sdfNormal(p, d);
  let q = p + n * (0.75 * G.domainMin.w - d);
  let r = textureSampleLevel(radTex, samp, worldToUvw(q), 0.0);
  if (r.a < 1e-3) { return vec3f(0.0); }
  return r.rgb / r.a;
}

// Exterior radiance seen through an aperture. The sun disc is handled analytically elsewhere.
fn skyRadiance(w: vec3f) -> vec3f {
  var c: vec3f;
  if (w.y >= 0.0) {
    c = mix(G.skyHor.rgb, G.skyZen.rgb, pow(saturate(w.y), 0.55));
  } else {
    c = mix(G.skyHor.rgb, G.skyGnd.rgb, smoothstep(0.0, 0.18, -w.y));
  }
  return c * G.rc2.w;
}

// Emission of thin (line-like) emitters, stored as a prefiltered emission density.
// r is the radius of the cone footprint at p; the returned value is radiance per metre.
fn thinEmission(p: vec3f, w: vec3f, r: f32) -> vec3f {
  let lod = log2(max(2.0 * r / G.gridVox.w, 1.0));
  let uvw = worldToUvw(p);
  let j = textureSampleLevel(jTex, samp, uvw, lod).rgb;
  if (j.r + j.g + j.b <= 0.0) { return vec3f(0.0); }
  let a = textureSampleLevel(jtA, samp, uvw, lod);
  if (a.w <= 1e-8) { return j; }
  let b = textureSampleLevel(jtB, samp, uvw, lod).rgb;
  let q = (a.x * w.x * w.x + a.y * w.y * w.y + a.z * w.z * w.z
         + 2.0 * (b.x * w.x * w.y + b.y * w.x * w.z + b.z * w.y * w.z)) / a.w;
  return j * 2.0 * sqrt(max(q, 0.0));
}

// Marches a cone along a radiance interval [tA, tB].
// Solid geometry is resolved against the signed distance field with fractional coverage,
// thin emitters are integrated from the prefiltered emission density.
//
// Surfaces are treated as hit inside a band of width eps so that sheets thinner than a voxel
// cannot be stepped over. To keep that band from absorbing rays that merely start next to a
// surface, a band hit also requires the distance to be decreasing along the ray; coverage
// uses the same slope to tell a wall beside the cone from a wall behind it.
// planeC limits the cone radius to t * planeC + margin, used by rays leaving a surface so
// that the cone does not clip the surface it starts on (pass a large value otherwise).
fn marchCone(p0: vec3f, w: vec3f, tA: f32, tB: f32, tanH: f32, planeC: f32, maxSteps: i32) -> Hit {
  let h = G.domainMin.w;
  let eps = G.rc2.x;
  var t = tA;
  var cov = 0.0;
  var J = vec3f(0.0);
  var dPrev = 0.0;
  var tPrev = tA;
  for (var i = 0; i < maxSteps; i++) {
    let p = p0 + w * t;
    let uvw = worldToUvw(p);
    if (any(uvw < vec3f(0.0)) || any(uvw > vec3f(1.0))) {
      J += (1.0 - cov) * skyRadiance(w);
      cov = 1.0;
      break;
    }
    let d = textureSampleLevel(geomTex, samp, uvw, 0.0).a;
    let r = max(min(t * tanH, t * planeC + 0.35 * h), 0.25 * h);
    if (d < max(eps, r)) {
      var slope: f32;
      if (i == 0) {
        let la = 0.3 * h;
        slope = (sdfAt(p + w * la) - d) / la;
      } else {
        slope = (d - dPrev) / max(t - tPrev, 1e-5);
      }
      slope = clamp(slope, -1.0, 1.0);
      if (d < 0.0 || (d < eps && slope < -0.02)) {
        J += (1.0 - cov) * surfaceRadiance(p, d);
        cov = 1.0;
        break;
      }
      let side = sqrt(1.0 - slope * slope);
      let c = 0.5 - 0.5 * d / max(r * side, 1e-4);
      if (c > cov) {
        J += (c - cov) * surfaceRadiance(p, d);
        cov = c;
      }
    }
    let adv = clamp(d, 0.5 * h, max(2.0 * r, 2.0 * h));
    let ds = min(adv, tB - t);
    if (G.counts.y > 0.5) {
      J += (1.0 - cov) * thinEmission(p + w * (0.5 * ds), w, r) * ds;
    }
    dPrev = d;
    tPrev = t;
    t += adv;
    if (t >= tB) { break; }
  }
  return Hit(J, 1.0 - cov);
}
