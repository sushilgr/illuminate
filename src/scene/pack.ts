// Packs the scene description into the GPU primitive / segment buffers read by the voxeliser.
import * as THREE from 'three/webgpu';
import { APERTURE_FLOATS, MAX_APERTURES, PRIM_FLOATS, SEG_FLOATS } from '../gi/GISystem';
import type { Aperture, Room, SceneDescription, SceneObject, Vec3 } from './types';

export const PRIM_TYPE = { shell: 0, box: 1, cylinder: 2, sphere: 3, arc: 4, slats: 5 } as const;

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();

export class ScenePacker {
  prims = new Float32Array(64 * PRIM_FLOATS);
  segs = new Float32Array(256 * SEG_FLOATS);
  primCount = 0;
  segCount = 0;

  private prim(
    type: number, pos: Vec3, rot: Vec3 | null, size: [number, number, number, number],
    extra: [number, number, number, number], albedo: Vec3, op: number, emission: Vec3 = [0, 0, 0],
    color2: Vec3 = [0, 0, 0], color3: Vec3 = [0, 0, 0],
  ) {
    if ((this.primCount + 1) * PRIM_FLOATS > this.prims.length) {
      const grown = new Float32Array(this.prims.length * 2);
      grown.set(this.prims);
      this.prims = grown;
    }
    const o = this.primCount * PRIM_FLOATS;
    const d = this.prims;
    if (rot) { _e.set(rot[0], rot[1], rot[2], 'XYZ'); _q.setFromEuler(_e).conjugate(); } else { _q.identity(); }
    d.set([_q.x, _q.y, _q.z, _q.w], o);
    d.set([pos[0], pos[1], pos[2], type], o + 4);
    d.set(size, o + 8);
    d.set(extra, o + 12);
    d.set([albedo[0], albedo[1], albedo[2], op], o + 16);
    d.set([emission[0], emission[1], emission[2], 0], o + 20);
    d.set([color2[0], color2[1], color2[2], 0], o + 24);
    d.set([color3[0], color3[1], color3[2], 0], o + 28);
    this.primCount++;
  }

  private seg(a: THREE.Vector3, b: THREE.Vector3, radius: number, intensity: Vec3, normal: THREE.Vector3, aniso: number) {
    if ((this.segCount + 1) * SEG_FLOATS > this.segs.length) {
      const grown = new Float32Array(this.segs.length * 2);
      grown.set(this.segs);
      this.segs = grown;
    }
    const o = this.segCount * SEG_FLOATS;
    this.segs.set([a.x, a.y, a.z, radius, b.x, b.y, b.z, aniso, intensity[0], intensity[1], intensity[2], 0, normal.x, normal.y, normal.z, 0], o);
    this.segCount++;
  }

  private room(room: Room) {
    const [w, h, d] = room.size;
    this.prim(PRIM_TYPE.shell, [0, h / 2, 0], null, [w / 2, h / 2, d / 2, 0], [0, 0, 0, 0], room.wall, 0, [0, 0, 0], room.floor, room.ceiling);
    for (const a of room.apertures) {
      const { centre, half } = apertureBox(room, a);
      this.prim(PRIM_TYPE.box, centre, null, [half[0], half[1], half[2], 0], [0, 0, 0, 0], room.wall, 1);
    }
  }

  private object(o: SceneObject, jRadiusMin: number) {
    if (o.visible === false) return;
    const em = o.emission ?? [0, 0, 0];
    switch (o.kind) {
      case 'box':
        this.prim(PRIM_TYPE.box, o.position, o.rotation, [o.size[0] / 2, o.size[1] / 2, o.size[2] / 2, o.round], [0, 0, 0, 0], o.albedo, 0, em);
        break;
      case 'cylinder':
        this.prim(PRIM_TYPE.cylinder, o.position, o.rotation, [o.radius, o.height / 2, 0, o.round], [0, 0, 0, 0], o.albedo, 0, em);
        break;
      case 'sphere':
        this.prim(PRIM_TYPE.sphere, o.position, o.rotation, [o.radius, 0, 0, 0], [0, 0, 0, 0], o.albedo, 0, em);
        break;
      case 'arc':
        this.prim(PRIM_TYPE.arc, o.position, o.rotation, [o.radius, o.height / 2, o.thickness / 2, o.round], [o.angle / 2, 0, 0, 0], o.albedo, 0, em);
        break;
      case 'slats':
        this.prim(PRIM_TYPE.slats, o.position, o.rotation, [o.size[0] / 2, o.size[1] / 2, o.size[2] / 2, 0.002], [o.pitch, o.slatThickness / 2, o.tilt, 0], o.albedo, 0, em);
        break;
      case 'ribbon': {
        if (o.level <= 0) break;
        _e.set(o.rotation[0], o.rotation[1], o.rotation[2], 'XYZ');
        _q.setFromEuler(_e);
        _m.compose(_v.set(o.position[0], o.position[1], o.position[2]), _q, new THREE.Vector3(1, 1, 1));
        _n.set(o.normal[0], o.normal[1], o.normal[2]).normalize().applyQuaternion(_q);
        // Two-sided Lambertian strip: I(w) = L * width * |n.w| = (L * width / 2) * 2|n.w|.
        const k = 0.5 * o.width * o.level;
        const I: Vec3 = [o.emission[0] * k, o.emission[1] * k, o.emission[2] * k];
        const radius = Math.max(o.width / 2, jRadiusMin);
        const a = new THREE.Vector3(), b = new THREE.Vector3();
        for (let i = 0; i + 1 < o.points.length; i++) {
          a.fromArray(o.points[i]).applyMatrix4(_m);
          b.fromArray(o.points[i + 1]).applyMatrix4(_m);
          this.seg(a, b, radius, I, _n, 1);
        }
        break;
      }
    }
  }

  pack(scene: SceneDescription, jRadiusMin: number) {
    this.primCount = 0;
    this.segCount = 0;
    this.room(scene.room);
    for (const o of scene.objects) this.object(o, jRadiusMin);
  }
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

export function apertureFrame(room: Room, a: Aperture): ApertureFrame {
  const [w, h, d] = room.size;
  const hw = a.width / 2, hh = a.height / 2;
  switch (a.wall) {
    case 'x-': return { centre: [-w / 2, a.v, a.u], u: [0, 0, 1], v: [0, 1, 0], n: [-1, 0, 0], halfWidth: hw, halfHeight: hh };
    case 'x+': return { centre: [w / 2, a.v, a.u], u: [0, 0, 1], v: [0, 1, 0], n: [1, 0, 0], halfWidth: hw, halfHeight: hh };
    case 'z-': return { centre: [a.u, a.v, -d / 2], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, -1], halfWidth: hw, halfHeight: hh };
    case 'z+': return { centre: [a.u, a.v, d / 2], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1], halfWidth: hw, halfHeight: hh };
    case 'ceiling': return { centre: [a.u, h, a.v], u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0], halfWidth: hw, halfHeight: hh };
  }
}

/** World-space box carved out of the wall for an opening (it runs on beyond the GI domain). */
export function apertureBox(room: Room, a: Aperture): { centre: Vec3; half: Vec3 } {
  const f = apertureFrame(room, a);
  const depth = 1.2, inset = 0.02;
  const k = depth / 2 - inset;
  const centre: Vec3 = [f.centre[0] + f.n[0] * k, f.centre[1] + f.n[1] * k, f.centre[2] + f.n[2] * k];
  const half: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) half[i] = Math.abs(f.u[i]) * f.halfWidth + Math.abs(f.v[i]) * f.halfHeight + Math.abs(f.n[i]) * (depth / 2);
  return { centre, half };
}

/** Packs the openings for the analytic sun test (see the Aperture struct in structs.wgsl). */
export function packApertures(room: Room, out: Float32Array): number {
  const n = Math.min(room.apertures.length, MAX_APERTURES);
  for (let i = 0; i < n; i++) {
    const a = room.apertures[i];
    const f = apertureFrame(room, a);
    out.set([
      f.centre[0], f.centre[1], f.centre[2], f.halfWidth,
      f.u[0], f.u[1], f.u[2], f.halfHeight,
      f.v[0], f.v[1], f.v[2], room.thickness,
      f.n[0], f.n[1], f.n[2], 0,
      a.cols, a.rows, a.cols > 1 || a.rows > 1 || a.frame > 0 ? a.frame / 2 : 0, 0,
    ], i * APERTURE_FLOATS);
  }
  return n;
}
