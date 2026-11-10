// Voxelises the analytic scene into the GI representation.
// Bindings: G, prims (storage, read), samp, jtB (a = distance to thin emitters),
//           geomOut (r solid distance, g thin-emitter distance, b glass distance),
//           albedoOut (rgb diffuse reflectance), emitOut (rgb emitted radiance),
//           glassOut (rgb transmittance per GLASS_UNIT, a frost).

struct Prim {
  rot:      vec4f,  // quaternion, world -> local
  pos:      vec4f,  // xyz centre, w = type
  size:     vec4f,  // type-specific dimensions, w = edge rounding
  extra:    vec4f,  // type-specific
  albedo:   vec4f,  // rgb diffuse reflectance, w = boolean role (0 new object, 1 carve all, 2 carve this object)
  emission: vec4f,  // rgb emitted radiance, w = 1 for glass
  color2:   vec4f,  // room shell: floor reflectance. glass: absorption per metre, w = frost
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
  let q = vec2f(abs(p.x), p.z);
  var k: f32;
  if (sc.y * q.x > sc.x * q.y) { k = dot(q, sc); } else { k = length(q); }
  let d2 = sqrt(max(dot(q, q) + radius * radius - 2.0 * radius * k, 0.0)) - ht;
  let w = vec2f(d2 + r, abs(p.y) - hh + r);
  return min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0))) - r;
}

// Parallel slats inside a box. Slats repeat along local X and are tilted about Y.
fn sdSlats(p: vec3f, b: vec3f, pitch: f32, ht: f32, tilt: f32, r: f32) -> f32 {
  let n = max(floor((2.0 * b.x) / pitch), 1.0);
  let span = n * pitch;
  let xi = clamp(floor((p.x + 0.5 * span) / pitch), 0.0, n - 1.0);
  let cs = cos(tilt);
  let sn = sin(tilt);
  var d = 1e9;
  // The nearest slat may be a neighbour once the slats are tilted.
  for (var k = -1.0; k <= 1.0; k += 1.0) {
    let xk = clamp(xi + k, 0.0, n - 1.0);
    let lx = p.x - ((xk + 0.5) * pitch - 0.5 * span);
    let q = vec3f(cs * lx + sn * p.z, p.y, -sn * lx + cs * p.z);
    d = min(d, sdBox(q, vec3f(ht, b.y, b.z), r));
  }
  return d;
}

// A panel in the XY plane with a centred grid of round holes through it.
fn sdPerforated(p: vec3f, b: vec3f, pitch: f32, hole: f32, r: f32) -> f32 {
  let box = sdBox(p, b, r);
  let n = max(floor((b.xy - vec2f(hole + 0.25 * pitch)) / pitch), vec2f(0.0));
  let c = clamp(round(p.xy / pitch), -n, n) * pitch;
  let dh = length(p.xy - c) - hole;
  return max(box, -dh);
}

// Biconvex lens on the Z axis: the intersection of two spheres.
fn sdLens(p: vec3f, a: f32, t: f32) -> f32 {
  let s = 0.5 * t;
  let R = (a * a + s * s) / (2.0 * s);
  let c = R - s;
  return max(length(p - vec3f(0.0, 0.0, -c)) - R, length(p - vec3f(0.0, 0.0, c)) - R);
}

// Equilateral triangular prism along Y with side length s.
fn sdPrism(p: vec3f, s: f32, hh: f32) -> f32 {
  let k = sqrt(3.0);
  let r = 0.5 * s;
  var q = vec2f(abs(p.x) - r, p.z + r / k);
  if (q.x + k * q.y > 0.0) { q = vec2f(q.x - k * q.y, -k * q.x - q.y) / 2.0; }
  q.x -= clamp(q.x, -2.0 * r, 0.0);
  let d2 = -length(q) * sign(q.y);
  let w = vec2f(d2, abs(p.y) - hh);
  return min(max(w.x, w.y), 0.0) + length(max(w, vec2f(0.0)));
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
    case 6 { d = sdPerforated(p, pr.size.xyz, pr.extra.x, pr.extra.y, pr.size.w); }
    case 7 { d = sdLens(p, pr.size.x, pr.size.y); }
    case 8 { d = sdPrism(p, pr.size.x, pr.size.y); }
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
  // Solids.
  var d = 1e9;
  var alb = vec3f(0.5);
  var le = vec3f(0.0);
  // Glass.
  var dg = 1e3;
  var gl = vec4f(1.0, 1.0, 1.0, 0.0);
  // The object being assembled.
  var od = 1e9;
  var oa = vec3f(0.5);
  var oe = vec3f(0.0);
  var og = vec4f(0.0);
  var isGlass = false;
  let n = u32(G.counts.x);
  for (var i = 0u; i <= n; i++) {
    var role = 0.0;
    var s = PrimSample(1e9, 0.0);
    if (i < n) {
      role = prims[i].albedo.w;
      s = primDistance(prims[i], p);
    }
    if (role < 1.5) {
      // Close the object assembled so far.
      if (isGlass) {
        if (od < dg) { dg = od; gl = og; }
      } else if (od < d) {
        d = od; alb = oa; le = oe;
      }
      od = 1e9;
      isGlass = false;
    }
    if (i == n) { break; }
    let pr = prims[i];
    if (role < 0.5) {
      od = s.d;
      oa = pr.albedo.rgb;
      if (s.face > 1.5) { oa = pr.color3.rgb; } else if (s.face > 0.5) { oa = pr.color2.rgb; }
      oe = pr.emission.rgb;
      isGlass = pr.emission.w > 0.5;
      og = vec4f(exp(-pr.color2.rgb * GLASS_UNIT), pr.color2.w);
    } else if (role < 1.5) {
      d = max(d, -s.d);
    } else {
      od = max(od, -s.d);
    }
  }
  let uvw = (vec3f(id) + vec3f(0.5)) / vec3f(dims);
  let dThin = textureSampleLevel(jtB, samp, uvw, 0.0).a - 0.5 * G.gridVox.w;
  textureStore(geomOut, id, vec4f(d, dThin, dg, 0.0));
  textureStore(albedoOut, id, vec4f(alb, 1.0));
  textureStore(emitOut, id, vec4f(le, 1.0));
  textureStore(glassOut, id, gl);
}
