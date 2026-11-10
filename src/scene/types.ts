// Scene document. Everything the application can save, load, undo and animate lives here.
// Lengths are metres, angles radians, colours linear RGB, luminance kcd/m2, illuminance klx.

export const SCENE_VERSION = 1;

export type Vec3 = [number, number, number];
export type WallId = 'x-' | 'x+' | 'z-' | 'z+' | 'ceiling';

export interface Surface {
  color: Vec3;
  /** 0 mirror-like to 1 matte. Below 0.6 the surface shows cone-traced reflections. */
  roughness: number;
  /** 0 dielectric, 1 metal. */
  metal: number;
}

export interface Emission {
  /** Chromaticity, linear RGB with a maximum component of 1. */
  color: Vec3;
  /** Emission per unit area, kcd/m2. */
  luminance: number;
  /** Keep the total output constant when the emitter is resized. */
  lockOutput: boolean;
}

export type MotionKind = 'orbit' | 'pendulum' | 'slide' | 'spin' | 'breathe' | 'path' | 'param';
export type Easing = 'sine' | 'linear' | 'ease' | 'hold';

export interface Motion {
  id: string;
  kind: MotionKind;
  enabled: boolean;
  /** Metres for orbit / slide, radians for pendulum, 0..1 depth for breathe, parameter units for param. */
  amplitude: number;
  /** Loop cycles: the motion repeats this many times per loop, which keeps the loop seamless. */
  cycles: number;
  /** 0..1 of a cycle. */
  phase: number;
  easing: Easing;
  axis: 'x' | 'y' | 'z';
  /** Recorded gesture for `path`, relative to the object's position. */
  path?: Vec3[];
  /** Name of the numeric property driven by `param` (e.g. tilt, frost, open). */
  param?: string;
}

interface Base {
  id: string;
  name: string;
  position: Vec3;
  /** Euler angles, XYZ order. */
  rotation: Vec3;
  visible: boolean;
  motions: Motion[];
}

interface Solid extends Base {
  surface: Surface;
  /** Solids may glow; a glowing solid is an area emitter. */
  emission?: Emission;
}

export interface SlabObject extends Solid { kind: 'slab'; size: Vec3; round: number }
export interface CylinderObject extends Solid { kind: 'cylinder'; radius: number; height: number; round: number }
export interface SphereObject extends Solid { kind: 'sphere'; radius: number }
/** A wall with an arched opening: a rectangle up to the springing line, then a semicircle. */
export interface ArchObject extends Solid { kind: 'arch'; size: Vec3; span: number; rise: number }
/** An annular sector extruded vertically, opening towards local +Z. */
export interface CurvedObject extends Solid { kind: 'curved'; radius: number; height: number; thickness: number; angle: number; round: number }
/** Panels hinged in a zig-zag. */
export interface FoldedObject extends Solid { kind: 'folded'; panels: number; panelWidth: number; height: number; thickness: number; fold: number }
/** A panel with a regular grid of round holes. */
export interface PerforatedObject extends Solid { kind: 'perforated'; size: Vec3; hole: number; pitch: number }
/** Parallel slats inside a frame volume; slats repeat along local X and tilt about Y. */
export interface LouversObject extends Solid { kind: 'louvers'; size: Vec3; pitch: number; slat: number; tilt: number }

/** Area emitter: a thin luminous rectangle or disk, or a luminous sphere. */
export interface EmitterObject extends Base {
  kind: 'emitter';
  shape: 'rect' | 'disk' | 'sphere';
  /** Rectangle width and height; disk and sphere use size[0] as the diameter. */
  size: [number, number];
  emission: Emission;
}

/** A painted luminous stroke: a flat ribbon or a round tube following a polyline. */
export interface StrokeObject extends Base {
  kind: 'stroke';
  profile: 'ribbon' | 'tube';
  /** Polyline in local space, resampled and simplified. */
  points: Vec3[];
  /** Pen pressure per point, 0..1. */
  pressure: number[];
  width: number;
  /** 0 keeps the full width to the ends, 1 tapers to a point. */
  taper: number;
  /** Ribbon face normal in local space (the surface normal where it was painted). */
  normal: Vec3;
  /** True when painted onto a surface: the stroke emits to one side only. */
  onSurface: boolean;
  emission: Emission;
  /** Seconds over which the emission fades after `born`; 0 keeps it. */
  fade: number;
  /** Scene-clock time at which the stroke was painted. */
  born: number;
}

/** A luminous patch lying on a surface. */
export interface DecalObject extends Base { kind: 'decal'; size: [number, number]; emission: Emission }

/** A directional light aperture: a small projector with a soft-edged beam and four shutters. */
export interface SpotObject extends Base {
  kind: 'spot';
  color: Vec3;
  /** Luminous flux of the open beam, klm. */
  flux: number;
  /** Full beam angle. */
  spread: number;
  /** 0 hard-edged to 1 fully feathered. */
  softness: number;
  /** Left, right, top, bottom shutter positions, 0 open to 1 closed to the centre. */
  shutters: [number, number, number, number];
}

export interface GlassObject extends Base {
  kind: 'glass';
  shape: 'slab' | 'lens' | 'prism' | 'rod';
  /** slab: width, height, thickness. lens: diameter, -, centre thickness. prism: side, length, -. rod: diameter, length, -. */
  size: Vec3;
  ior: number;
  /** Colour reached after `absorption` metres of travel. */
  tint: Vec3;
  absorption: number;
  /** Transmission roughness, 0 clear to 1 fully frosted. */
  frost: number;
  /** Flute depth and spacing in metres (slab only); 0 depth disables fluting. */
  fluteDepth: number;
  fluteSpacing: number;
  dispersion: number;
  caustics: boolean;
  /** Etched frost mask, 64 x 64 values 0..255 (255 = frost removed), base64. Slab only. */
  etch?: string;
}

export type SceneObject =
  | SlabObject | CylinderObject | SphereObject | ArchObject | CurvedObject | FoldedObject | PerforatedObject | LouversObject
  | EmitterObject | StrokeObject | DecalObject | SpotObject | GlassObject;
export type ObjectKind = SceneObject['kind'];

export interface Aperture {
  id: string;
  name: string;
  wall: WallId;
  /** Offset along the wall from its centre (x for z-walls and ceiling, z for x-walls). */
  u: number;
  /** Height of the opening's centre above the floor (z offset for the ceiling). */
  v: number;
  width: number;
  height: number;
  /** Glazing bars: panes across and up, and the bar width in metres. */
  cols: number;
  rows: number;
  frame: number;
  /** Shutter: 0 open to 1 closed, drawn down from the top. */
  shutter: number;
  motions: Motion[];
}

export interface Room {
  /** Interior dimensions; the floor is at y = 0 and the room is centred on x and z. */
  size: Vec3;
  /** Wall thickness, which is also the reveal depth of every opening. */
  thickness: number;
  wall: Surface;
  floor: Surface;
  ceiling: Surface;
  apertures: Aperture[];
}

export interface Daylight {
  /** Multiplier on the sky's radiance (1 = physical clear or overcast sky). */
  skyBrightness: number;
  skyTint: Vec3;
  /** Atmospheric turbidity, 2 (very clear) to 6 (hazy). */
  turbidity: number;
  /** Radians above the horizon. */
  sunElevation: number;
  /** Radians, direction towards the sun measured from +x towards +z. */
  sunAzimuth: number;
  /** Multiplier on the direct sun (1 = physical). */
  sunBrightness: number;
  /** 0 clear to 1 overcast. */
  cloudiness: number;
  groundAlbedo: number;
  motions: Motion[];
}

export interface Atmosphere {
  /** Extinction per metre. */
  haze: number;
  tint: Vec3;
  /** Henyey-Greenstein g, -0.5 back to 0.9 forward. */
  anisotropy: number;
}

export interface CameraState {
  projection: 'perspective' | 'orthographic';
  position: Vec3;
  target: Vec3;
  /** 35 mm equivalent focal length. */
  focal: number;
  /** Exposure compensation in stops. */
  exposure: number;
}

export interface Finish {
  toneMap: 'agx' | 'neutral' | 'aces' | 'linear';
  /** Colour temperature of the white point, kelvin. */
  whiteBalance: number;
  /** -1 green to 1 magenta. */
  tint: number;
  /** 0 hard clip to 1 long shoulder. */
  rolloff: number;
  contrast: number;
  saturation: number;
  bloom: number;
  grain: number;
  vignette: number;
}

export interface Quality {
  tier: 'auto' | 'low' | 'medium' | 'high';
  /** Megapixel budget of the drawing buffer. */
  pixels: number;
  /** Solver iterations per frame. */
  iterations: number;
  reflections: boolean;
  caustics: 'off' | 'low' | 'high';
  /** Fraction of the cone radius used for partial coverage. */
  coverage: number;
}

export interface SceneDescription {
  version: number;
  name: string;
  room: Room;
  objects: SceneObject[];
  daylight: Daylight;
  atmosphere: Atmosphere;
  camera: CameraState;
  finish: Finish;
  /** Loop length of the scene clock in seconds. */
  loop: number;
}
