// The flagship atelier scene. It stays the reference composition throughout development.
import type { Aperture, SceneDescription, Vec3 } from './types';

/** sRGB hex -> linear RGB. */
export function hex(c: number): Vec3 {
  const f = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return [f((c >> 16) & 255), f((c >> 8) & 255), f(c & 255)];
}

export const ROOM_SIZE: Vec3 = [6.16, 3.3, 5.04];
export const WALL_THICKNESS = 0.24;

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

/** Three floor-to-ceiling openings with slim glazing bars along the left wall. */
function loftWindows(): Aperture[] {
  const height = 3.08;
  return [-1.75, -0.2, 1.35].map((u, i) => ({
    id: `window-${i + 1}`, wall: 'x-' as const, u, v: height / 2, width: 1.25, height, cols: 2, rows: 3, frame: 0.045,
  }));
}

export function createAtelier(): SceneDescription {
  return {
    room: {
      size: ROOM_SIZE,
      thickness: WALL_THICKNESS,
      wall: hex(0xb9b4ab),      // chalk plaster
      floor: hex(0xcfc9be),     // pale honed ceramic
      ceiling: hex(0xaaa69f),
      apertures: loftWindows(),
    },
    objects: [
      {
        id: 'ribbon', name: 'Luminous ribbon', kind: 'ribbon',
        position: [0.35, 1.3, -1.6], rotation: [0, 0.22, 0],
        albedo: [0, 0, 0], emission: [150, 88, 40], level: 1,
        points: ribbonPoints(), width: 0.055, normal: [0, 1, 0],
      },
      {
        id: 'screen', name: 'Curved screen', kind: 'arc',
        position: [0.85, 0.85, -0.4], rotation: [0, -2.75, 0],
        albedo: hex(0xdedad2), radius: 0.9, height: 1.7, thickness: 0.07, angle: 1.7, round: 0.012,
      },
      {
        id: 'panel', name: 'Ceramic panel', kind: 'box',
        position: [1.6, 1.2, -2.47], rotation: [0, 0, 0],
        albedo: hex(0xb04a2c), size: [1.7, 2.4, 0.08], round: 0.012,
      },
      {
        id: 'plinth', name: 'Plinth', kind: 'cylinder',
        position: [-1.35, 0.36, -0.7], rotation: [0, 0, 0],
        albedo: hex(0xdcd8d0), radius: 0.24, height: 0.72, round: 0.02,
      },
      {
        id: 'slab', name: 'Bench slab', kind: 'box',
        position: [-0.75, 0.16, 0.75], rotation: [0, 0.35, 0],
        albedo: hex(0xd6d2ca), size: [1.3, 0.32, 0.45], round: 0.03,
      },
    ],
    daylight: {
      skyBrightness: 1, skyTint: [1, 1, 1], turbidity: 2.6,
      sunElevation: 0.56, sunAzimuth: 2.62, sunBrightness: 1, cloudiness: 0, groundAlbedo: 0.22,
    },
  };
}

export const ATELIER_CAMERA = { position: [1.25, 1.42, 2.4] as Vec3, target: [-0.75, 1.2, -1.3] as Vec3, fov: 42, ev: -3.6 };
