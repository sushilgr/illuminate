@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2u(B.size.xy);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let px = vec2i(id.xy);
  let d0 = textureLoad(gDepth, px, 0);
  if (d0 >= 1.0) { textureStore(tmpOut, px, vec4f(0.0)); return; }
  let n0 = normalize(textureLoad(gNormal, px, 0).xyz);
  var sum = vec3f(0.0);
  var ws = 0.0;
  for (var k = -3; k <= 3; k++) {
    let q = vec2i(clamp(px.x + k, 0, i32(size.x) - 1), px.y);
    let w = tap(k) * edgeWeight(px, q, n0, d0);
    let i = (u32(q.y) * size.x + u32(q.x)) * 3u;
    sum += w * vec3f(f32(photons[i]), f32(photons[i + 1u]), f32(photons[i + 2u]));
    ws += w;
  }
  textureStore(tmpOut, px, vec4f(sum / max(ws, 1e-4) / B.size.w, 1.0));
}
