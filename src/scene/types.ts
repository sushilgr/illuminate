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
  /** Glazing bars: panes across and up, and the bar width in metres. */
  cols: number;
  rows: number;
  frame: number;
}

export interface Room {
  /** Interior dimensions; the floor is at y = 0 and the room is centred on x and z. */
  size: Vec3;
  /** Wall thickness, which is also the reveal depth of every opening. */
  thickness: number;
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
}

export interface SceneDescription {
  room: Room;
  objects: SceneObject[];
  daylight: Daylight;
}
