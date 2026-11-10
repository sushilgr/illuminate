// Scene queries against the voxelised representation.
// Requires bindings: G (Globals), samp, geomTex (r signed distance to solids, g distance to thin emitters),
// radTex (premultiplied outgoing radiance, a validity), jTex / jtA / jtB (thin emitters).

fn worldToUvw(p: vec3f) -> vec3f {
  return (p - G.domainMin.xyz) / (G.gridVox.xyz * G.domainMin.w);
}

fn sdfAt(p: vec3f) -> f32 {
  return textureSampleLevel(geomTex, samp, worldToUvw(p), 0.0).r;
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

// Marches a cone along a radiance interval [tA, tB], optionally continuing to tB + ext.
//
// Inside [tA, tB] the ray collects partial coverage from surfaces beside it and the emission
// of thin emitters (prefiltered density). A surface crossed by the axis stops the ray; its
// distance and radiance are returned separately so the merge can decide, per upper probe,
// whether that surface belongs to this interval or to the next one. The extension
// (tB, tB + ext] is searched for such a stopping surface only.
//
// Surfaces count as crossed inside a band of width eps so that sheets thinner than a voxel
// cannot be stepped over; to keep the band from absorbing rays that merely start beside a
// surface, a band hit also requires the distance to be decreasing along the ray.
// planeC limits the cone radius to t * planeC + margin, used by rays leaving a surface so
// that the cone does not clip the surface it starts on (pass a large value otherwise).
fn marchCone(p0: vec3f, w: vec3f, tA: f32, tB: f32, ext: f32, tanH: f32, planeC: f32, maxSteps: i32) -> Hit {
  let h = G.domainMin.w;
  let eps = G.rc2.x;
  var t = tA;
  var cov = 0.0;
  var J = vec3f(0.0);
  var dPrev = 0.0;
  var tPrev = tA;
  // The domain is a closed shell pierced only by apertures. An interval that begins beyond it
  // sees whatever the ray crossed on its way out: sky through an aperture, the wall otherwise.
  let u0 = worldToUvw(p0 + w * tA);
  if (any(u0 < vec3f(0.0)) || any(u0 > vec3f(1.0))) {
    let lo = G.domainMin.xyz;
    let hi = lo + G.gridVox.xyz * h;
    let inv = 1.0 / select(w, vec3f(1e-6), abs(w) < vec3f(1e-6));
    let tt = max((lo - p0) * inv, (hi - p0) * inv);
    let tExit = max(min(tt.x, min(tt.y, tt.z)) - 0.75 * h, 0.0);
    let pe = p0 + w * tExit;
    let de = sdfAt(pe);
    if (de > eps) { return Hit(J, 0.0, skyRadiance(w), tA); }
    return Hit(J, 0.0, surfaceRadiance(pe, de), tA);
  }
  let tEnd = tB + ext;
  for (var i = 0; i < maxSteps; i++) {
    let p = p0 + w * t;
    let uvw = worldToUvw(p);
    if (any(uvw < vec3f(0.0)) || any(uvw > vec3f(1.0))) {
      return Hit(J, cov, skyRadiance(w), t);
    }
    let g = textureSampleLevel(geomTex, samp, uvw, 0.0);
    let d = g.r;
    let r = max(min(t * tanH, t * planeC + 0.35 * h), 0.25 * h);
    // rc is the coverage radius. Treating every axis crossing as a full hit dilates
    // silhouettes by about rc / 4, so rc is a fraction (G.rc.z) of the cone radius.
    let rc = r * G.rc.z;
    if (d < max(eps, rc)) {
      var slope: f32;
      if (i == 0) {
        let la = 0.3 * h;
        slope = (sdfAt(p + w * la) - d) / la;
      } else {
        slope = (d - dPrev) / max(t - tPrev, 1e-5);
      }
      slope = clamp(slope, -1.0, 1.0);
      if (d < 0.0 || (d < eps && slope < -0.02)) {
        return Hit(J, cov, surfaceRadiance(p, d), t);
      }
      if (t <= tB) {
        let side = sqrt(1.0 - slope * slope);
        let c = 0.5 - 0.5 * d / max(rc * side, 1e-4);
        if (c > cov) {
          J += (c - cov) * surfaceRadiance(p, d);
          cov = c;
        }
      }
    }
    // Step by the free distance. Near a thin emitter (g.g is the distance to its density
    // kernel) the step is limited to the cone diameter and the emission is integrated.
    var adv: f32;
    if (g.g < 2.5 * r) {
      // The density is read from a mip whose texels match the step (2r); its filter reaches
      // 2r beyond the kernel, so integration has to start that far out to keep the total exact.
      adv = clamp(d, 0.5 * h, max(2.0 * r, 2.0 * h));
      let ds = min(adv, tB - t);
      if (ds > 0.0) {
        J += (1.0 - cov) * thinEmission(p + w * (0.5 * ds), w, r) * ds;
      }
    } else {
      adv = max(min(d, g.g - 2.0 * r), 0.5 * h);
    }
    dPrev = d;
    tPrev = t;
    t += adv;
    if (t >= tEnd) { break; }
  }
  return Hit(J, cov, vec3f(0.0), NO_HIT);
}
