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
    pts.push([s * 2.3, 0.22 * (4 * s * s - 1) * 0.5, 0.16 * Math.sin(s * Math.PI)]);
  }
  return pts;
}

export function createAtelier(): SceneDescription {
  return {
    room: {
      size: ROOM_SIZE,
      wall: hex(0xe6e1d8),      // chalk plaster
      floor: hex(0xcfcac2),     // pale honed ceramic
      ceiling: hex(0xebe8e2),
      apertures: [
        { id: 'window', wall: 'x-', u: -0.85, v: 1.42, width: 0.52, height: 2.05 },
      ],
    },
    objects: [
      {
        id: 'ribbon', name: 'Luminous ribbon', kind: 'ribbon',
        position: [-0.25, 1.72, 0.35], rotation: [0, 0.22, 0],
        albedo: [0, 0, 0], emission: [150, 78, 30], level: 1,
        points: ribbonPoints(), width: 0.055, normal: [0, 1, 0],
      },
      {
        id: 'screen', name: 'Curved screen', kind: 'arc',
        position: [1.25, 0.8, -0.55], rotation: [0, -2.05, 0],
        albedo: hex(0xdedad2), radius: 1.05, height: 1.6, thickness: 0.07, angle: 1.9, round: 0.012,
      },
      {
        id: 'panel', name: 'Ceramic panel', kind: 'box',
        position: [0.55, 1.05, -2.42], rotation: [0, 0, 0],
        albedo: hex(0xa8452b), size: [1.9, 2.1, 0.08], round: 0.012,
      },
      {
        id: 'plinth', name: 'Plinth', kind: 'cylinder',
        position: [-1.15, 0.36, -1.3], rotation: [0, 0, 0],
        albedo: hex(0xdcd8d0), radius: 0.24, height: 0.72, round: 0.02,
      },
      {
        id: 'slab', name: 'Bench slab', kind: 'box',
        position: [-0.6, 0.21, 1.35], rotation: [0, 0.18, 0],
        albedo: hex(0xd6d2ca), size: [1.5, 0.42, 0.5], round: 0.03,
      },
    ],
    daylight: {
      skyBrightness: 9, skyTint: hex(0xbcd4ff), sunElevation: 0.6, sunAzimuth: -1.9, sunBrightness: 0, cloudiness: 0.6,
    },
  };
}
