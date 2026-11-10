// Visible geometry. Every mesh is generated from the same parameters the voxeliser reads,
// so the rasterised scene and the GI proxy describe the same shapes.
import * as THREE from 'three/webgpu';
import { mrt, normalWorld, uniform, vec4 } from 'three/tsl';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { apertureFrame, foldedPanels, strokeWidth } from './pack';
import type {
  Aperture, ArchObject, CurvedObject, FoldedObject, GlassObject, LouversObject, PerforatedObject, Room, SceneObject,
  StrokeObject, Surface, Vec3,
} from './types';

export interface SurfaceMaterial extends THREE.MeshBasicNodeMaterial {
  userData: { color: THREE.Vector3; emission: THREE.Vector3; params: THREE.Vector2 };
}

/**
 * G-buffer material: base colour in the colour target; world normal + roughness and emitted
 * radiance + metalness through MRT. Lighting happens later, in compute.
 */
export function surfaceMaterial(s: Surface, emission: Vec3 = [0, 0, 0], side: THREE.Side = THREE.FrontSide): SurfaceMaterial {
  const m = new THREE.MeshBasicNodeMaterial() as SurfaceMaterial;
  const color = new THREE.Vector3(...s.color);
  const em = new THREE.Vector3(...emission);
  const params = new THREE.Vector2(s.roughness, s.metal);
  const up = uniform(params);
  m.colorNode = vec4(uniform(color), 1);
  m.mrtNode = mrt({ normal: vec4(normalWorld, up.x), emissive: vec4(uniform(em), up.y) });
  m.side = side;
  m.userData = { color, emission: em, params };
  return m;
}

export function setSurface(m: SurfaceMaterial, s: Surface, emission: Vec3) {
  m.userData.color.set(s.color[0], s.color[1], s.color[2]);
  m.userData.emission.set(emission[0], emission[1], emission[2]);
  m.userData.params.set(s.roughness, s.metal);
}

const BLACK: Surface = { color: [0, 0, 0], roughness: 0.9, metal: 0 };
const FRAME: Surface = { color: [0.035, 0.035, 0.038], roughness: 0.5, metal: 0 };
const BLIND: Surface = { color: [0.55, 0.53, 0.5], roughness: 0.95, metal: 0 };
const FIXTURE: Surface = { color: [0.05, 0.05, 0.055], roughness: 0.45, metal: 1 };
const FRAME_DEPTH = 0.05;

// ---------------------------------------------------------------------------------------------
// Room

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
  const nor = new Float32Array(pos.length);
  for (let i = 2; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

export interface RoomMeshes {
  group: THREE.Group;
  /** One blind per opening; scaled by the shutter position every frame. */
  blinds: Map<string, THREE.Mesh>;
  /** The surface a point on a wall, floor or ceiling mesh belongs to. */
  materials: { wall: SurfaceMaterial; floor: SurfaceMaterial; ceiling: SurfaceMaterial };
}

/** Room interior: inward-facing surfaces only, so a camera outside the room sees straight in (cutaway). */
export function buildRoom(room: Room): RoomMeshes {
  const [w, h, d] = room.size;
  const t = room.thickness;
  const g = new THREE.Group();
  g.name = 'room';
  const wallMat = surfaceMaterial(room.wall);
  const floorMat = surfaceMaterial(room.floor);
  const ceilMat = surfaceMaterial(room.ceiling);
  const frameMat = surfaceMaterial(FRAME);
  const blindMat = surfaceMaterial(BLIND, [0, 0, 0], THREE.DoubleSide);
  const blinds = new Map<string, THREE.Mesh>();

  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, pos: Vec3, rot: Vec3, name: string) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos);
    m.rotation.set(...rot);
    m.name = name;
    g.add(m);
    return m;
  };
  // Opening rectangles in each wall's local frame (x along the wall as seen from inside, y up).
  const holes = (wall: Aperture['wall'], sx: number, oy: number): Hole[] =>
    room.apertures.filter((a) => a.wall === wall).map((a) => ({
      x0: sx * a.u - a.width / 2, x1: sx * a.u + a.width / 2, y0: a.v - oy - a.height / 2, y1: a.v - oy + a.height / 2,
    }));

  add(new THREE.PlaneGeometry(w, d), floorMat, [0, 0, 0], [-Math.PI / 2, 0, 0], 'floor');
  add(wallGeometry(w, d, holes('ceiling', 1, 0)), ceilMat, [0, h, 0], [Math.PI / 2, 0, 0], 'ceiling');
  add(wallGeometry(w, h, holes('z-', 1, h / 2)), wallMat, [0, h / 2, -d / 2], [0, 0, 0], 'wall');
  add(wallGeometry(w, h, holes('z+', -1, h / 2)), wallMat, [0, h / 2, d / 2], [0, Math.PI, 0], 'wall');
  add(wallGeometry(d, h, holes('x-', -1, h / 2)), wallMat, [-w / 2, h / 2, 0], [0, Math.PI / 2, 0], 'wall');
  add(wallGeometry(d, h, holes('x+', 1, h / 2)), wallMat, [w / 2, h / 2, 0], [0, -Math.PI / 2, 0], 'wall');

  // Each opening: the four reveal faces through the wall thickness, its glazing bars, a blind.
  // Built for an opening in the XY plane whose tunnel runs towards -Z, then oriented per wall.
  for (const a of room.apertures) {
    const o = new THREE.Group();
    o.name = a.id;
    const quad = (qw: number, qh: number, pos: Vec3, rot: Vec3) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(qw, qh), wallMat);
      m.position.set(...pos); m.rotation.set(...rot);
      m.name = 'wall';
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
    // The blind hangs from the top edge, just outside the glazing bars.
    const blindGeo = new THREE.PlaneGeometry(a.width, a.height);
    blindGeo.translate(0, -a.height / 2, 0);
    const blind = new THREE.Mesh(blindGeo, blindMat);
    blind.position.set(0, a.height / 2, -t / 2 - FRAME_DEPTH);
    blind.scale.y = Math.max(a.shutter, 1e-4);
    blind.visible = a.shutter > 0.001;
    o.add(blind);
    blinds.set(a.id, blind);
    switch (a.wall) {
      case 'z-': o.position.set(a.u, a.v, -d / 2); break;
      case 'z+': o.position.set(a.u, a.v, d / 2); o.rotation.y = Math.PI; break;
      case 'x-': o.position.set(-w / 2, a.v, a.u); o.rotation.y = Math.PI / 2; break;
      case 'x+': o.position.set(w / 2, a.v, a.u); o.rotation.y = -Math.PI / 2; break;
      case 'ceiling': o.position.set(a.u, h, a.v); o.rotation.x = Math.PI / 2; break;
    }
    g.add(o);
  }
  return { group: g, blinds, materials: { wall: wallMat, floor: floorMat, ceiling: ceilMat } };
}

/** World-space outline of an opening, for selection highlights. */
export function apertureOutline(room: Room, a: Aperture): Vec3[] {
  const f = apertureFrame(room, a, false);
  const p = (su: number, sv: number): Vec3 => [
    f.centre[0] + f.u[0] * su * f.halfWidth + f.v[0] * sv * f.halfHeight - f.n[0] * 0.01,
    f.centre[1] + f.u[1] * su * f.halfWidth + f.v[1] * sv * f.halfHeight - f.n[1] * 0.01,
    f.centre[2] + f.u[2] * su * f.halfWidth + f.v[2] * sv * f.halfHeight - f.n[2] * 0.01,
  ];
  return [p(-1, -1), p(1, -1), p(1, 1), p(-1, 1), p(-1, -1)];
}

// ---------------------------------------------------------------------------------------------
// Object geometry

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

function roundedBox(w: number, h: number, d: number, r: number) {
  return new RoundedBoxGeometry(w, h, d, 3, Math.max(Math.min(r, Math.min(w, h, d) * 0.49), 0.0005));
}

function roundedCylinder(radius: number, height: number, round: number): THREE.BufferGeometry {
  const r = Math.max(Math.min(round, radius * 0.9, height * 0.45), 0.0005);
  const pts: THREE.Vector2[] = [new THREE.Vector2(0, -height / 2)];
  const seg = 5;
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

function arcGeometry(o: CurvedObject): THREE.BufferGeometry {
  const ht = o.thickness / 2;
  const r = Math.min(o.round, ht * 0.9);
  const a = o.angle / 2;
  const R = o.radius;
  const hi = ht - r;
  // 2D outline in (x, z); a point at angle phi from +Z and radius rho is (rho sin phi, rho cos phi).
  const s = new THREE.Shape();
  const alpha = (phi: number) => Math.PI / 2 - phi;
  s.absarc(0, 0, R + hi, alpha(-a), alpha(a), true);
  s.absarc(R * Math.sin(a), R * Math.cos(a), hi, alpha(a), alpha(a) - Math.PI, true);
  s.absarc(0, 0, R - hi, alpha(a), alpha(-a), false);
  s.absarc(R * Math.sin(-a), R * Math.cos(-a), hi, alpha(-a) + Math.PI, alpha(-a), true);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: o.height - 2 * r, bevelEnabled: r > 1e-4, bevelThickness: r, bevelSize: r, bevelOffset: 0,
    bevelSegments: 3, curveSegments: Math.max(24, Math.round(o.angle * R * 28)),
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, o.height / 2 - r, 0);
  return geo;
}

function archGeometry(o: ArchObject): THREE.BufferGeometry {
  const [w, h, d] = o.size;
  const span = Math.min(o.span, w - 0.1), rise = Math.min(Math.max(o.rise, span / 2), h - 0.05);
  const spring = -h / 2 + rise - span / 2;
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -h / 2);
  s.lineTo(-span / 2, -h / 2);
  s.lineTo(-span / 2, spring);
  s.absarc(0, spring, span / 2, Math.PI, 0, true);
  s.lineTo(span / 2, -h / 2);
  s.lineTo(w / 2, -h / 2);
  s.lineTo(w / 2, h / 2);
  s.lineTo(-w / 2, h / 2);
  s.closePath();
  const geo = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 32 });
  geo.translate(0, 0, -d / 2);
  return geo;
}

function foldedGeometry(o: FoldedObject): THREE.BufferGeometry {
  return mergeGeometries(foldedPanels(o.panels, o.panelWidth, o.fold).map((p) => {
    const b = roundedBox(o.panelWidth + o.thickness, o.height, o.thickness, 0.006);
    b.rotateY(-p.yaw);
    b.translate(p.x, 0, p.z);
    return b;
  }));
}

function perforatedGeometry(o: PerforatedObject): THREE.BufferGeometry {
  const [w, h, d] = o.size;
  const s = new THREE.Shape();
  s.moveTo(-w / 2, -h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(w / 2, h / 2); s.lineTo(-w / 2, h / 2); s.closePath();
  const nx = Math.max(Math.floor((w / 2 - (o.hole + 0.25 * o.pitch)) / o.pitch), 0);
  const ny = Math.max(Math.floor((h / 2 - (o.hole + 0.25 * o.pitch)) / o.pitch), 0);
  for (let i = -nx; i <= nx; i++) for (let j = -ny; j <= ny; j++) {
    const c = new THREE.Path();
    c.absarc(i * o.pitch, j * o.pitch, o.hole, 0, Math.PI * 2, true);
    s.holes.push(c);
  }
  const geo = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 20 });
  geo.translate(0, 0, -d / 2);
  return geo;
}

function louversGeometry(o: LouversObject): THREE.BufferGeometry {
  const n = Math.max(Math.floor(o.size[0] / o.pitch), 1);
  const span = n * o.pitch;
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const b = roundedBox(o.slat, o.size[1], o.size[2], 0.004);
    b.rotateY(o.tilt);
    b.translate((i + 0.5) * o.pitch - span / 2, 0, 0);
    parts.push(b);
  }
  return mergeGeometries(parts);
}

function strokeGeometry(o: StrokeObject): THREE.BufferGeometry {
  const pts = o.points.map((p) => new THREE.Vector3(...p));
  const n = new THREE.Vector3(...o.normal).normalize();
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const tan = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3();
  if (pts.length < 2) return new THREE.BufferGeometry();
  const ring = o.profile === 'tube' ? 8 : 2;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
    tan.subVectors(b, a).normalize();
    side.crossVectors(tan, n);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    up.crossVectors(side, tan).normalize();
    const hw = strokeWidth(o, i) / 2;
    const p = pts[i];
    if (ring === 2) {
      pos.push(p.x - side.x * hw, p.y - side.y * hw, p.z - side.z * hw, p.x + side.x * hw, p.y + side.y * hw, p.z + side.z * hw);
      nor.push(n.x, n.y, n.z, n.x, n.y, n.z);
      if (i + 1 < pts.length) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    } else {
      for (let j = 0; j < ring; j++) {
        const t = (j / ring) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
        const nx = side.x * c + up.x * s, ny = side.y * c + up.y * s, nz = side.z * c + up.z * s;
        pos.push(p.x + nx * hw, p.y + ny * hw, p.z + nz * hw);
        nor.push(nx, ny, nz);
      }
      if (i + 1 < pts.length) for (let j = 0; j < ring; j++) {
        const k = i * ring + j, k2 = i * ring + ((j + 1) % ring);
        idx.push(k, k2, k + ring, k2, k2 + ring, k + ring);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

function lensGeometry(a: number, t: number): THREE.BufferGeometry {
  const s = t / 2, R = (a * a + s * s) / (2 * s), c = R - s;
  const pts: THREE.Vector2[] = [];
  const seg = 24;
  const phi = Math.asin(Math.min(a / R, 1));
  // Lathe profile in (radius, axis): front cap from the pole to the rim, then the back cap.
  for (let i = 0; i <= seg; i++) { const p = (i / seg) * phi; pts.push(new THREE.Vector2(R * Math.sin(p), R * Math.cos(p) - c)); }
  for (let i = seg; i >= 0; i--) { const p = (i / seg) * phi; pts.push(new THREE.Vector2(R * Math.sin(p), -(R * Math.cos(p) - c))); }
  const g = new THREE.LatheGeometry(pts, 64);
  g.rotateX(Math.PI / 2); // lathe axis Y -> lens axis Z
  return g;
}

function prismGeometry(side: number, length: number): THREE.BufferGeometry {
  const k = Math.sqrt(3), r = side / 2;
  const s = new THREE.Shape();
  // Equilateral triangle in (x, z) with its centroid on the origin, flat face towards -z.
  s.moveTo(-r, -r / k); s.lineTo(r, -r / k); s.lineTo(0, (2 * r) / k); s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: length, bevelEnabled: false });
  g.translate(0, 0, -length / 2);
  g.rotateX(Math.PI / 2); // extrusion axis Z -> Y, shape y -> z
  return g;
}

/** Geometry of an object, in its local frame. Emitters, spots and glass included. */
export function buildGeometry(o: SceneObject): THREE.BufferGeometry {
  switch (o.kind) {
    case 'slab': return roundedBox(o.size[0], o.size[1], o.size[2], o.round);
    case 'cylinder': return roundedCylinder(o.radius, o.height, o.round);
    case 'sphere': return new THREE.SphereGeometry(o.radius, 48, 32);
    case 'arch': return archGeometry(o);
    case 'curved': return arcGeometry(o);
    case 'folded': return foldedGeometry(o);
    case 'perforated': return perforatedGeometry(o);
    case 'louvers': return louversGeometry(o);
    case 'emitter':
      if (o.shape === 'rect') return roundedBox(o.size[0], 0.03, o.size[1], 0.004);
      if (o.shape === 'disk') return new THREE.CylinderGeometry(o.size[0] / 2, o.size[0] / 2, 0.03, 64);
      return new THREE.SphereGeometry(o.size[0] / 2, 48, 32);
    case 'stroke': return strokeGeometry(o);
    case 'decal': { const g = new THREE.PlaneGeometry(o.size[0], o.size[1]); g.translate(0, 0, 0.003); return g; }
    case 'spot': {
      const body = new THREE.CylinderGeometry(0.05, 0.06, 0.16, 32, 1, true);
      body.translate(0, 0.08, 0);
      const cap = new THREE.CircleGeometry(0.05, 32);
      cap.rotateX(-Math.PI / 2);
      cap.translate(0, 0.16, 0);
      return mergeGeometries([body, cap]);
    }
    case 'glass':
      if (o.shape === 'slab') return roundedBox(o.size[0], o.size[1], o.size[2], 0.004);
      if (o.shape === 'lens') return lensGeometry(o.size[0] / 2, o.size[2]);
      if (o.shape === 'prism') return prismGeometry(o.size[0], o.size[1]);
      return roundedCylinder(o.size[0] / 2, o.size[1], 0.004);
  }
}

/** The fields that determine an object's geometry; a change in this key rebuilds the mesh. */
export function geometryKey(o: SceneObject): string {
  const { id, name, position, rotation, visible, motions, ...rest } = o as SceneObject & Record<string, unknown>;
  void id; void name; void position; void rotation; void visible; void motions;
  const shape = { ...rest } as Record<string, unknown>;
  for (const k of ['surface', 'emission', 'color', 'flux', 'spread', 'softness', 'shutters', 'ior', 'tint', 'absorption', 'frost', 'fluteDepth', 'fluteSpacing', 'dispersion', 'caustics', 'etch', 'fade', 'born']) delete shape[k];
  return JSON.stringify(shape);
}

/** Lens of a light aperture: a small luminous disc at the mouth of its housing. */
export function spotLensGeometry(): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(0.046, 32);
  g.rotateX(Math.PI / 2);
  g.translate(0, 0.002, 0);
  return g;
}

export const SURFACES = { BLACK, FIXTURE };

export function isGlass(o: SceneObject): o is GlassObject { return o.kind === 'glass'; }
