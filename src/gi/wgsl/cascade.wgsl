// One radiance cascade: traces its radiance interval for every probe direction and merges
// the result with the cascade above (already merged), top-down.
//
// Storage layout (every cascade): S x S direction tiles, each tile holds the probe grid in
// (x, y), texture depth is probe z. Cascades above 0 store the average of the 2 x 2 child
// directions of each stored texel ("pre-averaging"), which is exactly what the cascade below
// reads when it merges. Values are premultiplied by probe validity (alpha).
//
// Bindings: G, C (CascadeParams), samp, geomTex, radTex, jTex/jtA/jtB, upperTex, outTex.

struct CascadeParams {
  grid:     vec4f,  // xyz probe grid dimensions, w = probe spacing
  tiles:    vec4f,  // x = stored direction resolution S, y = traced resolution R, z = rays per axis (1 or 2), w = level
  interval: vec4f,  // x = tA, y = tB, z = tan(half angle) of a traced ray, w = 1 if top cascade
  upper:    vec4f,  // xyz probe grid of the cascade above, w = its stored direction resolution
  misc:     vec4f,  // x = max march steps
}

// Visibility-aware merge. The eight probes of the cascade above that surround p are combined
// with trilinear weights, skipping probes buried in geometry. Each of them continues this
// ray from its own position, i.e. from tB + a along this ray, where a is the probe's offset
// projected on the ray. A surface this ray met before that point hides the probe's
// contribution, so nothing falls into the gap between the two intervals.
fn mergeUpper(p: vec3f, w: vec3f, dir: vec2u, hit: Hit) -> vec3f {
  let gu = vec3i(C.upper.xyz);
  let spacing = C.grid.w * 2.0;
  let pu = (p - G.domainMin.xyz) / spacing - vec3f(0.5);
  let b = floor(pu);
  let f = pu - b;
  let bi = vec3i(b);
  let tB = C.interval.y;
  var acc = vec3f(0.0);
  var wsum = 0.0;
  for (var i = 0; i < 8; i++) {
    let o = vec3i(i & 1, (i >> 1) & 1, (i >> 2) & 1);
    let idx = clamp(bi + o, vec3i(0), gu - vec3i(1));
    let fo = vec3f(o);
    let wv = mix(vec3f(1.0) - f, f, fo);
    let wgt = wv.x * wv.y * wv.z;
    if (wgt <= 0.0) { continue; }
    let texel = textureLoad(upperTex, vec3i(i32(dir.x) * gu.x + idx.x, i32(dir.y) * gu.y + idx.y, idx.z), 0);
    if (texel.a < 0.5) { continue; }
    let U = G.domainMin.xyz + (vec3f(idx) + vec3f(0.5)) * spacing;
    // Cascade 0 sits next to surfaces: drop upper probes hidden behind a thin wall.
    if (C.tiles.w < 0.5 && (sdfAt(mix(p, U, 0.33)) < 0.0 || sdfAt(mix(p, U, 0.67)) < 0.0)) { continue; }
    let a = dot(U - p, w);
    if (hit.tHit <= tB + max(a, 0.0)) { acc += wgt * hit.LHit; } else { acc += wgt * texel.rgb; }
    wsum += wgt;
  }
  if (wsum <= 0.0) {
    if (hit.tHit < NO_HIT) { return hit.J + (1.0 - hit.cov) * hit.LHit; }
    return hit.J;
  }
  return hit.J + (1.0 - hit.cov) * acc / wsum;
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let grid = vec3u(C.grid.xyz);
  let S = u32(C.tiles.x);
  if (id.x >= grid.x * S || id.y >= grid.y * S || id.z >= grid.z) { return; }
  let tile = vec2u(id.x / grid.x, id.y / grid.y);
  let probe = vec3u(id.x % grid.x, id.y % grid.y, id.z);
  let p = G.domainMin.xyz + (vec3f(probe) + vec3f(0.5)) * C.grid.w;

  // Probes buried in solid geometry carry no information. Cascade 0 is only ever read next
  // to surfaces (final gather and radiance cache), so its probes in open space are skipped;
  // higher cascades stay dense for volumetric queries.
  let dp = sdfAt(p);
  if (dp < -0.25 * G.domainMin.w || (C.tiles.w < 0.5 && dp > 2.5 * C.grid.w)) {
    textureStore(outTex, id, vec4f(0.0));
    return;
  }

  let sub = u32(C.tiles.z);
  let R = C.tiles.y;
  let isTop = C.interval.w > 0.5;
  let steps = i32(C.misc.x);
  var acc = vec3f(0.0);
  for (var sy = 0u; sy < sub; sy++) {
    for (var sx = 0u; sx < sub; sx++) {
      let di = tile * sub + vec2u(sx, sy);
      let w = squareToSphere((vec2f(di) + vec2f(0.5)) / R);
      if (isTop) {
        let hit = marchCone(p, w, C.interval.x, C.interval.y, 0.0, C.interval.z, 1e6, steps);
        acc += hit.J;
        if (hit.tHit < NO_HIT) { acc += (1.0 - hit.cov) * hit.LHit; }
      } else {
        // Largest along-ray offset of a surrounding upper probe.
        let ext = C.grid.w * (abs(w.x) + abs(w.y) + abs(w.z));
        let hit = marchCone(p, w, C.interval.x, C.interval.y, ext, C.interval.z, 1e6, steps);
        acc += mergeUpper(p, w, di, hit);
      }
    }
  }
  acc /= f32(sub * sub);
  textureStore(outTex, id, vec4f(acc, 1.0));
}
