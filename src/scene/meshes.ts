// Visible geometry. Every mesh is generated from the same parameters the voxeliser reads,
// so the rasterised scene and the GI proxy describe the same shapes.
import * as THREE from 'three/webgpu';
import { mrt, normalWorld, uniform, vec4 } from 'three/tsl';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Aperture, ArcObject, RibbonObject, Room, SceneObject, SlatsObject, Vec3 } from './types';

export interface SurfaceMaterial extends THREE.MeshBasicNodeMaterial {
  userData: { albedo: THREE.Vector3; emission: THREE.Vector3 };
}

/** G-buffer material: unlit albedo in the colour target, world normal and emitted radiance via MRT. */
export function surfaceMaterial(albedo: Vec3, emission: Vec3 = [0, 0, 0], side: THREE.Side = THREE.FrontSide): SurfaceMaterial {
  const m = new THREE.MeshBasicNodeMaterial() as SurfaceMaterial;
  const a = new THREE.Vector3(...albedo);
  const e = new THREE.Vector3(...emission);
  const ua = uniform(a);
  const ue = uniform(e);
  m.colorNode = vec4(ua, 1);
  m.mrtNode = mrt({ normal: vec4(normalWorld, 1), emissive: vec4(ue, 1) });
  m.side = side;
  m.userData = { albedo: a, emission: e };
  return m;
}

interface Hole { x0: number; x1: number; y0: number; y1: number }

/** A w x h wall centred on the origin with rectangular openings, as plain quads facing +Z. */
function wallGeometry(w: number, h: number, holes: Hole[]): THREE.BufferGeometry {
  const pos: number[] = [], idx: number[] = [];
  const quad = (x0: number, x1: number, y0: number, y1: number) => {
    if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4) return;
    const k = pos.length / 3;
    pos.push(x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  };
  const sorted = holes.map((o) => ({
    x0: Math.max(o.x0, -w / 2), x1: Math.min(o.x1, w / 2), y0: Math.max(o.y0, -h / 2), y1: Math.min(o.y1, h / 2),
  })).sort((p, q) => p.x0 - q.x0);
  let x = -w / 2;
  for (const o of sorted) {
    if (o.x0 < x) continue; // overlapping openings are ignored
    quad(x, o.x0, -h / 2, h / 2);
    quad(o.x0, o.x1, -h / 2, o.y0);
    quad(o.x0, o.x1, o.y1, h / 2);
    x = o.x1;
  }
  quad(x, w / 2, -h / 2, h / 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length / 3).fill([0, 0, 1]).flat(), 3));
  g.setIndex(idx);
  return g;
}

const FRAME_ALBEDO: Vec3 = [0.035, 0.035, 0.038];
const FRAME_DEPTH = 0.05;

/** Room interior: inward-facing surfaces only, so a camera outside the room sees straight in (cutaway). */
export function buildRoom(room: Room): THREE.Group {
  const [w, h, d] = room.size;
  const t = room.thickness;
  const g = new THREE.Group();
  g.name = 'room';
  const wallMat = surfaceMaterial(room.wall);
  const floorMat = surfaceMaterial(room.floor);
  const ceilMat = surfaceMaterial(room.ceiling);
  const frameMat = surfaceMaterial(FRAME_ALBEDO);

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, pos: Vec3, rot: Vec3) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    m.rotation.set(...rot);
    g.add(m);
    return m;
  };
  // Opening rectangles in each wall's local frame (x along the wall as seen from inside, y up).
  const holes = (wall: Aperture['wall'], sx: number, oy: number): Hole[] =>
    room.apertures.filter((a) => a.wall === wall).map((a) => ({
      x0: sx * a.u - a.width / 2, x1: sx * a.u + a.width / 2, y0: a.v - oy - a.height / 2, y1: a.v - oy + a.height / 2,
    }));

  add(new THREE.PlaneGeometry(w, d), floorMat, [0, 0, 0], [-Math.PI / 2, 0, 0]);
  add(wallGeometry(w, d, holes('ceiling', 1, 0)), ceilMat, [0, h, 0], [Math.PI / 2, 0, 0]);
  add(wallGeometry(w, h, holes('z-', 1, h / 2)), wallMat, [0, h / 2, -d / 2], [0, 0, 0]);
  add(wallGeometry(w, h, holes('z+', -1, h / 2)), wallMat, [0, h / 2, d / 2], [0, Math.PI, 0]);
  add(wallGeometry(d, h, holes('x-', -1, h / 2)), wallMat, [-w / 2, h / 2, 0], [0, Math.PI / 2, 0]);
  add(wallGeometry(d, h, holes('x+', 1, h / 2)), wallMat, [w / 2, h / 2, 0], [0, -Math.PI / 2, 0]);

  // Each opening: the four reveal faces through the wall thickness, and its glazing bars.
  // Built for an opening in the XY plane whose tunnel runs towards -Z, then oriented per wall.
  for (const a of room.apertures) {
    const o = new THREE.Group();
    const quad = (qw: number, qh: number, pos: Vec3, rot: Vec3) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(qw, qh), wallMat);
      m.position.set(...pos); m.rotation.set(...rot);
      o.add(m);
    };
    quad(t, a.height, [-a.width / 2, 0, -t / 2], [0, Math.PI / 2, 0]);
    quad(t, a.height, [a.width / 2, 0, -t / 2], [0, -Math.PI / 2, 0]);
    quad(a.width, t, [0, -a.height / 2, -t / 2], [-Math.PI / 2, 0, 0]);
    quad(a.width, t, [0, a.height / 2, -t / 2], [Math.PI / 2, 0, 0]);
    if (a.frame > 0) {
      const bar = (bw: number, bh: number, x: number, y: number) => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, FRAME_DEPTH), frameMat);
        m.position.set(x, y, -t / 2);
        o.add(m);
      };
      const f = a.frame;
      bar(f, a.height, -a.width / 2 + f / 2, 0);
      bar(f, a.height, a.width / 2 - f / 2, 0);
      bar(a.width, f, 0, -a.height / 2 + f / 2);
      bar(a.width, f, 0, a.height / 2 - f / 2);
      for (let i = 1; i < a.cols; i++) bar(f, a.height, -a.width / 2 + (i * a.width) / a.cols, 0);
      for (let j = 1; j < a.rows; j++) bar(a.width, f, 0, -a.height / 2 + (j * a.height) / a.rows);
    }
    switch (a.wall) {
      case 'z-': o.position.set(a.u, a.v, -d / 2); break;
      case 'z+': o.position.set(a.u, a.v, d / 2); o.rotation.y = Math.PI; break;
      case 'x-': o.position.set(-w / 2, a.v, a.u); o.rotation.y = Math.PI / 2; break;
      case 'x+': o.position.set(w / 2, a.v, a.u); o.rotation.y = -Math.PI / 2; break;
      case 'ceiling': o.position.set(a.u, h, a.v); o.rotation.x = Math.PI / 2; break;
    }
    g.add(o);
  }
  return g;
}

function arcGeometry(o: ArcObject): THREE.BufferGeometry {
  const ht = o.thickness / 2;
  const r = Math.min(o.round, ht * 0.9);
  const a = o.angle / 2;
  const R = o.radius;
  const hi = ht - r;
  // 2D outline in (x, z); a point at angle phi from +Z and radius rho is (rho sin phi, rho cos phi).
  const s = new THREE.Shape();
  const alpha = (phi: number) => Math.PI / 2 - phi;
  const cx = (phi: number) => R * Math.sin(phi);
  const cy = (phi: number) => R * Math.cos(phi);
  s.absarc(0, 0, R + hi, alpha(-a), alpha(a), true);
  s.absarc(cx(a), cy(a), hi, alpha(a), alpha(a) - Math.PI, true);
  s.absarc(0, 0, R - hi, alpha(a), alpha(-a), false);
  s.absarc(cx(-a), cy(-a), hi, alpha(-a) + Math.PI, alpha(-a), true);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: o.height - 2 * r, bevelEnabled: r > 1e-4, bevelThickness: r, bevelSize: r, bevelOffset: 0,
    bevelSegments: 3, curveSegments: Math.max(24, Math.round(o.angle * R * 28)),
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, o.height / 2 - r, 0);
  return geo;
}

function slatsGeometry(o: SlatsObject): THREE.BufferGeometry {
  const n = Math.max(Math.floor(o.size[0] / o.pitch), 1);
  const span = n * o.pitch;
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const b = new RoundedBoxGeometry(o.slatThickness, o.size[1], o.size[2], 2, Math.min(0.004, o.slatThickness * 0.4));
    b.rotateY(o.tilt);
    b.translate((i + 0.5) * o.pitch - span / 2, 0, 0);
    parts.push(b);
  }
  return mergeGeometries(parts);
}

function mergeGeometries(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let vCount = 0, iCount = 0;
  for (const p of parts) { vCount += p.attributes.position.count; iCount += p.index ? p.index.count : p.attributes.position.count; }
  const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array as Float32Array, vo * 3);
    nor.set(p.attributes.normal.array as Float32Array, vo * 3);
    const n = p.attributes.position.count;
    if (p.index) { for (let i = 0; i < p.index.count; i++) idx[io + i] = p.index.getX(i) + vo; io += p.index.count; }
    else { for (let i = 0; i < n; i++) idx[io + i] = i + vo; io += n; }
    vo += n;
    p.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function ribbonGeometry(o: RibbonObject): THREE.BufferGeometry {
  const pts = o.points.map((p) => new THREE.Vector3(...p));
  const n = new THREE.Vector3(...o.normal).normalize();
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const tan = new THREE.Vector3(), side = new THREE.Vector3();
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
    tan.subVectors(b, a).normalize();
    side.crossVectors(tan, n).normalize().multiplyScalar(o.width / 2);
    const p = pts[i];
    pos.push(p.x - side.x, p.y - side.y, p.z - side.z, p.x + side.x, p.y + side.y, p.z + side.z);
    nor.push(n.x, n.y, n.z, n.x, n.y, n.z);
    if (i + 1 < pts.length) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

function roundedCylinder(radius: number, height: number, round: number): THREE.BufferGeometry {
  const r = Math.min(round, radius * 0.9, height * 0.45);
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -height / 2)];
  const seg = 6;
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI / 2;
    pts.push(new THREE.Vector2(radius - r + r * Math.sin(t), -height / 2 + r - r * Math.cos(t)));
  }
  for (let i = 0; i <= seg; i++) {
    const t = (i / seg) * Math.PI / 2;
    pts.push(new THREE.Vector2(radius - r + r * Math.cos(t), height / 2 - r + r * Math.sin(t)));
  }
  pts.push(new THREE.Vector2(0, height / 2));
  return new THREE.LatheGeometry(pts, 64);
}

export function buildObjectGeometry(o: SceneObject): THREE.BufferGeometry {
  switch (o.kind) {
    case 'box': return new RoundedBoxGeometry(o.size[0], o.size[1], o.size[2], 4, Math.min(o.round, Math.min(...o.size) * 0.49));
    case 'cylinder': return roundedCylinder(o.radius, o.height, o.round);
    case 'sphere': return new THREE.SphereGeometry(o.radius, 48, 32);
    case 'arc': return arcGeometry(o);
    case 'slats': return slatsGeometry(o);
    case 'ribbon': return ribbonGeometry(o);
  }
}

export function buildObject(o: SceneObject): THREE.Mesh {
  const isRibbon = o.kind === 'ribbon';
  const mat = surfaceMaterial(isRibbon ? [0, 0, 0] : o.albedo, o.emission ?? [0, 0, 0], isRibbon ? THREE.DoubleSide : THREE.FrontSide);
  const m = new THREE.Mesh(buildObjectGeometry(o), mat);
  m.name = o.id;
  return m;
}
