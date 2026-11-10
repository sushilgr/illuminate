// Shared structures and binding-independent helpers.
// All lighting quantities are linear and scene-referred: radiance in kcd/m2, irradiance in klx.

const PI: f32 = 3.14159265358979;
const C0_RES: u32 = 8u;      // cascade 0 stores an 8 x 8 equal-area direction grid
const C0_DIRS: u32 = 64u;
const COARSE_RES: u32 = 4u;  // the final gather groups them 2 x 2 for its near-field cones
const NO_HIT: f32 = 1e9;

// A wall or ceiling opening, used for exact sun shadows of its edges and glazing bars.
struct Aperture {
  c: vec4f,   // xyz centre on the inner wall face, w = half width
  u: vec4f,   // xyz unit axis along the width, w = half height
  v: vec4f,   // xyz unit axis along the height, w = wall thickness
  n: vec4f,   // xyz outward normal
  m: vec4f,   // x = panes across, y = panes up, z = half width of a glazing bar
}

struct Globals {
  domainMin: vec4f,   // xyz world-space min corner of the GI domain, w = voxel size h
  gridVox:   vec4f,   // xyz voxel grid dimensions, w = emission-density voxel size hJ
  probe0:    vec4f,   // xyz cascade 0 probe grid dimensions, w = cascade 0 probe spacing
  rc:        vec4f,   // x = tNear (start of cascade 0), y = t0, z = coverage radius fraction, w = cascade count
  rc2:       vec4f,   // x = hit epsilon, y = bounce gain, z = frame index, w = sky gain
  sunDir:    vec4f,   // xyz direction towards the sun, w = tan(angular radius)
  sunIrr:    vec4f,   // rgb irradiance on a surface facing the sun, w = enabled
  roomMin:   vec4f,   // xyz interior min corner, w = aperture count
  roomMax:   vec4f,   // xyz interior max corner
  spare:     vec4f,
  counts:    vec4f,   // x = primitive count, y = thin segment count, z = debug mode, w = debug parameter
  aps:       array<Aperture, 8>,
  dirs:      array<vec4f, 64>, // cascade 0 direction centres (8 x 8, row-major)
}

struct Hit {
  J: vec3f,     // radiance gathered inside the interval by partial coverage and thin emitters
  cov: f32,     // coverage accumulated inside the interval
  LHit: vec3f,  // radiance of the surface that stopped the ray, if any
  tHit: f32,    // distance of that surface (NO_HIT if the ray ran free); may lie in the extension
}

fn copysign(m: f32, s: f32) -> f32 { return select(-abs(m), abs(m), s >= 0.0); }

// Clarberg's equal-area square <-> sphere mapping. Every texel of an N x N grid covers the
// same solid angle, and 2 x 2 subdivision of a texel yields its four child directions.
// The pole axis of the map is world Y.
fn squareToSphere(uv: vec2f) -> vec3f {
  let u = 2.0 * uv.x - 1.0;
  let v = 2.0 * uv.y - 1.0;
  let up = abs(u);
  let vp = abs(v);
  let sd = 1.0 - (up + vp);
  let d = abs(sd);
  let r = 1.0 - d;
  var phi = PI * 0.25;
  if (r > 1e-6) { phi = ((vp - up) / r + 1.0) * PI * 0.25; }
  let z = copysign(1.0 - r * r, sd);
  let s = r * sqrt(max(2.0 - r * r, 0.0));
  let x = copysign(cos(phi), u) * s;
  let y = copysign(sin(phi), v) * s;
  return vec3f(x, z, y);
}

// Tangent of the half-angle of a cone covering 1 / (res * res) of the sphere.
fn coneTan(res: f32) -> f32 {
  let c = 1.0 - 2.0 / (res * res);
  return sqrt(max(1.0 - c * c, 0.0)) / max(c, 1e-3);
}

// Clamped cosine convolved with a direction bin of half-width s, so that the weight of a
// direction changes smoothly as the surface normal turns across the bin.
fn cosWeight(c: f32, s: f32) -> f32 {
  if (c >= s) { return c; }
  if (c <= -s) { return 0.0; }
  let u = c + s;
  return u * u / (4.0 * s);
}

fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
