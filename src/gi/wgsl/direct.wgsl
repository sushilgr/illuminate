// Direct light from analytic sources: the sun through the room's openings, and light apertures.
// Requires scene.wgsl plus etchTex (etched frost mask of one glass panel).

// Direct sun through the openings of the room, evaluated analytically so that edges and
// glazing bars stay exact at any voxel size. Returns (visibility, distance to the opening).
// The penumbra widens with distance according to the sun's angular radius.
fn apertureSun(x: vec3f, s: vec3f) -> vec2f {
  var best = vec2f(0.0, 0.0);
  let count = i32(G.roomMin.w);
  let tanS = G.sunDir.w;
  for (var i = 0; i < count; i++) {
    let a = G.aps[i];
    let dn = dot(s, a.n.xyz);
    if (dn <= 1e-3) { continue; }
    let ti = dot(a.c.xyz - x, a.n.xyz) / dn;
    if (ti <= 0.0) { continue; }
    let hw = a.c.w;
    let hh = a.u.w;
    let thick = a.v.w;
    let to = ti + thick / dn;
    let ri = x + s * ti - a.c.xyz;
    let ro = x + s * to - a.c.xyz;
    let qi = vec2f(dot(ri, a.u.xyz), dot(ri, a.v.xyz));
    let qo = vec2f(dot(ro, a.u.xyz), dot(ro, a.v.xyz));
    let peni = max(ti * tanS, 0.003);
    let peno = max(to * tanS, 0.003);
    var v = smoothstep(peni, -peni, max(abs(qi.x) - hw, abs(qi.y) - hh))
          * smoothstep(peno, -peno, max(abs(qo.x) - hw, abs(qo.y) - hh));
    if (v <= 0.0) { continue; }
    let fh = a.m.z;
    if (fh > 0.0) {
      // Glazing bars sit at mid depth. Their grid is anchored to the bottom of the opening.
      let tm = ti + 0.5 * thick / dn;
      let rm = x + s * tm - a.c.xyz;
      let qm = vec2f(dot(rm, a.u.xyz), dot(rm, a.v.xyz));
      let pen = max(tm * tanS, 0.003);
      v *= smoothstep(pen, -pen, max(abs(qm.x) - (hw - 2.0 * fh), abs(qm.y) - (hh - 2.0 * fh)));
      let cw = 2.0 * hw / max(a.m.x, 1.0);
      let ch = 2.0 * hh / max(a.m.y, 1e-3);
      if (a.m.x > 1.5) {
        let dx = abs(fract((qm.x + hw) / cw + 0.5) - 0.5) * cw;
        v *= smoothstep(-pen, pen, dx - fh);
      }
      if (a.m.y > 1.2) {
        let dy = abs(fract((qm.y + hh) / ch + 0.5) - 0.5) * ch;
        v *= smoothstep(-pen, pen, dy - fh);
      }
    }
    if (v > best.x) { best = vec2f(v, ti); }
  }
  return best;
}

// Frost of a glass voxel at p, after any etching: one panel can carry a painted mask that
// removes frost where it was brushed.
fn frostAt(p: vec3f, frost: f32) -> f32 {
  if (G.etchV.w < 0.5) { return frost; }
  let rel = p - G.etchC.xyz;
  let a = dot(rel, G.etchU.xyz);
  let b = dot(rel, G.etchV.xyz);
  let c = dot(rel, cross(G.etchU.xyz, G.etchV.xyz));
  if (abs(a) > G.etchC.w || abs(b) > G.etchU.w || abs(c) > 0.2) { return frost; }
  let uv = vec2f(a / G.etchC.w, -b / G.etchU.w) * 0.5 + vec2f(0.5);
  return frost * (1.0 - textureSampleLevel(etchTex, samp, uv, 0.0).r);
}

// Transmittance of a shadow ray from p0 towards a source, over [0, tEnd]. Solids block it
// (softly, according to the source's angular size tanSrc); glass tints it and frost removes
// the scattered share. In the camera image (view = true) glass that casts caustics blocks the
// direct beam entirely, because the caustic photons deliver that light instead.
fn shadowMarch(p0: vec3f, dir: vec3f, tEnd: f32, tanSrc: f32, view: bool) -> vec3f {
  let h = G.domainMin.w;
  var t = 0.5 * h;
  var res = 1.0;
  var T = vec3f(1.0);
  var prevB = 1.0;
  for (var i = 0; i < 64; i++) {
    if (t >= tEnd) { break; }
    let p = p0 + dir * t;
    let uvw = worldToUvw(p);
    let g = textureSampleLevel(geomTex, samp, uvw, 0.0);
    let d = g.r - 0.3 * G.rc2.x;
    if (d < 0.0) { return vec3f(0.0); }
    // The distance field cannot resolve a penumbra narrower than about a third of a voxel.
    res = min(res, d / max(t * tanSrc, 0.35 * h));
    var adv = max(d, 0.4 * h);
    if (g.b < 1e2) {
      adv = min(adv, max(abs(g.b), 0.4 * h));
      if (g.b < 0.0) {
        let gl = textureSampleLevel(glassTex, samp, uvw, 0.0);
        let caustic = gl.a >= 0.5;
        if (prevB >= 0.0) {
          if (view && caustic && G.flags.y > 0.5) { return vec3f(0.0); }
          let frost = clamp((gl.a - select(0.0, 0.5, caustic)) / 0.49, 0.0, 1.0);
          // Two air-glass interfaces reflect about 8 %.
          T *= 0.92 * (1.0 - frostAt(p, frost));
        }
        T *= pow(gl.rgb, vec3f(adv / GLASS_UNIT));
      }
      prevB = g.b;
    }
    t += adv;
  }
  return T * smoothstep(0.0, 1.0, res);
}

// Beam profile of a light aperture towards unit direction dl (from the light): a circular
// field with a feathered edge, trimmed by four shutters.
fn spotProfile(sp: Spot, dl: vec3f) -> f32 {
  let ca = dot(dl, sp.d.xyz);
  if (ca <= 0.02) { return 0.0; }
  let a = dot(dl, sp.r.xyz) / (ca * sp.p.w);
  let b = dot(dl, sp.u.xyz) / (ca * sp.p.w);
  let soft = max(sp.d.w, 0.02);
  var m = 1.0 - smoothstep(1.0 - soft, 1.0, length(vec2f(a, b)));
  let e = 0.02 + 0.2 * sp.d.w;
  let lim = sp.s * (1.0 + 2.0 * e);
  m *= smoothstep(-lim.x - e, -lim.x + e, a) * (1.0 - smoothstep(lim.y - e, lim.y + e, a));
  m *= (1.0 - smoothstep(lim.z - e, lim.z + e, b)) * smoothstep(-lim.w - e, -lim.w + e, b);
  return m;
}

// Irradiance at x from the sun and the light apertures.
fn directIrradiance(x: vec3f, n: vec3f, view: bool) -> vec3f {
  let h = G.domainMin.w;
  let p0 = x + n * (G.rc2.x + 0.25 * h);
  var E = vec3f(0.0);
  if (G.sunIrr.w > 0.5) {
    let s = G.sunDir.xyz;
    let ndl = dot(n, s);
    if (ndl > 0.0) {
      let ap = apertureSun(x + n * 0.002, s);
      if (ap.x > 0.0) {
        E += G.sunIrr.rgb * (ndl * ap.x) * shadowMarch(p0, s, ap.y - 3.0 * h, G.sunDir.w, view);
      }
    }
  }
  let count = i32(G.roomMax.w);
  for (var i = 0; i < count; i++) {
    let sp = G.spots[i];
    let L = sp.p.xyz - x;
    let dist = length(L);
    let l = L / max(dist, 1e-4);
    let ndl = dot(n, l);
    if (ndl <= 0.0) { continue; }
    let m = spotProfile(sp, -l);
    if (m <= 0.0) { continue; }
    let vis = shadowMarch(p0, l, dist - 0.12, 0.035 / max(dist, 0.3), view);
    E += sp.i.rgb * (m * ndl / max(dist * dist, 0.01)) * vis;
  }
  return E;
}
