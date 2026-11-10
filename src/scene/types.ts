// Scene description shared by the visible meshes and the GI voxeliser.
// Lengths are metres, colours are linear RGB, emission is radiance (per unit area).

export type Vec3 = [number, number, number];

export type WallId = 'x-' | 'x+' | 'z-' | 'z+' | 'ceiling';

export interface Aperture {
  id: string;
  wall: WallId;
  /** Offset along the wall from its centre (x for z-walls and ceiling, z for x-walls). */
  u: number;
  /** Height of the aperture centre above the floor (z offset for the ceiling). */
  v: number;
  width: number;
  height: number;
}

export interface Room {
  /** Interior dimensions; the floor is at y = 0 and the room is centred on x and z. */
  size: Vec3;
  wall: Vec3;
  floor: Vec3;
  ceiling: Vec3;
  apertures: Aperture[];
}

interface ObjectBase {
  id: string;
  name: string;
  position: Vec3;
  /** Euler angles in radians, XYZ order. */
  rotation: Vec3;
  albedo: Vec3;
  /** Emitted radiance; omitted or zero for non-emitters. */
  emission?: Vec3;
  roughness?: number;
  visible?: boolean;
}

export interface BoxObject extends ObjectBase { kind: 'box'; size: Vec3; round: number }
export interface CylinderObject extends ObjectBase { kind: 'cylinder'; radius: number; height: number; round: number }
export interface SphereObject extends ObjectBase { kind: 'sphere'; radius: number }
/** A curved wall: an annular sector extruded vertically, opening towards local +Z. */
export interface ArcObject extends ObjectBase { kind: 'arc'; radius: number; height: number; thickness: number; angle: number; round: number }
/** Parallel slats inside a frame volume; slats repeat along local X and can be tilted. */
export interface SlatsObject extends ObjectBase { kind: 'slats'; size: Vec3; pitch: number; slatThickness: number; tilt: number }
/** A luminous strip following a polyline (local space). Thin emitter. */
export interface RibbonObject extends ObjectBase {
  kind: 'ribbon';
  points: Vec3[];
  width: number;
  /** Direction of the strip's face normal (local space); the strip is two-sided. */
  normal: Vec3;
  emission: Vec3;
  /** 0..1 multiplier applied to the emission (animation, switching). */
  level: number;
}

export type SceneObject = BoxObject | CylinderObject | SphereObject | ArcObject | SlatsObject | RibbonObject;

export interface Daylight {
  skyBrightness: number;
  skyTint: Vec3;
  sunElevation: number;
  sunAzimuth: number;
  sunBrightness: number;
  cloudiness: number;
}

export interface SceneDescription {
  room: Room;
  objects: SceneObject[];
  daylight: Daylight;
}
