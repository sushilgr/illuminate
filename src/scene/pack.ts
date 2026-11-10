// Packs evaluated scene objects into the GPU primitive, segment and light buffers.
import * as THREE from 'three/webgpu';
import { APERTURE_FLOATS, MAX_APERTURES, MAX_CAUSTIC_OBJECTS, MAX_SPOTS, PRIM_FLOATS, SEG_FLOATS, SPOT_FLOATS } from '../gi/GISystem';
import type { Aperture, GlassObject, Room, SceneObject, StrokeObject, Surface, Vec3 } from './types';

/**
 * Glass whose sunlight is delivered by photons. A flat slab does not redirect light, so its
 * transmitted sun is exact (and noise-free) as a tinted shadow; only shapes that bend light
 * are traced: fluted slabs, lenses, prisms and rods.
 */
export const castsCaustics = (o: GlassObject) => o.caustics && (o.shape !== 'slab' || o.fluteDepth > 0);

export const PRIM = { shell: 0, box: 1, cylinder: 2, sphere: 3, arc: 4, slats: 5, perforated: 6, lens: 7, prism: 8 } as const;
/** Boolean role of a primitive: start a new object, carve everything so far, or carve the current object. */
export const OP = { union: 0, carveAll: 1, carveObject: 2 } as const;

const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _m = new THREE.Matrix4();
const ONE = new THREE.Vector3(1, 1, 1);
const BLACK: Vec3 = [0, 0, 0];

const scaled = (c: Vec3, k: number): Vec3 => [c[0] * k, c[1] * k, c[2] * k];
/** Diffuse reflectance of a surface: metals reflect specularly, not diffusely. */
const diffuse = (s: Surface): Vec3 => scaled(s.color, 1 - 0.85 * s.metal);

/** Width of a stroke at point i, from pressure and taper. */
export function strokeWidth(o: StrokeObject, i: number): number {
  const n = o.points.length;
  const t = n > 1 ? i / (n - 1) : 0.5;
  const end = Math.min(t, 1 - t) * 2;
  const taper = 1 - o.taper * (1 - Math.min(end / 0.35, 1) ** 0.7);
  return o.width * (0.35 + 0.65 * (o.pressure[i] ?? 1)) * taper;
}

export interface ApertureFrame {
  /** Centre of the opening on the inner wall face. */
  centre: Vec3;
  /** Unit axes along the opening's width and height, and the outward normal. */
  u: Vec3;
  v: Vec3;
  n: Vec3;
  halfWidth: number;
  halfHeight: number;
}

/** Frame of an opening. The shutter closes it from the top (from one side for a skylight). */
export function apertureFrame(room: Room, a: Aperture, withShutter = true): ApertureFrame {
  const [w, h, d] = room.size;
  const open = withShutter ? 1 - Math.min(Math.max(a.shutter, 0), 1) : 1;
  const hw = a.width / 2, hh = (a.height * open) / 2;
  const v = a.v - (a.height * (1 - open)) / 2;
  switch (a.wall) {
    case 'x-': return { centre: [-w / 2, v, a.u], u: [0, 0, 1], v: [0, 1, 0], n: [-1, 0, 0], halfWidth: hw, halfHeight: hh };
    case 'x+': return { centre: [w / 2, v, a.u], u: [0, 0, 1], v: [0, 1, 0], n: [1, 0, 0], halfWidth: hw, halfHeight: hh };
    case 'z-': return { centre: [a.u, v, -d / 2], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, -1], halfWidth: hw, halfHeight: hh };
    case 'z+': return { centre: [a.u, v, d / 2], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], halfWidth: hw, halfHeight: hh };
    case 'ceiling': return { centre: [a.u, h, v], u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0], halfWidth: hw, halfHeight: hh };
  }
}

export class ScenePacker {
  prims = new Float32Array(96 * PRIM_FLOATS);
  segs = new Float32Array(512 * SEG_FLOATS);
  readonly apertures = new Float32Array(MAX_APERTURES * APERTURE_FLOATS);
  readonly spots = new Float32Array(MAX_SPOTS * SPOT_FLOATS);
  primCount = 0;
  segCount = 0;
  apertureCount = 0;
  spotCount = 0;
  casterCount = 0;
  private voxel = 0.05;

  private prim(
    type: number, pos: Vec3, quat: THREE.Quaternion, size: [number, number, number, number],
    extra: [number, number, number, number], albedo: Vec3, op: number, emit: Vec3 = BLACK, flags = 0,
    color2: [number, number, number, number] = [0, 0, 0, 0], color3: Vec3 = BLACK,
  ) {
    if ((this.primCount + 1) * PRIM_FLOATS > this.prims.length) {
      const grown = new Float32Array(this.prims.length * 2);
      grown.set(this.prims);
      this.prims = grown;
    }
    const o = this.primCount * PRIM_FLOATS;
    const d = this.prims;
    // The shader needs world -> local, i.e. the conjugate.
    d.set([-quat.x, -quat.y, -quat.z, quat.w], o);
    d.set([pos[0], pos[1], pos[2], type], o + 4);
    d.set(size, o + 8);
    d.set(extra, o + 12);
    d.set([albedo[0], albedo[1], albedo[2], op], o + 16);
    d.set([emit[0], emit[1], emit[2], flags], o + 20);
    d.set(color2, o + 24);
    d.set([color3[0], color3[1], color3[2], 0], o + 28);
    this.primCount++;
  }

  private seg(a: THREE.Vector3, b: THREE.Vector3, radius: number, intensity: Vec3, normal: THREE.Vector3, aniso: number) {
    if ((this.segCount + 1) * SEG_FLOATS > this.segs.length) {
      const grown = new Float32Array(this.segs.length * 2);
      grown.set(this.segs);
      this.segs = grown;
    }
    this.segs.set([a.x, a.y, a.z, radius, b.x, b.y, b.z, aniso, intensity[0], intensity[1], intensity[2], 0, normal.x, normal.y, normal.z, 0], this.segCount * SEG_FLOATS);
    this.segCount++;
  }

  private room(room: Room, apertures: Aperture[]) {
    const [w, h, d] = room.size;
    _q.identity();
    this.prim(PRIM.shell, [0, h / 2, 0], _q, [w / 2, h / 2, d / 2, 0], [0, 0, 0, 0], diffuse(room.wall), OP.union, BLACK, 0,
      [...diffuse(room.floor), 0] as [number, number, number, number], diffuse(room.ceiling));
    this.apertureCount = 0;
    for (const a of apertures) {
      if (a.shutter >= 0.995 || this.apertureCount >= MAX_APERTURES) continue;
      const f = apertureFrame(room, a);
      // Carve from just inside the wall face to well beyond the GI domain.
      const depth = 1.2, k = depth / 2 - 0.02;
      const half: Vec3 = [0, 0, 0];
      for (let i = 0; i < 3; i++) half[i] = Math.abs(f.u[i]) * f.halfWidth + Math.abs(f.v[i]) * f.halfHeight + Math.abs(f.n[i]) * (depth / 2);
      this.prim(PRIM.box, [f.centre[0] + f.n[0] * k, f.centre[1] + f.n[1] * k, f.centre[2] + f.n[2] * k], _q, [half[0], half[1], half[2], 0], [0, 0, 0, 0], BLACK, OP.carveAll);
      this.apertures.set([
        f.centre[0], f.centre[1], f.centre[2], f.halfWidth,
        f.u[0], f.u[1], f.u[2], f.halfHeight,
        f.v[0], f.v[1], f.v[2], room.thickness,
        f.n[0], f.n[1], f.n[2], 0,
        // Glazing bars keep their place while the shutter comes down.
        a.cols, a.rows * (1 - a.shutter), a.frame > 0 ? a.frame / 2 : 0, 0,
      ], this.apertureCount * APERTURE_FLOATS);
      this.apertureCount++;
    }
  }

  private object(o: SceneObject, level: number) {
    if (!o.visible) return;
    _e.set(o.rotation[0], o.rotation[1], o.rotation[2], 'XYZ');
    _q.setFromEuler(_e);
    const h = this.voxel;
    const glow = (e?: { color: Vec3; luminance: number }) => (e ? scaled(e.color, e.luminance * level) : BLACK);
    const local = (x: number, y: number, z: number): Vec3 => {
      _v.set(x, y, z).applyQuaternion(_q);
      return [o.position[0] + _v.x, o.position[1] + _v.y, o.position[2] + _v.z];
    };
    switch (o.kind) {
      case 'slab':
        this.prim(PRIM.box, o.position, _q, [o.size[0] / 2, o.size[1] / 2, o.size[2] / 2, o.round], [0, 0, 0, 0], diffuse(o.surface), OP.union, glow(o.emission));
        break;
      case 'cylinder':
        this.prim(PRIM.cylinder, o.position, _q, [o.radius, o.height / 2, 0, o.round], [0, 0, 0, 0], diffuse(o.surface), OP.union, glow(o.emission));
        break;
      case 'sphere':
        this.prim(PRIM.sphere, o.position, _q, [o.radius, 0, 0, 0], [0, 0, 0, 0], diffuse(o.surface), OP.union, glow(o.emission));
        break;
      case 'curved':
        this.prim(PRIM.arc, o.position, _q, [o.radius, o.height / 2, o.thickness / 2, o.round], [o.angle / 2, 0, 0, 0], diffuse(o.surface), OP.union, glow(o.emission));
        break;
      case 'louvers':
        this.prim(PRIM.slats, o.position, _q, [o.size[0] / 2, o.size[1] / 2, o.size[2] / 2, 0.002], [o.pitch, o.slat / 2, o.tilt, 0], diffuse(o.surface), OP.union, glow(o.emission));
        break;
      case 'perforated':
        this.prim(PRIM.perforated, o.position, _q, [o.size[0] / 2, o.size[1] / 2, o.size[2] / 2, 0.004], [o.pitch, o.hole, 0, 0], diffuse(o.surface), OP.union, glow(o.emission));
        break;
      case 'arch': {
        const [w, hh, d] = o.size;
        const span = Math.min(o.span, w - 0.1), rise = Math.min(Math.max(o.rise, span / 2), hh - 0.05);
        const spring = -hh / 2 + rise - span / 2;
        this.prim(PRIM.box, o.position, _q, [w / 2, hh / 2, d / 2, 0.006], [0, 0, 0, 0], diffuse(o.surface), OP.union, glow(o.emission));
        this.prim(PRIM.box, local(0, (spring - hh / 2) / 2 - 0.05, 0), _q, [span / 2, (spring + hh / 2) / 2 + 0.05, d, 0], [0, 0, 0, 0], BLACK, OP.carveObject);
        _q2.setFromAxisAngle(_v.set(1, 0, 0), Math.PI / 2).premultiply(_q);
        this.prim(PRIM.cylinder, local(0, spring, 0), _q2, [span / 2, d, 0, 0], [0, 0, 0, 0], BLACK, OP.carveObject);
        break;
      }
      case 'folded': {
        for (const p of foldedPanels(o.panels, o.panelWidth, o.fold)) {
          _q2.setFromAxisAngle(_v.set(0, 1, 0), -p.yaw).premultiply(_q);
          this.prim(PRIM.box, local(p.x, 0, p.z), _q2, [o.panelWidth / 2 + o.thickness / 2, o.height / 2, o.thickness / 2, 0.006], [0, 0, 0, 0], diffuse(o.surface), OP.union, glow(o.emission));
        }
        break;
      }
      case 'emitter': {
        // The GI proxy is at least 1.6 voxels thick so that rays cannot step over it.
        const t = Math.max(0.03, 1.6 * h) / 2;
        const L = glow(o.emission);
        if (o.shape === 'rect') this.prim(PRIM.box, o.position, _q, [o.size[0] / 2, t, o.size[1] / 2, 0], [0, 0, 0, 0], BLACK, OP.union, L);
        else if (o.shape === 'disk') this.prim(PRIM.cylinder, o.position, _q, [o.size[0] / 2, t, 0, 0], [0, 0, 0, 0], BLACK, OP.union, L);
        else this.prim(PRIM.sphere, o.position, _q, [o.size[0] / 2, 0, 0, 0], [0, 0, 0, 0], BLACK, OP.union, L);
        break;
      }
      case 'decal':
        this.prim(PRIM.box, o.position, _q, [o.size[0] / 2, o.size[1] / 2, 0.8 * h, 0], [0, 0, 0, 0], BLACK, OP.union, glow(o.emission));
        break;
      case 'stroke': {
        if (level <= 0 || o.points.length < 2) break;
        _m.compose(_v.set(o.position[0], o.position[1], o.position[2]), _q, ONE);
        _n.set(o.normal[0], o.normal[1], o.normal[2]).normalize().applyQuaternion(_q);
        const L = glow(o.emission);
        // Intensity per unit length. Flat ribbon: I(w) = L * width * |n.w| per face, two faces
        // (one, at double strength, when it lies on a surface that hides the other half of
        // its density kernel). Round tube: I = L * diameter in every direction.
        const tube = o.profile === 'tube';
        const k = tube ? 1 : o.onSurface ? 1 : 0.5;
        const a = new THREE.Vector3(), b = new THREE.Vector3();
        const rMin = 1.5 * this.voxel * this.jDiv;
        for (let i = 0; i + 1 < o.points.length; i++) {
          const wd = (strokeWidth(o, i) + strokeWidth(o, i + 1)) / 2;
          if (wd <= 1e-4) continue;
          a.fromArray(o.points[i]).applyMatrix4(_m);
          b.fromArray(o.points[i + 1]).applyMatrix4(_m);
          this.seg(a, b, Math.max(wd / 2, rMin), scaled(L, wd * k), _n, tube ? 0 : 1);
        }
        break;
      }
      case 'spot': {
        if (this.spotCount >= MAX_SPOTS || level <= 0) break;
        const dir = _v.set(0, -1, 0).applyQuaternion(_q).clone();
        const right = _v.set(1, 0, 0).applyQuaternion(_q).clone();
        const up = _v.set(0, 0, 1).applyQuaternion(_q).clone();
        const tanH = Math.tan(Math.min(Math.max(o.spread, 0.05), 2.6) / 2);
        // Flux over the open beam's solid angle gives the intensity (klm / sr = kcd).
        const omega = 2 * Math.PI * (1 - Math.cos(Math.atan(tanH)));
        const I = scaled(o.color, (o.flux * level) / omega);
        this.spots.set([
          o.position[0], o.position[1], o.position[2], tanH,
          dir.x, dir.y, dir.z, o.softness,
          right.x, right.y, right.z, 0,
          up.x, up.y, up.z, 0,
          I[0], I[1], I[2], 0,
          1 - o.shutters[0], 1 - o.shutters[1], 1 - o.shutters[2], 1 - o.shutters[3],
        ], this.spotCount * SPOT_FLOATS);
        this.spotCount++;
        break;
      }
      case 'glass': {
        // Absorption coefficient per metre from the tint reached after `absorption` metres.
        const sigma: [number, number, number, number] = [
          -Math.log(Math.max(o.tint[0], 1e-3)) / Math.max(o.absorption, 1e-3),
          -Math.log(Math.max(o.tint[1], 1e-3)) / Math.max(o.absorption, 1e-3),
          -Math.log(Math.max(o.tint[2], 1e-3)) / Math.max(o.absorption, 1e-3),
          // Frost in the lower half of the range; the upper half marks a caustic caster, whose direct
          // sun the lighting pass leaves to the photons.
          Math.min(Math.max(o.frost, 0), 1) * 0.49 + (castsCaustics(o) && this.casterCount++ < MAX_CAUSTIC_OBJECTS ? 0.5 : 0),
        ];
        const [sx, sy, sz] = o.size;
        if (o.shape === 'slab') this.prim(PRIM.box, o.position, _q, [sx / 2, sy / 2, Math.max(sz / 2, 0.8 * h), 0.004], [0, 0, 0, 0], BLACK, OP.union, BLACK, 1, sigma);
        else if (o.shape === 'lens') this.prim(PRIM.lens, o.position, _q, [sx / 2, sz, 0, 0], [0, 0, 0, 0], BLACK, OP.union, BLACK, 1, sigma);
        else if (o.shape === 'prism') this.prim(PRIM.prism, o.position, _q, [sx, sy / 2, 0, 0], [0, 0, 0, 0], BLACK, OP.union, BLACK, 1, sigma);
        else this.prim(PRIM.cylinder, o.position, _q, [sx / 2, sy / 2, 0, 0.004], [0, 0, 0, 0], BLACK, OP.union, BLACK, 1, sigma);
        break;
      }
    }
  }

  private jDiv = 2;

  pack(room: Room, apertures: Aperture[], objects: { value: SceneObject; level: number }[], voxel: number, jDiv: number) {
    this.voxel = voxel;
    this.jDiv = jDiv;
    this.primCount = 0;
    this.segCount = 0;
    this.spotCount = 0;
    this.casterCount = 0;
    this.room(room, apertures);
    for (const e of objects) this.object(e.value, e.level);
  }
}

/** Panel centres and yaw of a folded screen, centred on the origin in the XZ plane. */
export function foldedPanels(n: number, width: number, fold: number): { x: number; z: number; yaw: number }[] {
  const out: { x: number; z: number; yaw: number }[] = [];
  let x = 0, z = 0;
  for (let i = 0; i < n; i++) {
    const yaw = (i % 2 === 0 ? 1 : -1) * fold / 2;
    const dx = Math.cos(yaw) * width, dz = Math.sin(yaw) * width;
    out.push({ x: x + dx / 2, z: z + dz / 2, yaw });
    x += dx; z += dz;
  }
  const cx = x / 2, cz = out.reduce((s, p) => s + p.z, 0) / n;
  return out.map((p) => ({ x: p.x - cx, z: p.z - cz, yaw: p.yaw }));
}
