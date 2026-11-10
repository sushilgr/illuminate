// Validation scenes with closed-form or brute-force reference values.
import { emission, surface } from './library';
import { DEFAULT_ATMOSPHERE, DEFAULT_FINISH, ROOM_SIZE, WALL_THICKNESS } from './presets';
import { SCENE_VERSION } from './types';
import type { Daylight, SceneDescription, SceneObject, Vec3 } from './types';

const dark: Daylight = { skyBrightness: 0, skyTint: [1, 1, 1], turbidity: 3, sunElevation: 1, sunAzimuth: 0, sunBrightness: 0, cloudiness: 0, groundAlbedo: 0, motions: [] };

function room(albedo: number): SceneDescription['room'] {
  const s = () => surface([albedo, albedo, albedo], 1);
  return { size: ROOM_SIZE, thickness: WALL_THICKNESS, wall: s(), floor: s(), ceiling: s(), apertures: [] };
}

export const TEST_EMITTER = { centre: [0, 2.0, 0] as Vec3, size: [0.8, 0.06, 0.8] as Vec3, radiance: 20 };
export const TEST_RIBBON = { a: [-1, 1.8, 0] as Vec3, b: [1, 1.8, 0] as Vec3, width: 0.06, radiance: 100 };

const base = { rotation: [0, 0, 0] as Vec3, visible: true, motions: [] };

function boxEmitter(albedo: number): SceneObject {
  return { ...base, id: 'emitter', name: 'Emitter', kind: 'slab', position: TEST_EMITTER.centre, surface: surface([albedo, albedo, albedo], 1), emission: emission([1, 1, 1], TEST_EMITTER.radiance), size: TEST_EMITTER.size, round: 0 };
}

function wrap(name: string, r: SceneDescription['room'], objects: SceneObject[]): SceneDescription {
  return {
    version: SCENE_VERSION, name, room: r, objects, daylight: dark, atmosphere: DEFAULT_ATMOSPHERE(), finish: DEFAULT_FINISH(), loop: 10,
    camera: { projection: 'perspective', position: [0.2, 2.6, 2.4], target: [0, 0, 0], focal: 16, exposure: 0 },
  };
}

export function createTestScene(name: string): SceneDescription | null {
  switch (name) {
    // Direct light from an area emitter in a black room.
    case 'area': return wrap(name, room(0), [boxEmitter(0)]);
    // The same with a blocker that puts the floor centre in full umbra.
    case 'umbra': return wrap(name, room(0), [boxEmitter(0), { ...base, id: 'blocker', name: 'Blocker', kind: 'slab', position: [0, 1.0, 0], surface: surface([0, 0, 0], 1), size: [1.2, 0.07, 1.2], round: 0 }]);
    // Direct light from a thin ribbon in a black room.
    case 'ribbon': {
      const pts: Vec3[] = [];
      for (let i = 0; i <= 10; i++) pts.push([TEST_RIBBON.a[0] + (TEST_RIBBON.b[0] - TEST_RIBBON.a[0]) * (i / 10), 0, 0]);
      return wrap(name, room(0), [{
        ...base, id: 'ribbon', name: 'Ribbon', kind: 'stroke', profile: 'ribbon', position: [0, TEST_RIBBON.a[1], 0], points: pts, pressure: pts.map(() => 1),
        width: TEST_RIBBON.width, taper: 0, normal: [0, 1, 0], onSurface: false, emission: emission([1, 1, 1], TEST_RIBBON.radiance), fade: 0, born: 0,
      }]);
    }
    // Closed grey enclosure: mean irradiance must equal flux / (area * (1 - albedo)).
    case 'enclosure': return wrap(name, room(0.5), [boxEmitter(0.5)]);
    default: return null;
  }
}
