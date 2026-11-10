// One radiance cascade: traces its radiance interval for every probe direction and merges
// the result with the cascade above (already merged), top-down.
//
// Storage layout (every cascade): S x S direction tiles, each tile holds the probe grid in
// (x, y), texture depth is probe z. Hardware trilinear filtering inside one tile therefore
// interpolates between probes for a fixed direction.
// Cascades above 0 store the average of the 2 x 2 child directions of each stored texel
// ("pre-averaging"), which is exactly what the cascade below reads when it merges.
// Values are premultiplied by probe validity (alpha), so filtering skips probes inside solids.
//
// Bindings: G, C (CascadeParams), samp, geomTex, radTex, jTex/jtA/jtB, upperTex, outTex.

struct CascadeParams {
  grid:     vec4f,  // xyz probe grid dimensions, w = probe spacing
  tiles:    vec4f,  // x = stored direction resolution S, y = traced resolution R, z = rays per axis (1 or 2), w = level
  interval: vec4f,  // x = tA, y = tB, z = tan(half angle) of a traced ray, w = 1 if top cascade
  upper:    vec4f,  // xyz probe grid of the cascade above, w = its stored direction resolution
  misc:     vec4f,  // x = max march steps
}

fn upperSample(p: vec3f, dir: vec2u) -> vec4f {
  let g = C.upper.xyz;
  let s = C.upper.w;
  let spacing = C.grid.w * 2.0;
  let pu = (p - G.domainMin.xyz) / spacing;
  let q = clamp(pu, vec3f(0.5), g - vec3f(0.5));
  let uvw = vec3f((f32(dir.x) * g.x + q.x) / (s * g.x), (f32(dir.y) * g.y + q.y) / (s * g.y), q.z / g.z);
  return textureSampleLevel(upperTex, samp, uvw, 0.0);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let grid = vec3u(C.grid.xyz);
  let S = u32(C.tiles.x);
  if (id.x >= grid.x * S || id.y >= grid.y * S || id.z >= grid.z) { return; }
  let tile = vec2u(id.x / grid.x, id.y / grid.y);
  let probe = vec3u(id.x % grid.x, id.y % grid.y, id.z);
  let p = G.domainMin.xyz + (vec3f(probe) + vec3f(0.5)) * C.grid.w;

  // Probes buried in solid geometry carry no information.
  let dp = sdfAt(p);
  if (dp < -0.25 * G.domainMin.w) {
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
      let hit = marchCone(p, w, C.interval.x, C.interval.y, C.interval.z, 1e6, steps);
      var L = hit.J;
      if (hit.beta > 0.004 && !isTop) {
        let f = upperSample(p, di);
        if (f.a > 1e-3) { L += hit.beta * f.rgb / f.a; }
      }
      acc += L;
    }
  }
  acc /= f32(sub * sub);
  textureStore(outTex, id, vec4f(acc, 1.0));
}
