// The flagship atelier and four composed presets. Each returns a fresh, self-contained scene.
import { hex, kelvin } from './color';
import { ALUMINUM, LIBRARY, aperture, emission, motion, ribbon, surface, uid } from './library';
import { SCENE_VERSION } from './types';
import type {
  Aperture, Atmosphere, CameraState, Daylight, Finish, GlassObject, Motion, MotionKind, SceneDescription, SceneObject, Vec3,
} from './types';

export const ROOM_SIZE: Vec3 = [6.16, 3.3, 5.04];
export const WALL_THICKNESS = 0.24;
const ETCH = 64;

const mo = (kind: MotionKind, o: Partial<Motion>): Motion => ({ ...motion(kind), ...o });
const make = (label: string, at: Vec3) => LIBRARY.find((e) => e.label === label)!.make(at);
const place = <T extends SceneObject>(o: SceneObject, patch: Partial<T>): T => ({ ...(o as T), ...patch });

export const DEFAULT_FINISH = (): Finish => ({
  toneMap: 'agx', whiteBalance: 6500, tint: 0, rolloff: 1, contrast: 1.06, saturation: 1.06, bloom: 0.06, grain: 0.012, vignette: 0.05,
});
export const DEFAULT_ATMOSPHERE = (): Atmosphere => ({ haze: 0, tint: [1, 1, 1], anisotropy: 0.55 });
const day = (d: Partial<Daylight>): Daylight => ({
  skyBrightness: 1, skyTint: [1, 1, 1], turbidity: 2.6, sunElevation: 0.56, sunAzimuth: 2.62, sunBrightness: 1, cloudiness: 0, groundAlbedo: 0.22, motions: [], ...d,
});
const cam = (position: Vec3, target: Vec3, focal: number, exposure: number): CameraState => ({
  projection: 'perspective', position, target, focal, exposure,
});

/** Floor-to-ceiling openings with slim glazing bars along the left wall. */
function loftWindows(us: number[], width = 1.25): Aperture[] {
  return us.map((u, i) => ({ ...aperture('x-', u, true, ROOM_SIZE[1]), id: `window-${i + 1}`, name: `Window ${i + 1}`, width }));
}

function room(wall: number, floor: number, ceiling: number, apertures: Aperture[], floorRoughness = 0.55) {
  return {
    size: [...ROOM_SIZE] as Vec3, thickness: WALL_THICKNESS,
    wall: surface(hex(wall), 0.92), floor: surface(hex(floor), floorRoughness), ceiling: surface(hex(ceiling), 0.95), apertures,
  };
}

/** A few sweeping strokes cleared out of the frost, as a base64 mask. */
function etchPattern(): string {
  const m = new Uint8Array(ETCH * ETCH);
  const stroke = (f: (t: number) => [number, number], r: number) => {
    for (let k = 0; k <= 400; k++) {
      const [cx, cy] = f(k / 400);
      for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        if (x < 0 || y < 0 || x >= ETCH || y >= ETCH) continue;
        const v = Math.round(255 * Math.min(Math.max(1.2 - Math.hypot(x - cx, y - cy) / r, 0), 1));
        m[y * ETCH + x] = Math.max(m[y * ETCH + x], v);
      }
    }
  };
  stroke((t) => [8 + 48 * t, 50 - 34 * Math.sin(t * Math.PI) * 0.9], 2.6);
  stroke((t) => [14 + 30 * t, 12 + 40 * t * t], 2.0);
  stroke((t) => [40 + 14 * Math.cos(t * 5), 36 + 14 * Math.sin(t * 5)], 1.6);
  let s = '';
  for (let i = 0; i < m.length; i++) s += String.fromCharCode(m[i]);
  return btoa(s);
}

function scene(name: string, parts: Pick<SceneDescription, 'room' | 'objects' | 'daylight' | 'camera'> & Partial<SceneDescription>): SceneDescription {
  return { version: SCENE_VERSION, name, atmosphere: DEFAULT_ATMOSPHERE(), finish: DEFAULT_FINISH(), loop: 40, ...parts };
}

/** The flagship: a daylit loft with a ribbon, fluted glass, a curved screen and a ceramic panel. */
export function createAtelier(): SceneDescription {
  return scene('Atelier', {
    room: room(0xb9b4ab, 0xcfc9be, 0xaaa69f, loftWindows([-1.75, -0.2, 1.35])),
    objects: [
      place(ribbon([1.0, 1.32, -0.8]), {
        id: 'ribbon', name: 'Luminous ribbon', rotation: [1.1, 0.25, 0], width: 0.06, emission: emission([1, 0.587, 0.267], 420),
        motions: [mo('pendulum', { amplitude: 0.07, cycles: 3 }), mo('slide', { amplitude: 0.06, cycles: 4, phase: 0.2 }), mo('breathe', { amplitude: 0.28, cycles: 6 })],
      } as Partial<SceneObject>),
      // The screen's wall stands one radius behind its position, hollow side towards the camera, cupping the ribbon.
      place(make('Curved wall', [0.8, 0, -0.6]), { id: 'screen', name: 'Curved screen', rotation: [0, -2.85, 0], motions: [mo('pendulum', { amplitude: 0.22, cycles: 2, phase: 0.1 })] }),
      place(make('Colour panel', [1.6, 0, -2.47]), { id: 'panel', name: 'Ceramic panel', position: [1.6, 1.2, -2.47], size: [1.7, 2.4, 0.08], surface: surface(hex(0xb04a2c), 0.45) } as Partial<SceneObject>),
      place(make('Fluted glass', [-1.7, 0, -0.3]), { id: 'glass', name: 'Fluted glass', position: [-1.7, 0.8, -0.3], rotation: [0, 0.1, 0], size: [0.95, 1.6, 0.06], fluteDepth: 0.008, fluteSpacing: 0.04, motions: [mo('pendulum', { amplitude: 0.3, cycles: 1, phase: 0.4 })] } as Partial<SceneObject>),
      place(make('Cylinder', [-1.2, 0, -1.25]), { id: 'plinth', name: 'Plinth', position: [-1.2, 0.36, -1.25], radius: 0.24, height: 0.72 } as Partial<SceneObject>),
      place(make('Rounded slab', [-0.3, 0, 1.25]), { id: 'slab', name: 'Bench slab', position: [-0.3, 0.16, 1.25], rotation: [0, 0.35, 0], size: [1.3, 0.32, 0.45] } as Partial<SceneObject>),
    ],
    daylight: day({
      sunElevation: 0.62, sunAzimuth: 2.25, turbidity: 2.2,
      motions: [mo('param', { param: 'sunAzimuth', amplitude: 0.2, cycles: 1 }), mo('param', { param: 'sunElevation', amplitude: 0.05, cycles: 1, phase: 0.25 })],
    }),
    camera: cam([2.35, 1.45, 2.3], [-0.7, 1.1, -1.1], 26, -3.6),
  });
}

/** Cool sky, warm plaster, deep reveals, slowly turning louvers. */
function morningAperture(): SceneDescription {
  const win: Aperture[] = [-1.2, 0.7].map((u, i) => ({ ...aperture('x-', u, false, ROOM_SIZE[1]), id: `window-${i + 1}`, name: `Window ${i + 1}`, v: 1.75, width: 1.3, height: 2.3, cols: 1, rows: 1, frame: 0.04 }));
  return scene('Morning Aperture', {
    room: room(0xd6c7b2, 0xc9bda9, 0xcfc3b0, win),
    objects: [
      place(make('Louvers', [-2.55, 0, -0.25]), {
        id: 'louvers', position: [-2.55, 1.7, -0.25], rotation: [0, Math.PI / 2, 0], size: [3.4, 2.5, 0.2], pitch: 0.2, slat: 0.055, tilt: -0.3,
        surface: ALUMINUM(), motions: [mo('param', { param: 'tilt', amplitude: 0.42, cycles: 1 })],
      } as Partial<SceneObject>),
      place(make('Arch', [1.2, 0, -1.1]), { position: [1.2, 1.2, -1.1], rotation: [0, 0.5, 0], size: [2.0, 2.4, 0.26], span: 1.1, rise: 1.9 } as Partial<SceneObject>),
      place(make('Sphere', [0.2, 0, 0.5]), { position: [0.2, 0.32, 0.5], radius: 0.32 } as Partial<SceneObject>),
      place(make('Rounded slab', [-0.6, 0, -1.4]), { position: [-0.6, 0.25, -1.4], size: [1.6, 0.5, 0.55], rotation: [0, -0.2, 0] } as Partial<SceneObject>),
    ],
    daylight: day({ sunElevation: 0.3, sunAzimuth: 2.85, turbidity: 3.4, motions: [mo('param', { param: 'sunElevation', amplitude: 0.07, cycles: 1 })] }),
    camera: cam([2.3, 1.35, 2.2], [-1.0, 1.25, -0.9], 28, -3.0),
    atmosphere: { ...DEFAULT_ATMOSPHERE(), haze: 0.035 },
    finish: { ...DEFAULT_FINISH(), whiteBalance: 6000 },
    loop: 30,
  });
}

/** A warm ribbon, smoked glass and dark ceramic after dusk. */
function amberStudy(): SceneDescription {
  const win = loftWindows([-0.2], 1.1);
  return scene('Amber Study', {
    room: room(0x8a8078, 0x2a2623, 0x6a625b, win, 0.22),
    objects: [
      place(ribbon([0.1, 1.15, -0.5]), {
        name: 'Amber ribbon', rotation: [1.0, -0.3, 0], emission: emission([1, 0.5, 0.16], 110),
        motions: [mo('pendulum', { amplitude: 0.35, cycles: 1 }), mo('breathe', { amplitude: 0.35, cycles: 5 })],
      } as Partial<SceneObject>),
      place(make('Glass slab', [-0.5, 0, 0.5]), { name: 'Amber glass', position: [-0.5, 0.85, 0.55], rotation: [0, 0.25, 0], size: [1.5, 1.7, 0.07], tint: hex(0xb07a3c), absorption: 0.12, motions: [mo('slide', { amplitude: 0.5, cycles: 1, axis: 'x' })] } as Partial<SceneObject>),
      place(make('Cylinder', [1.5, 0, -1.1]), { position: [1.5, 0.55, -1.1], radius: 0.3, height: 1.1, surface: surface(hex(0x1d1a18), 0.2) } as Partial<SceneObject>),
      place(make('Colour panel', [-1.6, 0, -2.47]), { position: [-1.6, 1.3, -2.47], size: [1.5, 2.6, 0.08], surface: surface(hex(0x7a3a1c), 0.35) } as Partial<SceneObject>),
      place(make('Globe light', [1.5, 0, -1.1]), { position: [1.5, 1.3, -1.1], size: [0.26, 0.26], emission: emission(kelvin(2300), 10) } as Partial<SceneObject>),
    ],
    daylight: day({ sunElevation: -0.035, sunAzimuth: 2.9, skyBrightness: 2, sunBrightness: 0 }),
    camera: cam([2.2, 1.3, 2.3], [-0.5, 1.0, -0.9], 28, 0.3),
    finish: { ...DEFAULT_FINISH(), whiteBalance: 4300, bloom: 0.14, contrast: 1.1 },
    loop: 24,
  });
}

/** An etched frosted panel in the sun, celadon surfaces and a light that drifts. */
function frostGarden(): SceneDescription {
  const frost = place<GlassObject>(make('Frosted panel', [-1.3, 0, -0.2]), {
    id: 'etched', name: 'Etched frost', position: [-1.5, 1.15, -0.2], rotation: [0, 1.2, 0], size: [2.0, 2.2, 0.045], frost: 0.9, etch: etchPattern(), caustics: true,
  });
  return scene('Frost Garden', {
    room: room(0xb7c9bc, 0xc3cfc4, 0xaebdb1, loftWindows([-1.0, 0.6], 1.4)),
    objects: [
      frost,
      place(make('Sphere', [0.3, 0, -0.9]), { position: [0.3, 0.38, -0.9], radius: 0.38, surface: surface(hex(0x8fb4a0), 0.5) } as Partial<SceneObject>),
      place(make('Sphere', [1.3, 0, 0.3]), { position: [1.3, 0.24, 0.3], radius: 0.24, surface: surface(hex(0xdde6df), 0.7) } as Partial<SceneObject>),
      place(make('Cylinder', [1.9, 0, -1.6]), { position: [1.9, 0.75, -1.6], radius: 0.2, height: 1.5, surface: surface(hex(0x6f9983), 0.6) } as Partial<SceneObject>),
      place(make('Glass rod', [0.9, 0, -1.8]), { position: [0.9, 0.75, -1.8], size: [0.2, 1.5, 0.2], tint: hex(0xc4e2d2) } as Partial<SceneObject>),
      place(make('Light aperture', [0.8, 0, 0.4]), { position: [0.8, 3.0, 0.4], rotation: [0.25, 0, 0.2], flux: 40, spread: 0.6, color: kelvin(3000), motions: [mo('orbit', { amplitude: 0.5, cycles: 1 })] } as Partial<SceneObject>),
    ],
    daylight: day({ sunElevation: 0.62, sunAzimuth: 2.8, turbidity: 2.4, motions: [mo('param', { param: 'sunAzimuth', amplitude: 0.25, cycles: 1 })] }),
    camera: cam([2.2, 1.45, 2.2], [-0.6, 1.0, -0.8], 30, -3.5),
    atmosphere: { ...DEFAULT_ATMOSPHERE(), haze: 0.012 },
    loop: 36,
  });
}

/** Coloured panels and folded screens under a skylight: reflected colours mix on the plaster. */
function chromaticFold(): SceneDescription {
  const sky: Aperture[] = [{ ...aperture('ceiling', 0, false, ROOM_SIZE[1]), id: 'skylight', name: 'Skylight', u: 0.2, v: 0.3, width: 3.0, height: 2.0, cols: 3, rows: 2, frame: 0.05 }];
  const panel = (name: string, color: number, position: Vec3, yaw: number, size: Vec3): SceneObject =>
    place(make('Colour panel', position), { name, position, rotation: [0, yaw, 0], size, surface: surface(hex(color), 0.7) } as Partial<SceneObject>);
  return scene('Chromatic Fold', {
    room: room(0xdedad2, 0xd4d0c8, 0xe2dfd8, sky, 0.7),
    objects: [
      panel('Vermilion panel', 0xd0432a, [-1.9, 1.1, -1.3], 0.95, [1.5, 2.2, 0.07]),
      panel('Ultramarine panel', 0x2a4bc0, [0.1, 1.0, -1.95], 0.2, [1.5, 2.0, 0.07]),
      place(make('Rounded slab', [-0.7, 0, -0.3]), { name: 'Ochre block', position: [-0.7, 0.2, -0.3], rotation: [0, 0.5, 0], size: [1.5, 0.4, 0.6], surface: surface(hex(0xd9a032), 0.7) } as Partial<SceneObject>),
      place(make('Folded screen', [1.55, 0, -0.9]), { position: [1.55, 0.9, -0.9], panels: 5, panelWidth: 0.5, height: 1.8, fold: 1.1, rotation: [0, -0.6, 0], motions: [mo('param', { param: 'fold', amplitude: 0.5, cycles: 1 })] } as Partial<SceneObject>),
      place(make('Perforated panel', [2.3, 0, 0.9]), { position: [2.3, 1.0, 0.9], rotation: [0, -1.2, 0], surface: surface(hex(0xe6e3dc), 0.85), motions: [mo('pendulum', { amplitude: 0.4, cycles: 2 })] } as Partial<SceneObject>),
    ],
    daylight: day({ sunElevation: 0.95, sunAzimuth: 0.75, cloudiness: 0.05, motions: [mo('param', { param: 'sunAzimuth', amplitude: 0.45, cycles: 1 })] }),
    camera: cam([0.6, 1.5, 2.45], [-0.3, 1.0, -1.2], 24, -3.7),
    loop: 32,
  });
}

export const PRESETS: { name: string; note: string; make: () => SceneDescription }[] = [
  { name: 'Atelier', note: 'Loft daylight, ribbon, fluted glass', make: createAtelier },
  { name: 'Morning Aperture', note: 'Low sun through turning louvers', make: morningAperture },
  { name: 'Amber Study', note: 'Dusk, amber glass, dark ceramic', make: amberStudy },
  { name: 'Frost Garden', note: 'Etched frost, celadon, drifting light', make: frostGarden },
  { name: 'Chromatic Fold', note: 'Coloured panels mixing by reflection', make: chromaticFold },
];

/** Fresh ids for every object, so a preset can be loaded twice without clashes. */
export function withFreshIds(s: SceneDescription): SceneDescription {
  for (const o of s.objects) { o.id = uid(o.kind); for (const m of o.motions) m.id = uid('motion'); }
  return s;
}
