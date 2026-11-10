// Mean radiance at every cascade 1 probe: the average of its stored directions, premultiplied
// by probe validity. Used for haze and the light meter's ambient reading.
// Bindings: F (probe grid xyz, stored direction resolution), c1Tex, fluOut.

struct FluenceParams { grid: vec4f }

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let grid = vec3u(F.grid.xyz);
  if (any(id >= grid)) { return; }
  let S = u32(F.grid.w);
  var sum = vec4f(0.0);
  for (var ty = 0u; ty < S; ty++) {
    for (var tx = 0u; tx < S; tx++) {
      sum += textureLoad(c1Tex, vec3u(tx * grid.x + id.x, ty * grid.y + id.y, id.z), 0);
    }
  }
  // The stored value is mean radiance per direction; a uniform field of radiance L scatters
  // L * phase integrated over the sphere = L, so no further factor is needed.
  textureStore(fluOut, id, sum / f32(S * S));
}
