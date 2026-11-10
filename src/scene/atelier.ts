// The flagship atelier scene. It stays the reference composition throughout development.
import type { SceneDescription, Vec3 } from './types';

/** sRGB hex -> linear RGB. */
export function hex(c: number): Vec3 {
  const f = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return [f((c >> 16) & 255), f((c >> 8) & 255), f(c & 255)];
}

export const ROOM_SIZE: Vec3 = [6.16, 2.8, 5.04];

function ribbonPoints(): Vec3[] {
  // A shallow hanging curve with a slight drift in plan, sampled evenly.
  const pts: Vec3[] = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const s = i / n - 0.5;
    pts.push([s * 2.3, 0.11 * (4 * s * s - 1), 0.16 * Math.sin(s * Math.PI)]);
  }
  return pts;
}

export function createAtelier(): SceneDescription {
  return {
    room: {
      size: ROOM_SIZE,
      wall: hex(0x9a958e),      // smoke plaster
      floor: hex(0xd0cac0),     // pale honed ceramic
      ceiling: hex(0x86827d),
      apertures: [
        { id: 'window', wall: 'x-', u: -1.05, v: 1.5, width: 0.5, height: 2.1 },
      ],
    },
    objects: [
      {
        // Hung low behind the screen, so the screen reads in silhouette against the lit wall.
        id: 'ribbon', name: 'Luminous ribbon', kind: 'ribbon',
        position: [0.1, 1.16, -1.45], rotation: [0, 0.22, 0],
        albedo: [0, 0, 0], emission: [150, 88, 40], level: 1,
        points: ribbonPoints(), width: 0.055, normal: [0, 1, 0],
      },
      {
        id: 'screen', name: 'Curved screen', kind: 'arc',
        position: [0.75, 0.8, -0.45], rotation: [0, -2.75, 0],
        albedo: hex(0xdedad2), radius: 0.9, height: 1.6, thickness: 0.07, angle: 1.7, round: 0.012,
      },
      {
        id: 'panel', name: 'Ceramic panel', kind: 'box',
        position: [1.55, 1.1, -2.47], rotation: [0, 0, 0],
        albedo: hex(0xb04a2c), size: [1.7, 2.2, 0.08], round: 0.012,
      },
      {
        id: 'plinth', name: 'Plinth', kind: 'cylinder',
        position: [-1.55, 0.36, -0.6], rotation: [0, 0, 0],
        albedo: hex(0xdcd8d0), radius: 0.24, height: 0.72, round: 0.02,
      },
      {
        id: 'slab', name: 'Bench slab', kind: 'box',
        position: [-0.9, 0.16, 0.55], rotation: [0, 0.35, 0],
        albedo: hex(0xd6d2ca), size: [1.3, 0.32, 0.45], round: 0.03,
      },
    ],
    daylight: {
      skyBrightness: 34, skyTint: [0.5, 0.7, 1.0], sunElevation: 0.6, sunAzimuth: -1.9, sunBrightness: 0, cloudiness: 0.25,
    },
  };
}

export const ATELIER_CAMERA = { position: [1.15, 1.32, 2.38] as Vec3, target: [-0.75, 1.12, -1.3] as Vec3, fov: 40, ev: 0.6 };
