// 2 x 2 x 2 box downsample of one volume (one mip level per dispatch).
// Bindings: src0 (texture_3d, single mip view), dst0 (storage, next mip).

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(dst0);
  if (any(id >= dims)) { return; }
  let sd = vec3i(textureDimensions(src0));
  var a = vec4f(0.0);
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    a += textureLoad(src0, min(vec3i(id) * 2 + o, sd - vec3i(1)), 0);
  }
  textureStore(dst0, id, a * 0.125);
}
