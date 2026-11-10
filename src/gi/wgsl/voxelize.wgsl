// Voxelises the analytic scene into the GI representation.
// Bindings: G, prims (storage, read), geomOut (rgb albedo, a signed distance), emitOut (rgb emitted radiance).

struct Prim {
  rot:      vec4f,  // quaternion, world -> local
  pos:      vec4f,  // xyz centre, w = type
  size:     vec4f,  // type-specific dimensions, w = edge rounding
  extra:    vec4f,  // type-specific
  albedo:   vec4f,  // rgb diffuse reflectance, w = boolean op (0 union, 1 subtract)
  emission: vec4f,  // rgb emitted radiance
  color2:   vec4f,  // room shell: floor reflectance
  color3:   vec4f,  // room shell: ceiling reflectance
}

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

fn sdBox(p: vec3f, b: vec3f, r: f32) -> f32 {
  let q = abs(p) - b + vec3f(r);
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

fn sdCylinder(p: vec3f, rad: f32, hh: f32, r: f32) -> f32 {
  let d = vec2f(length(p.xz) - rad + r, abs(p.y) - hh + r);
  return min(max(d.x, d.y), 0.0) + length(max(d, vec2f(0.0))) - r;
}

// Annular sector in the XZ plane (opening towards +Z), extruded along Y, with round ends.
fn sdArcWall(p: vec3f, radius: f32, hh: f32, ht: f32, halfAngle: f32, r: f32) -> f32 {
  let sc = vec2f(sin(halfAngle), cos(halfAngle));
  var q = vec2f(abs(p.x), p.z);
  var k: f32;
  if (sc.y * q.x > sc.x * q.y) { k = dot(q, sc); } else { k = length(q); }
  let d2 = sqrt(max(dot(q, q) + radius * radius - 2.0 * radius * k, 0.0)) - ht;
  let w = vec2f(d2 + r, abs(p.y) - hh + r);
  return min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0))) - r;
}

// A row of parallel slats inside a box. Slats repeat along local X and are tilted about Y... see louvers.
fn sdSlats(p: vec3f, b: vec3f, pitch: f32, ht: f32, tilt: f32, r: f32) -> f32 {
  let n = max(floor((2.0 * b.x) / pitch), 1.0);
  let span = n * pitch;
  let xi = clamp(floor((p.x + 0.5 * span) / pitch), 0.0, n - 1.0);
  let cx = (xi + 0.5) * pitch - 0.5 * span;
  let lx = p.x - cx;
  let cs = cos(tilt);
  let sn = sin(tilt);
  let q = vec3f(cs * lx + sn * p.z, p.y, -sn * lx + cs * p.z);
  return sdBox(q, vec3f(ht, b.y, b.z), r);
}

struct PrimSample { d: f32, face: f32 }

fn primDistance(pr: Prim, pw: vec3f) -> PrimSample {
  let p = qrot(pr.rot, pw - pr.pos.xyz);
  let ty = i32(pr.pos.w + 0.5);
  var d = 1e9;
  var face = 0.0;
  switch ty {
    case 0 {
      // Room shell: everything outside the interior box is solid.
      d = -sdBox(p, pr.size.xyz, 0.0);
      let q = abs(p) / pr.size.xyz;
      if (q.y >= q.x && q.y >= q.z) { face = select(2.0, 1.0, p.y < 0.0); }
    }
    case 1 { d = sdBox(p, pr.size.xyz, pr.size.w); }
    case 2 { d = sdCylinder(p, pr.size.x, pr.size.y, pr.size.w); }
    case 3 { d = length(p) - pr.size.x; }
    case 4 { d = sdArcWall(p, pr.size.x, pr.size.y, pr.size.z, pr.extra.x, pr.size.w); }
    case 5 { d = sdSlats(p, pr.size.xyz, pr.extra.x, pr.extra.y, pr.extra.z, pr.size.w); }
    default { }
  }
  return PrimSample(d, face);
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dims = vec3u(G.gridVox.xyz);
  if (any(id >= dims)) { return; }
  let h = G.domainMin.w;
  let p = G.domainMin.xyz + (vec3f(id) + vec3f(0.5)) * h;
  var d = 1e9;
  var alb = vec3f(0.5);
  var le = vec3f(0.0);
  let n = u32(G.counts.x);
  for (var i = 0u; i < n; i++) {
    let pr = prims[i];
    let s = primDistance(pr, p);
    if (pr.albedo.w < 0.5) {
      if (s.d < d) {
        d = s.d;
        alb = pr.albedo.rgb;
        if (s.face > 1.5) { alb = pr.color3.rgb; } else if (s.face > 0.5) { alb = pr.color2.rgb; }
        le = pr.emission.rgb;
      }
    } else {
      // Subtraction keeps the material of whatever is being carved.
      d = max(d, -s.d);
    }
  }
  textureStore(geomOut, id, vec4f(alb, d));
  textureStore(emitOut, id, vec4f(le, 1.0));
}
