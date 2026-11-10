// Light scattered by frosted glass sheets under a direct beam, written as an isotropic
// emission density (radiance per metre) that the cone march integrates like a thin emitter.
// A sheet that receives E on one side and scatters the fraction f of it re-emits f * E in
// all directions: density = f * E / (4 pi) spread across the sheet with a unit-area kernel.
// Bindings: scene and direct-light bindings, S (Sheets), glowOut.

struct Sheet {
  c: vec4f,   // xyz centre, w = half width
  u: vec4f,   // xyz unit axis along the width, w = half height
  v: vec4f,   // xyz unit axis along the height, w = half thickness
  t: vec4f,   // rgb transmittance of the sheet, a = frost
}
struct Sheets { count: vec4f, items: array<Sheet, 4> }

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(glowOut);
  if (any(id >= dims)) { return; }
  let hJ = G.gridVox.w;
  let p = G.domainMin.xyz + (vec3f(id) + vec3f(0.5)) * hJ;
  var j = vec3f(0.0);
  let n = i32(S.count.x);
  for (var i = 0; i < n; i++) {
    let sh = S.items[i];
    let rel = p - sh.c.xyz;
    let nrm = cross(sh.u.xyz, sh.v.xyz);
    let dz = dot(rel, nrm);
    let w = max(sh.v.w, 1.2 * hJ);
    if (abs(dz) >= w) { continue; }
    let a = dot(rel, sh.u.xyz);
    let b = dot(rel, sh.v.xyz);
    if (abs(a) > sh.c.w || abs(b) > sh.u.w) { continue; }
    let kernel = (1.0 - abs(dz) / w) / w;
    // The point on the sheet's mid-plane, and the light arriving there from either side.
    let q = p - nrm * dz;
    let frost = frostAt(q, sh.t.a);
    if (frost <= 0.0) { continue; }
    var E = vec3f(0.0);
    let off = sh.v.w + 1.5 * G.domainMin.w;
    if (G.sunIrr.w > 0.5) {
      let s = G.sunDir.xyz;
      let side = sign(dot(nrm, s));
      let ap = apertureSun(q, s);
      if (ap.x > 0.0) {
        E += G.sunIrr.rgb * (abs(dot(nrm, s)) * ap.x) * shadowMarch(q + nrm * (side * off), s, ap.y - 3.0 * G.domainMin.w, G.sunDir.w, false);
      }
    }
    let spots = i32(G.roomMax.w);
    for (var k = 0; k < spots; k++) {
      let sp = G.spots[k];
      let L = sp.p.xyz - q;
      let dist = length(L);
      let l = L / max(dist, 1e-4);
      let m = spotProfile(sp, -l);
      if (m <= 0.0) { continue; }
      let side = sign(dot(nrm, l));
      E += sp.i.rgb * (m * abs(dot(nrm, l)) / max(dist * dist, 0.01)) * shadowMarch(q + nrm * (side * off), l, dist - 0.12, 0.035 / max(dist, 0.3), false);
    }
    j += E * sh.t.rgb * (frost * kernel / (4.0 * PI));
  }
  textureStore(glowOut, id, vec4f(j, 1.0));
}
