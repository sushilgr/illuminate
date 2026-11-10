// Splats thin (line-like) emitters into an emission density volume.
// Bindings: G, segs (storage, read), jOut, jaOut, jbOut (mip 0 of the density / anisotropy textures).
// jbOut.a additionally stores the distance to the nearest density kernel, used to skip empty space.
//
// A segment carries I = radiant intensity per unit length for an isotropic emitter
// (radiance x projected width averaged over the sphere). The density integrates to I over
// any cross-section, so a cone of any width receives the correct mean radiance.
// The anisotropy tensor T makes the emission 2 * sqrt(w^T T w): T = n n^T for a flat
// two-sided ribbon with face normal n, T = identity / 4 for a round tube.

struct Seg {
  a: vec4f,   // xyz start, w = kernel radius
  b: vec4f,   // xyz end, w = anisotropy (1 = flat ribbon, 0 = tube)
  I: vec4f,   // rgb intensity per unit length
  n: vec4f,   // xyz ribbon face normal
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = textureDimensions(jOut);
  if (any(id >= dims)) { return; }
  let hJ = G.gridVox.w;
  let p = G.domainMin.xyz + (vec3f(id) + vec3f(0.5)) * hJ;
  var j = vec3f(0.0);
  var ta = vec4f(0.0);
  var tb = vec3f(0.0);
  var dThin = 1e3;
  let n = u32(G.counts.y);
  for (var i = 0u; i < n; i++) {
    let s = segs[i];
    let ab = s.b.xyz - s.a.xyz;
    let l2 = max(dot(ab, ab), 1e-8);
    let u = dot(p - s.a.xyz, ab) / l2;
    // Segments are finite cylinders of density; consecutive segments of a polyline abut.
    let uc = clamp(u, 0.0, 1.0);
    let c = s.a.xyz + ab * uc;
    let dist = length(p - c);
    let R = s.a.w;
    dThin = min(dThin, dist - R);
    if (dist >= R || u < 0.0 || u >= 1.0) { continue; }
    let q = 1.0 - (dist * dist) / (R * R);
    let k = (2.0 / (PI * R * R)) * q;
    let e = s.I.rgb * k;
    let wgt = luminance(e) + 1e-6;
    j += e;
    let nn = s.n.xyz;
    let an = s.b.w;
    let dg = an * nn * nn + (1.0 - an) * vec3f(0.25);
    let od = an * vec3f(nn.x * nn.y, nn.x * nn.z, nn.y * nn.z);
    ta += vec4f(dg, 1.0) * wgt;
    tb += od * wgt;
  }
  textureStore(jOut, id, vec4f(j, 1.0));
  textureStore(jaOut, id, ta);
  textureStore(jbOut, id, vec4f(tb, dThin));
}
