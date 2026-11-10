// 2 x 2 x 2 box downsample of the three thin-emitter volumes (one mip level per dispatch).
// Bindings: src0..2 (texture_3d, single mip view), dst0..2 (storage, next mip).

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(dst0);
  if (any(id >= dims)) { return; }
  let sd = vec3i(textureDimensions(src0));
  var a = vec4f(0.0);
  var b = vec4f(0.0);
  var c = vec4f(0.0);
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    let q = min(vec3i(id) * 2 + o, sd - vec3i(1));
    a += textureLoad(src0, q, 0);
    b += textureLoad(src1, q, 0);
    c += textureLoad(src2, q, 0);
  }
  textureStore(dst0, id, a * 0.125);
  textureStore(dst1, id, b * 0.125);
  textureStore(dst2, id, c * 0.125);
}
