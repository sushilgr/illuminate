// Sun caustics by light-space refracted-ray splatting.
//
// For every glass object a regular grid of photons leaves a square facing the sun. Each
// photon is refracted through the object's analytic shape (two interfaces), followed
// through the distance field to the first solid surface, projected into the camera and,
// if that surface is the one visible in its pixel, added to that pixel's irradiance.
// Accumulation uses integer atomics with stochastic rounding, so the total is unbiased.
//
// Bindings: scene and direct-light bindings, CAM (CausticCamera), OBJ (CausticObjects),
//           gNormal, gDepth, photons (atomic storage, 3 values per pixel).

struct CausticCamera {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  camPos: vec4f,   // xyz, w = 1 for orthographic
  size: vec4f,     // x, y render size, z = photons per axis, w = fixed-point scale
  forward: vec4f,  // xyz view direction, w = solid angle of a pixel at the image centre (or pixel area for orthographic)
}

struct GlassObj {
  pos: vec4f,     // xyz centre, w = shape (0 slab, 1 lens, 2 prism, 3 rod)
  rot: vec4f,     // quaternion, local -> world
  size: vec4f,    // slab: half extents. lens: radius, centre thickness. prism: side, half length. rod: radius, half length
  optic: vec4f,   // x = ior, y = frost, z = dispersion, w = bounding radius
  sigma: vec4f,   // rgb absorption per metre, w = 1 if this object carries the etch mask
  flute: vec4f,   // x = depth, y = spacing
}
struct CausticObjects { count: vec4f, items: array<GlassObj, 4> }

fn qmul(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}
fn qinv(q: vec4f) -> vec4f { return vec4f(-q.xyz, q.w); }

fn hash3(a: u32, b: u32, c: u32) -> f32 {
  var h = a * 747796405u + b * 2891336453u + c * 277803737u + 1u;
  h = (h ^ (h >> 16u)) * 2246822519u;
  h = (h ^ (h >> 13u)) * 3266489917u;
  h = h ^ (h >> 16u);
  return f32(h & 0xffffffu) / 16777216.0;
}

struct Span { t0: f32, t1: f32, n0: vec3f, n1: vec3f }

// Entry and exit of a ray with a box.
fn spanBox(o: vec3f, d: vec3f, b: vec3f) -> Span {
  let inv = 1.0 / select(d, vec3f(1e-6), abs(d) < vec3f(1e-6));
  let ta = (-b - o) * inv;
  let tb = (b - o) * inv;
  let tmin = min(ta, tb);
  let tmax = max(ta, tb);
  let t0 = max(tmin.x, max(tmin.y, tmin.z));
  let t1 = min(tmax.x, min(tmax.y, tmax.z));
  var n0 = vec3f(0.0);
  var n1 = vec3f(0.0);
  if (tmin.x >= tmin.y && tmin.x >= tmin.z) { n0.x = -sign(d.x); } else if (tmin.y >= tmin.z) { n0.y = -sign(d.y); } else { n0.z = -sign(d.z); }
  if (tmax.x <= tmax.y && tmax.x <= tmax.z) { n1.x = sign(d.x); } else if (tmax.y <= tmax.z) { n1.y = sign(d.y); } else { n1.z = sign(d.z); }
  return Span(t0, t1, n0, n1);
}

// Ray with a sphere: both roots.
fn sphereRoots(o: vec3f, d: vec3f, c: vec3f, R: f32) -> vec2f {
  let oc = o - c;
  let b = dot(oc, d);
  let disc = b * b - (dot(oc, oc) - R * R);
  if (disc < 0.0) { return vec2f(1e9, -1e9); }
  let s = sqrt(disc);
  return vec2f(-b - s, -b + s);
}

// Biconvex lens on the Z axis: the intersection of two spheres.
fn spanLens(o: vec3f, d: vec3f, a: f32, t: f32) -> Span {
  let s = 0.5 * t;
  let R = (a * a + s * s) / (2.0 * s);
  let c1 = vec3f(0.0, 0.0, -(R - s));
  let c2 = vec3f(0.0, 0.0, R - s);
  let r1 = sphereRoots(o, d, c1, R);
  let r2 = sphereRoots(o, d, c2, R);
  let t0 = max(r1.x, r2.x);
  let t1 = min(r1.y, r2.y);
  let n0 = normalize(o + d * t0 - select(c2, c1, r1.x > r2.x));
  let n1 = normalize(o + d * t1 - select(c2, c1, r1.y < r2.y));
  return Span(t0, t1, n0, n1);
}

// Finite cylinder along Y.
fn spanRod(o: vec3f, d: vec3f, R: f32, hh: f32) -> Span {
  let a = dot(d.xz, d.xz);
  var t0 = -1e9;
  var t1 = 1e9;
  var n0 = vec3f(0.0);
  var n1 = vec3f(0.0);
  if (a > 1e-8) {
    let b = dot(o.xz, d.xz);
    let disc = b * b - a * (dot(o.xz, o.xz) - R * R);
    if (disc < 0.0) { return Span(1e9, -1e9, n0, n1); }
    let s = sqrt(disc);
    t0 = (-b - s) / a;
    t1 = (-b + s) / a;
    let p0 = o + d * t0;
    let p1 = o + d * t1;
    n0 = vec3f(p0.x, 0.0, p0.z) / R;
    n1 = vec3f(p1.x, 0.0, p1.z) / R;
  } else if (dot(o.xz, o.xz) > R * R) {
    return Span(1e9, -1e9, n0, n1);
  }
  if (abs(d.y) > 1e-6) {
    let ya = (-hh - o.y) / d.y;
    let yb = (hh - o.y) / d.y;
    let ymin = min(ya, yb);
    let ymax = max(ya, yb);
    if (ymin > t0) { t0 = ymin; n0 = vec3f(0.0, -sign(d.y), 0.0); }
    if (ymax < t1) { t1 = ymax; n1 = vec3f(0.0, sign(d.y), 0.0); }
  } else if (abs(o.y) > hh) {
    return Span(1e9, -1e9, n0, n1);
  }
  return Span(t0, t1, n0, n1);
}

// Equilateral triangular prism along Y: five half-spaces.
fn spanPrism(o: vec3f, d: vec3f, s: f32, hh: f32) -> Span {
  let k = sqrt(3.0);
  let ri = s / (2.0 * k);   // inradius
  var t0 = -1e9;
  var t1 = 1e9;
  var n0 = vec3f(0.0);
  var n1 = vec3f(0.0);
  for (var i = 0; i < 5; i++) {
    var n: vec3f;
    var off: f32;
    if (i == 0) { n = vec3f(0.0, 0.0, -1.0); off = ri; }
    else if (i == 1) { n = vec3f(0.5 * k, 0.0, 0.5); off = ri; }
    else if (i == 2) { n = vec3f(-0.5 * k, 0.0, 0.5); off = ri; }
    else if (i == 3) { n = vec3f(0.0, 1.0, 0.0); off = hh; }
    else { n = vec3f(0.0, -1.0, 0.0); off = hh; }
    let dn = dot(d, n);
    let dist = off - dot(o, n);
    if (abs(dn) < 1e-7) {
      if (dist < 0.0) { return Span(1e9, -1e9, n0, n1); }
      continue;
    }
    let t = dist / dn;
    if (dn < 0.0) { if (t > t0) { t0 = t; n0 = n; } }
    else { if (t < t1) { t1 = t; n1 = n; } }
  }
  return Span(t0, t1, n0, n1);
}

// Unpolarised Fresnel reflectance.
fn fresnel(cosI: f32, eta: f32) -> f32 {
  let s2 = eta * eta * (1.0 - cosI * cosI);
  if (s2 >= 1.0) { return 1.0; }
  let cosT = sqrt(1.0 - s2);
  let rs = (eta * cosI - cosT) / (eta * cosI + cosT);
  let rp = (cosI - eta * cosT) / (cosI + eta * cosT);
  return 0.5 * (rs * rs + rp * rp);
}

@compute @workgroup_size(8, 8, 1)
fn trace(@builtin(global_invocation_id) id: vec3u) {
  let N = u32(CAM.size.z);
  let count = u32(OBJ.count.x);
  if (id.x >= N || id.y >= N || id.z >= count) { return; }
  let ob = OBJ.items[id.z];
  let s = G.sunDir.xyz;
  // A square facing the sun that covers the object's bounding sphere.
  let R = ob.optic.w;
  var ta = normalize(cross(s, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(s.y) > 0.9)));
  let tb = cross(s, ta);
  let cell = 2.0 * R / f32(N);
  let uv = (vec2f(id.xy) + vec2f(0.5)) * cell - vec2f(R);
  let origin = ob.pos.xyz + ta * uv.x + tb * uv.y + s * (R + 0.05);
  let dir = -s;

  // Into the object's frame.
  let qi = qinv(ob.rot);
  let o = qmul(qi, origin - ob.pos.xyz);
  let d = qmul(qi, dir);
  let shape = i32(ob.pos.w + 0.5);
  var sp: Span;
  if (shape == 0) { sp = spanBox(o, d, ob.size.xyz); }
  else if (shape == 1) { sp = spanLens(o, d, ob.size.x, ob.size.y); }
  else if (shape == 2) { sp = spanPrism(o, d, ob.size.x, ob.size.y); }
  else { sp = spanRod(o, d, ob.size.x, ob.size.y); }
  if (sp.t1 <= sp.t0 || sp.t1 <= 0.0) { return; }

  let pin = o + d * sp.t0;
  var n0 = sp.n0;
  // Fluting: parallel cylindrical grooves along Y on the +Z face of a slab.
  if (shape == 0 && ob.flute.x > 0.0 && n0.z > 0.5) {
    let ph = 2.0 * PI * pin.x / ob.flute.y;
    n0 = normalize(vec3f(ob.flute.x * PI / ob.flute.y * sin(ph), 0.0, 1.0));
  }
  // Dispersion: one colour channel per photon with its own index of refraction.
  let ch = (id.x + id.y * 2u) % 3u;
  var ior = ob.optic.x;
  var chan = vec3f(1.0);
  if (ob.optic.z > 0.0) {
    ior += (f32(ch) - 1.0) * 0.02 * ob.optic.z;
    chan = vec3f(0.0);
    chan[ch] = 3.0;
  }
  let cos0 = -dot(d, n0);
  if (cos0 <= 0.0) { return; }
  let f0 = fresnel(cos0, 1.0 / ior);
  let d1 = refract(d, n0, 1.0 / ior);
  if (dot(d1, d1) < 0.5) { return; }
  // Exit: continue inside the shape from the entry point.
  let o1 = pin + d1 * 1e-4;
  var sp1: Span;
  if (shape == 0) { sp1 = spanBox(o1, d1, ob.size.xyz); }
  else if (shape == 1) { sp1 = spanLens(o1, d1, ob.size.x, ob.size.y); }
  else if (shape == 2) { sp1 = spanPrism(o1, d1, ob.size.x, ob.size.y); }
  else { sp1 = spanRod(o1, d1, ob.size.x, ob.size.y); }
  let len = max(sp1.t1, 0.0);
  let pout = o1 + d1 * len;
  var n1 = sp1.n1;
  if (shape == 0 && ob.flute.x > 0.0 && n1.z > 0.5) {
    let ph = 2.0 * PI * pout.x / ob.flute.y;
    n1 = normalize(vec3f(ob.flute.x * PI / ob.flute.y * sin(ph), 0.0, 1.0));
  }
  let cos1 = dot(d1, n1);
  if (cos1 <= 0.0) { return; }
  let f1 = fresnel(cos1, ior);
  var d2 = refract(d1, -n1, ior);
  if (dot(d2, d2) < 0.5) { return; }   // total internal reflection

  // Frost: the scattered share leaves the caustic (it becomes the sheet's glow), and what
  // remains is spread over a narrow lobe that widens with the frost.
  let pw = ob.pos.xyz + qmul(ob.rot, pout);
  var frost = ob.optic.y;
  if (ob.sigma.w > 0.5) { frost = frostAt(pw, frost); }
  // Heavy frost scatters everything: no caustic at all, which also keeps the splats free of speckle.
  if (frost > 0.6) { return; }
  let sharp = 1.0 - frost / 0.6;
  if (frost > 0.0) {
    let h1 = hash3(id.x, id.y, id.z * 2u + 7u);
    let h2 = hash3(id.y, id.x, id.z * 2u + 13u);
    let rr = 0.18 * frost * sqrt(h1);
    let ang = 2.0 * PI * h2;
    let ua = normalize(cross(d2, select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(d2.y) > 0.9)));
    let ub = cross(d2, ua);
    d2 = normalize(d2 + (ua * cos(ang) + ub * sin(ang)) * rr);
  }
  let wdir = qmul(ob.rot, d2);

  // The sun must reach the entry point.
  let pe = ob.pos.xyz + qmul(ob.rot, pin);
  let ap = apertureSun(pe, s);
  if (ap.x <= 0.0) { return; }
  let lit = shadowMarch(pe + s * (2.0 * G.domainMin.w), s, ap.y - 3.0 * G.domainMin.w, G.sunDir.w, false);
  var flux = G.sunIrr.rgb * lit * (ap.x * cell * cell * (1.0 - f0) * (1.0 - f1) * sharp);
  flux *= exp(-ob.sigma.rgb * len) * chan;
  if (flux.r + flux.g + flux.b <= 0.0) { return; }

  // Follow the photon to the first solid surface.
  let h = G.domainMin.w;
  var t = 2.0 * h;
  var hitFound = false;
  for (var i = 0; i < 72; i++) {
    let p = pw + wdir * t;
    let u = worldToUvw(p);
    if (any(u < vec3f(0.0)) || any(u > vec3f(1.0))) { break; }
    let dd = textureSampleLevel(geomTex, samp, u, 0.0).r;
    if (dd < 0.3 * h) {
      // Refine on to the surface.
      t += dd;
      hitFound = true;
      break;
    }
    t += max(dd, 0.3 * h);
  }
  if (!hitFound) { return; }
  let xh = pw + wdir * t;

  // Receiver visibility: the hit must be the surface the camera sees in that pixel.
  let clip = CAM.viewProj * vec4f(xh, 1.0);
  if (clip.w <= 0.0) { return; }
  let ndc = clip.xyz / clip.w;
  if (abs(ndc.x) >= 1.0 || abs(ndc.y) >= 1.0) { return; }
  let fpx = vec2f((ndc.x * 0.5 + 0.5) * CAM.size.x, (0.5 - ndc.y * 0.5) * CAM.size.y);
  let px = vec2i(fpx);
  let depth = textureLoad(gDepth, px, 0);
  if (depth >= 1.0) { return; }
  let wp = CAM.invViewProj * vec4f(ndc.xy, depth, 1.0);
  let xg = wp.xyz / wp.w;
  if (distance(xg, xh) > 3.0 * h) { return; }
  let ng = normalize(textureLoad(gNormal, px, 0).xyz);
  let cosL = max(dot(ng, -wdir), 0.0);
  if (cosL <= 0.0) { return; }

  // Irradiance = flux / receiver area of the pixel.
  var area: f32;
  if (CAM.camPos.w > 0.5) {
    area = CAM.forward.w / max(abs(dot(ng, CAM.forward.xyz)), 0.05);
  } else {
    let v = xg - CAM.camPos.xyz;
    let dist2 = dot(v, v);
    let cosV = max(abs(dot(ng, v)) / sqrt(dist2), 0.05);
    let cosC = dot(v, CAM.forward.xyz) / sqrt(dist2);
    area = CAM.forward.w * dist2 * cosC * cosC * cosC / cosV;
  }
  // Irradiance is flux per receiver area; the pixel sees `area` of the receiver.
  let e = flux / area * CAM.size.w;
  let idx = u32(px.y) * u32(CAM.size.x) + u32(px.x);
  for (var c = 0u; c < 3u; c++) {
    let val = e[c];
    let whole = floor(val);
    let add = u32(whole) + select(0u, 1u, hash3(id.x * 3u + c, id.y, id.z + 31u) < val - whole);
    if (add > 0u) { atomicAdd(&photons[idx * 3u + c], add); }
  }
}
