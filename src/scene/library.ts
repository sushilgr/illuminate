// Factories for everything that can be added to a scene, with composed defaults.
import { hex, kelvin } from './color';
import type {
  Aperture, Emission, Motion, MotionKind, ObjectKind, SceneObject, Surface, Vec3, WallId,
} from './types';

let counter = 0;
export const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}${(counter++).toString(36)}`;

export const surface = (color: Vec3, roughness = 0.9, metal = 0): Surface => ({ color, roughness, metal });
export const emission = (color: Vec3, luminance: number): Emission => ({ color, luminance, lockOutput: false });

export const PLASTER = () => surface(hex(0xdedad2), 0.92);
export const ALUMINUM = () => surface(hex(0xb9bcc0), 0.32, 1);
export const WARM = () => kelvin(2900);

const base = (kind: string, name: string, position: Vec3) => ({ id: uid(kind), name, position, rotation: [0, 0, 0] as Vec3, visible: true, motions: [] as Motion[] });

export interface LibraryEntry { kind: ObjectKind; variant?: string; label: string; group: 'Form' | 'Screen' | 'Light' | 'Glass'; make: (at: Vec3) => SceneObject }

export const LIBRARY: LibraryEntry[] = [
  { kind: 'slab', label: 'Rounded slab', group: 'Form', make: (p) => ({ ...base('slab', 'Slab', [p[0], 0.2, p[2]]), kind: 'slab', surface: PLASTER(), size: [1.2, 0.4, 0.5], round: 0.03 }) },
  { kind: 'cylinder', label: 'Cylinder', group: 'Form', make: (p) => ({ ...base('cylinder', 'Cylinder', [p[0], 0.4, p[2]]), kind: 'cylinder', surface: PLASTER(), radius: 0.25, height: 0.8, round: 0.02 }) },
  { kind: 'sphere', label: 'Sphere', group: 'Form', make: (p) => ({ ...base('sphere', 'Sphere', [p[0], 0.3, p[2]]), kind: 'sphere', surface: PLASTER(), radius: 0.3 }) },
  { kind: 'arch', label: 'Arch', group: 'Form', make: (p) => ({ ...base('arch', 'Arch', [p[0], 1.1, p[2]]), kind: 'arch', surface: PLASTER(), size: [1.8, 2.2, 0.24], span: 1.0, rise: 1.7 }) },
  { kind: 'slab', variant: 'panel', label: 'Colour panel', group: 'Form', make: (p) => ({ ...base('slab', 'Colour panel', [p[0], 1.0, p[2]]), kind: 'slab', surface: surface(hex(0xb04a2c), 0.8), size: [1.4, 2.0, 0.08], round: 0.012 }) },
  { kind: 'curved', label: 'Curved wall', group: 'Screen', make: (p) => ({ ...base('curved', 'Curved wall', [p[0], 0.85, p[2]]), kind: 'curved', surface: PLASTER(), radius: 0.9, height: 1.7, thickness: 0.07, angle: 1.7, round: 0.012 }) },
  { kind: 'folded', label: 'Folded screen', group: 'Screen', make: (p) => ({ ...base('folded', 'Folded screen', [p[0], 0.8, p[2]]), kind: 'folded', surface: PLASTER(), panels: 4, panelWidth: 0.5, height: 1.6, thickness: 0.06, fold: 0.9 }) },
  { kind: 'perforated', label: 'Perforated panel', group: 'Screen', make: (p) => ({ ...base('perforated', 'Perforated panel', [p[0], 1.0, p[2]]), kind: 'perforated', surface: ALUMINUM(), size: [1.4, 2.0, 0.07], hole: 0.09, pitch: 0.28 }) },
  { kind: 'louvers', label: 'Louvers', group: 'Screen', make: (p) => ({ ...base('louvers', 'Louvers', [p[0], 1.1, p[2]]), kind: 'louvers', surface: ALUMINUM(), size: [1.6, 2.2, 0.16], pitch: 0.2, slat: 0.06, tilt: 0.5 }) },
  { kind: 'emitter', variant: 'rect', label: 'Panel light', group: 'Light', make: (p) => ({ ...base('emitter', 'Panel light', [p[0], 2.2, p[2]]), kind: 'emitter', shape: 'rect', size: [0.8, 0.5], emission: emission(kelvin(3400), 14) }) },
  { kind: 'emitter', variant: 'disk', label: 'Disk light', group: 'Light', make: (p) => ({ ...base('emitter', 'Disk light', [p[0], 2.2, p[2]]), kind: 'emitter', shape: 'disk', size: [0.6, 0.6], emission: emission(kelvin(3000), 18) }) },
  { kind: 'emitter', variant: 'sphere', label: 'Globe light', group: 'Light', make: (p) => ({ ...base('emitter', 'Globe light', [p[0], 1.4, p[2]]), kind: 'emitter', shape: 'sphere', size: [0.32, 0.32], emission: emission(kelvin(2700), 12) }) },
  { kind: 'stroke', variant: 'ribbon', label: 'Ribbon', group: 'Light', make: (p) => ribbon([p[0], 1.6, p[2]]) },
  { kind: 'decal', label: 'Light patch', group: 'Light', make: (p) => ({ ...base('decal', 'Light patch', [p[0], 0.004, p[2]]), kind: 'decal', rotation: [-Math.PI / 2, 0, 0], size: [0.8, 0.5], emission: emission(kelvin(3200), 10) }) },
  { kind: 'spot', label: 'Light aperture', group: 'Light', make: (p) => ({ ...base('spot', 'Light aperture', [p[0], 2.6, p[2]]), kind: 'spot', color: kelvin(3600), flux: 4, spread: 0.7, softness: 0.25, shutters: [0, 0, 0, 0] }) },
  { kind: 'glass', variant: 'slab', label: 'Glass slab', group: 'Glass', make: (p) => glass('slab', [p[0], 0.75, p[2]]) },
  { kind: 'glass', variant: 'fluted', label: 'Fluted glass', group: 'Glass', make: (p) => ({ ...glass('slab', [p[0], 0.75, p[2]]), name: 'Fluted glass', fluteDepth: 0.012, fluteSpacing: 0.045, tint: hex(0xcfe6dc) }) },
  { kind: 'glass', variant: 'frost', label: 'Frosted panel', group: 'Glass', make: (p) => ({ ...glass('slab', [p[0], 0.9, p[2]]), name: 'Frosted panel', size: [1.3, 1.8, 0.04], frost: 0.85, tint: hex(0xe9efec) }) },
  { kind: 'glass', variant: 'lens', label: 'Lens', group: 'Glass', make: (p) => ({ ...glass('lens', [p[0], 1.0, p[2]]), name: 'Lens', size: [0.5, 0.5, 0.12] }) },
  { kind: 'glass', variant: 'prism', label: 'Prism', group: 'Glass', make: (p) => ({ ...glass('prism', [p[0], 0.9, p[2]]), name: 'Prism', size: [0.3, 0.9, 0.3], dispersion: 0.4 }) },
  { kind: 'glass', variant: 'rod', label: 'Glass rod', group: 'Glass', make: (p) => ({ ...glass('rod', [p[0], 0.9, p[2]]), name: 'Glass rod', size: [0.22, 1.5, 0.22] }) },
];

export function ribbon(position: Vec3): SceneObject {
  const points: Vec3[] = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const s = i / n - 0.5;
    points.push([s * 2.3, 0.11 * (4 * s * s - 1), 0.16 * Math.sin(s * Math.PI)]);
  }
  return {
    ...base('stroke', 'Ribbon', position), kind: 'stroke', profile: 'ribbon', points, pressure: points.map(() => 1),
    width: 0.055, taper: 0, normal: [0, 1, 0], onSurface: false, emission: emission([1, 0.587, 0.267], 150), fade: 0, born: 0,
  };
}

export function glass(shape: 'slab' | 'lens' | 'prism' | 'rod', position: Vec3): SceneObject & { kind: 'glass' } {
  return {
    ...base('glass', 'Glass slab', position), kind: 'glass', shape, size: [0.9, 1.5, 0.06], ior: 1.5,
    tint: hex(0xd6ebe2), absorption: 0.25, frost: 0, fluteDepth: 0, fluteSpacing: 0.05, dispersion: 0, caustics: true,
  };
}

export function aperture(wall: WallId, u: number, floorToCeiling: boolean, roomHeight: number): Aperture {
  const height = floorToCeiling ? roomHeight - 0.22 : 1.4;
  return {
    id: uid('window'), name: wall === 'ceiling' ? 'Skylight' : 'Window', wall, u,
    v: wall === 'ceiling' ? 0 : floorToCeiling ? height / 2 : 1.5,
    width: wall === 'ceiling' ? 1.2 : floorToCeiling ? 1.25 : 0.9, height: wall === 'ceiling' ? 1.2 : height,
    cols: floorToCeiling ? 2 : 1, rows: floorToCeiling ? 3 : 1, frame: 0.045, shutter: 0, motions: [],
  };
}

export function motion(kind: MotionKind): Motion {
  const amp: Record<MotionKind, number> = { orbit: 0.3, pendulum: 0.3, slide: 0.4, spin: 1, breathe: 0.4, path: 1, param: 0.3 };
  return { id: uid('motion'), kind, enabled: true, amplitude: amp[kind], cycles: 1, phase: 0, easing: 'sine', axis: 'y' };
}
