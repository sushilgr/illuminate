// Reconstruction of the photon buffer: a separable 7-tap filter that does not cross depth or
// normal discontinuities. Two entry points; the first reads the integer buffer.
// Bindings (H): CAM (size.xy, size.w = fixed-point scale), photons (storage, read), gNormal, gDepth, tmpOut.
// Bindings (V): CAM, tmpTex, gNormal, gDepth, causticOut.

struct BlurParams { size: vec4f }

fn tap(k: i32) -> f32 {
  var w = array<f32, 4>(0.30, 0.22, 0.10, 0.03);
  return w[abs(k)];
}

fn edgeWeight(px: vec2i, q: vec2i, n0: vec3f, d0: f32) -> f32 {
  let d = textureLoad(gDepth, q, 0);
  if (d >= 1.0) { return 0.0; }
  let n = textureLoad(gNormal, q, 0).xyz;
  let wn = pow(max(dot(normalize(n), n0), 0.0), 8.0);
  let wd = exp(-abs(d - d0) / max(1e-5, (1.0 - d0) * 0.08));
  return wn * wd;
}
