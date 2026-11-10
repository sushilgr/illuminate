// Shared structures and binding-independent helpers.
// All lighting quantities are linear, scene-referred radiance (arbitrary photometric scale).

const PI: f32 = 3.14159265358979;
const C0_DIRS: u32 = 16u;   // cascade 0 stores a 4 x 4 equal-area direction grid
const C0_RES: f32 = 4.0;

struct Globals {
  domainMin: vec4f,   // xyz world-space min corner of the GI domain, w = voxel size h
  gridVox:   vec4f,   // xyz voxel grid dimensions, w = emission-density voxel size hJ
  probe0:    vec4f,   // xyz cascade 0 probe grid dimensions, w = cascade 0 probe spacing
  rc:        vec4f,   // x = tNear (start of cascade 0), y = t0, z = interval scale, w = cascade count
  rc2:       vec4f,   // x = hit epsilon, y = bounce gain, z = frame index, w = sky gain
  sunDir:    vec4f,   // xyz direction towards the sun, w = tan(angular radius)
  sunIrr:    vec4f,   // rgb irradiance on a surface facing the sun, w = enabled
  skyZen:    vec4f,   // rgb zenith radiance
  skyHor:    vec4f,   // rgb horizon radiance
  skyGnd:    vec4f,   // rgb radiance of the exterior ground
  counts:    vec4f,   // x = primitive count, y = thin segment count, z = debug mode, w = debug parameter
  dirs:      array<vec4f, 16>, // cascade 0 direction centres
}

struct Hit {
  J: vec3f,     // radiance gathered inside the interval
  beta: f32,    // transmittance of the interval (1 = nothing was hit)
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

// Clamped cosine convolved with a direction bin of cascade 0, so that the weight of a
// direction changes smoothly as the surface normal turns across the bin.
fn cosWeight(c: f32) -> f32 {
  let s = 0.48;
  if (c >= s) { return c; }
  if (c <= -s) { return 0.0; }
  let u = c + s;
  return u * u / (4.0 * s);
}

fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
