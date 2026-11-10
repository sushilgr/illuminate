// Validation scenes with closed-form or brute-force reference values.
import { ROOM_SIZE } from './atelier';
import type { SceneDescription, SceneObject, Vec3 } from './types';

const dark: SceneDescription['daylight'] = { skyBrightness: 0, skyTint: [1, 1, 1], sunElevation: 1, sunAzimuth: 0, sunBrightness: 0, cloudiness: 0 };

function room(albedo: number): SceneDescription['room'] {
  const a: Vec3 = [albedo, albedo, albedo];
  return { size: ROOM_SIZE, wall: a, floor: a, ceiling: a, apertures: [] };
}

export const TEST_EMITTER = { centre: [0, 2.0, 0] as Vec3, size: [0.8, 0.06, 0.8] as Vec3, radiance: 20 };
export const TEST_RIBBON = { a: [-1, 1.8, 0] as Vec3, b: [1, 1.8, 0] as Vec3, width: 0.06, radiance: 100 };

function boxEmitter(albedo: number): SceneObject {
  const L = TEST_EMITTER.radiance;
  return { id: 'emitter', name: 'Emitter', kind: 'box', position: TEST_EMITTER.centre, rotation: [0, 0, 0], albedo: [albedo, albedo, albedo], emission: [L, L, L], size: TEST_EMITTER.size, round: 0 };
}

export function createTestScene(name: string): SceneDescription | null {
  switch (name) {
    // Direct light from an area emitter in a black room.
    case 'area': return { room: room(0), objects: [boxEmitter(0)], daylight: dark };
    // The same with a blocker that puts the floor centre in full umbra.
    case 'umbra': return {
      room: room(0), daylight: dark,
      objects: [boxEmitter(0), { id: 'blocker', name: 'Blocker', kind: 'box', position: [0, 1.0, 0], rotation: [0, 0, 0], albedo: [0, 0, 0], size: [1.2, 0.07, 1.2], round: 0 }],
    };
    // Direct light from a thin ribbon in a black room.
    case 'ribbon': {
      const pts: Vec3[] = [];
      for (let i = 0; i <= 10; i++) pts.push([TEST_RIBBON.a[0] + (TEST_RIBBON.b[0] - TEST_RIBBON.a[0]) * (i / 10), 0, 0]);
      const L = TEST_RIBBON.radiance;
      return {
        room: room(0), daylight: dark,
        objects: [{ id: 'ribbon', name: 'Ribbon', kind: 'ribbon', position: [0, TEST_RIBBON.a[1], 0], rotation: [0, 0, 0], albedo: [0, 0, 0], emission: [L, L, L], level: 1, points: pts, width: TEST_RIBBON.width, normal: [0, 1, 0] }],
      };
    }
    // Closed grey enclosure: mean irradiance must equal flux / (area * (1 - albedo)).
    case 'enclosure': return { room: room(0.5), objects: [boxEmitter(0.5)], daylight: dark };
    default: return null;
  }
}
