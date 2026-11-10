// Pointer tools on the viewport: selection and transforms, light painting, erasing,
// frost etching and the light meter. Navigation is a separate mode (and the right mouse
// button or two fingers in every mode), so painting and camera movement never collide.
import * as THREE from 'three/webgpu';
import type { App } from '../app/App';
import { emission, motion, uid } from '../scene/library';
import { apertureFrame } from '../scene/pack';
import { decodeEtch, encodeEtch } from '../scene/SceneRuntime';
import type { GlassObject, SceneObject, StrokeObject, Vec3 } from '../scene/types';
import { Overlay } from './Overlay';

export type Mode = 'select' | 'navigate' | 'paint' | 'erase' | 'etch' | 'meter';
export type Transform = 'move' | 'rotate' | 'scale';

export interface Brush {
  profile: 'ribbon' | 'tube';
  width: number;
  color: Vec3;
  luminance: number;
  taper: number;
  /** 0 ignores pen pressure, 1 follows it fully. */
  pressure: number;
  smoothing: number;
  /** Paint on the surface under the pointer, or on a level construction plane. */
  target: 'surface' | 'level';
  elevation: number;
  /** Distance kept from the surface. */
  offset: number;
  /** Seconds until the stroke has faded out; 0 keeps it. */
  fade: number;
  /** Record the gesture as a motion path for the selected object instead of a stroke. */
  record: boolean;
  /** Etch brush radius in metres. */
  etchRadius: number;
}

export interface MeterReading { x: number; y: number; illuminance: Vec3; position: Vec3 }

interface Hit { point: THREE.Vector3; normal: THREE.Vector3; id: string | null; object: THREE.Object3D }

const MAX_STROKE_POINTS = 72;
const ETCH = 64;

export class Tools {
  mode: Mode = 'select';
  transform: Transform = 'move';
  brush: Brush = {
    profile: 'ribbon', width: 0.05, color: [1, 0.62, 0.3], luminance: 120, taper: 0.5, pressure: 0.8, smoothing: 0.5,
    target: 'surface', elevation: 1.2, offset: 0.02, fade: 0, record: false, etchRadius: 0.07,
  };
  meter: MeterReading | null = null;
  readonly overlay: Overlay;
  /** Fired when mode, transform or the meter reading changes. */
  readonly onChange = new Set<() => void>();

  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private drag: null | {
    kind: 'transform' | 'paint' | 'etch' | 'click';
    id?: string;
    start: THREE.Vector2;
    startPoint?: THREE.Vector3;
    plane?: THREE.Plane;
    snapshot?: SceneObject;
    moved: boolean;
    world?: THREE.Vector3[];
    pressures?: number[];
    normals?: THREE.Vector3[];
    filtered?: THREE.Vector3;
    onSurface?: boolean;
    mask?: Uint8Array;
    restore?: boolean;
  } = null;
  private meterBusy = false;
  private meterAt = 0;

  constructor(private readonly app: App) {
    this.overlay = new Overlay(app);
    const el = app.three.domElement;
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e));
    el.addEventListener('pointerleave', () => { this.overlay.cursor(null); if (this.meter) { this.meter = null; this.emit(); } });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    this.setMode('select');
    app.onFrame.add(() => this.overlay.update(this));
  }

  private emit() { for (const fn of this.onChange) fn(); }

  setMode(mode: Mode) {
    this.mode = mode;
    const c = this.app.controls;
    const M = THREE.MOUSE, T = THREE.TOUCH;
    if (mode === 'navigate') {
      c.mouseButtons = { LEFT: M.ROTATE, MIDDLE: M.DOLLY, RIGHT: M.PAN };
      c.touches = { ONE: T.ROTATE, TWO: T.DOLLY_PAN };
    } else {
      // The primary button and a single finger belong to the tool.
      c.mouseButtons = { LEFT: null as unknown as THREE.MOUSE, MIDDLE: M.PAN, RIGHT: M.ROTATE };
      c.touches = { ONE: null as unknown as THREE.TOUCH, TWO: T.DOLLY_PAN };
    }
    this.app.three.domElement.dataset.mode = mode;
    this.meter = null;
    this.emit();
  }

  setTransform(t: Transform) { this.transform = t; this.emit(); }

  // --- picking ---------------------------------------------------------------------------------

  private setRay(e: PointerEvent) {
    const r = this.app.three.domElement.getBoundingClientRect();
    this.ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.app.camera);
  }

  /** Nearest surface under the pointer. `objectsOnly` skips the room. */
  private pick(objectsOnly = false, glassOnly = false): Hit | null {
    const rt = this.app.runtime;
    const targets: THREE.Object3D[] = glassOnly
      ? [...rt.entries.values()].filter((e) => e.glass).map((e) => e.mesh)
      : objectsOnly ? rt.pickables() : [...rt.pickables(), rt.room.group];
    const hits = this.ray.intersectObjects(targets, true);
    for (const h of hits) {
      if (!h.face || !h.object.visible) continue;
      const normal = h.face.normal.clone().transformDirection(h.object.matrixWorld);
      if (normal.dot(this.ray.ray.direction) > 0) normal.negate();
      let o: THREE.Object3D | null = h.object;
      let id: string | null = null;
      while (o) { if (rt.entries.has(o.name)) { id = o.name; break; } o = o.parent; }
      return { point: h.point.clone(), normal, id, object: h.object };
    }
    return null;
  }

  /** The opening the pointer ray passes through, if any, and how far along the ray. */
  private pickAperture(): { id: string; t: number } | null {
    const room = this.app.doc.scene.room;
    const { origin, direction } = this.ray.ray;
    let best: { id: string; t: number } | null = null;
    for (const a of room.apertures) {
      const f = apertureFrame(room, a, false);
      const n = new THREE.Vector3(...f.n), c = new THREE.Vector3(...f.centre);
      const dn = direction.dot(n);
      if (Math.abs(dn) < 1e-4) continue;
      const t = c.clone().sub(origin).dot(n) / dn;
      if (t <= 0) continue;
      const rel = origin.clone().addScaledVector(direction, t).sub(c);
      if (Math.abs(rel.dot(new THREE.Vector3(...f.u))) <= f.halfWidth && Math.abs(rel.dot(new THREE.Vector3(...f.v))) <= f.halfHeight && (!best || t < best.t)) best = { id: a.id, t };
    }
    return best;
  }

  private levelPoint(elevation: number): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -elevation), p) ? p : null;
  }

  // --- pointer ---------------------------------------------------------------------------------

  private down(e: PointerEvent) {
    if (e.button !== 0 || this.mode === 'navigate') return;
    const el = this.app.three.domElement;
    el.setPointerCapture(e.pointerId);
    this.setRay(e);
    const start = new THREE.Vector2(e.clientX, e.clientY);
    const doc = this.app.doc;
    if (this.mode === 'select') {
      const hit = this.pick(true);
      if (hit?.id) {
        if (doc.selection.type !== 'object' || doc.selection.id !== hit.id) doc.select({ type: 'object', id: hit.id });
        let id = hit.id;
        if (e.altKey) id = this.duplicate(hit.id) ?? id;
        const o = doc.object(id)!;
        const normal = e.shiftKey ? this.app.camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize().negate() : new THREE.Vector3(0, 1, 0);
        const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point);
        this.drag = { kind: 'transform', id, start, plane, startPoint: hit.point.clone(), snapshot: structuredClone(o), moved: false };
      } else {
        this.drag = { kind: 'click', start, moved: false };
      }
    } else if (this.mode === 'paint') {
      this.beginStroke(e, start);
    } else if (this.mode === 'erase') {
      const hit = this.pick(true);
      if (hit?.id) this.remove(hit.id);
    } else if (this.mode === 'etch') {
      const hit = this.pick(false, true);
      const o = hit?.id ? doc.object(hit.id) : undefined;
      if (o && o.kind === 'glass' && o.shape === 'slab') {
        this.drag = { kind: 'etch', id: o.id, start, moved: true, mask: decodeEtch(o.etch) ?? new Uint8Array(ETCH * ETCH), restore: e.altKey };
        this.etchAt(hit!.point);
      }
    }
  }

  private move(e: PointerEvent) {
    this.setRay(e);
    const d = this.drag;
    if (!d) { this.hover(e); return; }
    if (!d.moved && d.start.distanceTo(new THREE.Vector2(e.clientX, e.clientY)) > 3) d.moved = true;
    if (d.kind === 'transform' && d.moved) this.transformDrag(e);
    else if (d.kind === 'paint') this.extendStroke(e);
    else if (d.kind === 'etch') { const hit = this.pick(false, true); if (hit && hit.id === d.id) this.etchAt(hit.point); }
  }

  private up(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    const el = this.app.three.domElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    if (!d) return;
    const doc = this.app.doc;
    if (d.kind === 'click' && !d.moved) {
      // Empty space: an opening if the ray goes through one, else clear the selection.
      this.setRay(e);
      const ap = this.pickAperture();
      const surface = this.pick();
      if (ap && (!surface || surface.point.distanceTo(this.ray.ray.origin) > ap.t - 0.3)) doc.select({ type: 'aperture', id: ap.id });
      else doc.select({ type: 'none' });
    } else if (d.kind === 'paint') {
      this.finishing = d;
      this.finishStroke();
    }
    doc.commit();
  }

  private hover(e: PointerEvent) {
    if (this.mode === 'navigate' || this.mode === 'select') { this.overlay.cursor(null); return; }
    const level = this.mode === 'paint' && this.brush.target === 'level';
    const hit = level ? null : this.pick(this.mode === 'erase', this.mode === 'etch');
    if (level) {
      const p = this.levelPoint(this.brush.elevation);
      this.overlay.cursor(p ? { point: p, normal: new THREE.Vector3(0, 1, 0), radius: this.brush.width / 2, drop: true } : null);
    } else {
      const radius = this.mode === 'etch' ? this.brush.etchRadius : this.mode === 'paint' ? this.brush.width / 2 : 0.03;
      this.overlay.cursor(hit ? { point: hit.point, normal: hit.normal, radius, drop: false } : null);
    }
    if (this.mode === 'meter' && hit) this.measure(e, hit);
  }

  private measure(e: PointerEvent, hit: Hit) {
    const now = performance.now();
    if (this.meterBusy || now - this.meterAt < 90) return;
    this.meterBusy = true;
    this.meterAt = now;
    const p = hit.point, n = hit.normal;
    this.app.gi.measure(new Float32Array([p.x, p.y, p.z, 0, n.x, n.y, n.z, 0])).then((out) => {
      this.meter = { x: e.clientX, y: e.clientY, illuminance: [out[0], out[1], out[2]], position: [p.x, p.y, p.z] };
      this.emit();
    }).finally(() => { this.meterBusy = false; });
  }

  // --- transforms ------------------------------------------------------------------------------

  private transformDrag(e: PointerEvent) {
    const d = this.drag!;
    const snap = d.snapshot!;
    const dx = e.clientX - d.start.x, dy = e.clientY - d.start.y;
    const room = this.app.doc.scene.room.size;
    this.app.doc.edit((s) => {
      const o = s.objects.find((x) => x.id === d.id);
      if (!o) return;
      if (this.transform === 'move') {
        const p = new THREE.Vector3();
        if (!this.ray.ray.intersectPlane(d.plane!, p)) return;
        const delta = p.sub(d.startPoint!);
        const step = e.ctrlKey || e.metaKey ? 0.05 : 0;
        const q = (v: number) => (step ? Math.round(v / step) * step : v);
        if (e.shiftKey) o.position = [snap.position[0], Math.min(Math.max(q(snap.position[1] + delta.y), 0), room[1]), snap.position[2]];
        else o.position = [
          Math.min(Math.max(q(snap.position[0] + delta.x), -room[0] / 2), room[0] / 2), snap.position[1],
          Math.min(Math.max(q(snap.position[2] + delta.z), -room[2] / 2), room[2] / 2),
        ];
      } else if (this.transform === 'rotate') {
        const step = e.ctrlKey || e.metaKey ? Math.PI / 12 : 0;
        const q = (v: number) => (step ? Math.round(v / step) * step : v);
        if (e.shiftKey) o.rotation = [q(snap.rotation[0] + dy * 0.01), snap.rotation[1], snap.rotation[2]];
        else o.rotation = [snap.rotation[0], q(snap.rotation[1] + dx * 0.01), snap.rotation[2]];
      } else {
        Object.assign(o, scaleObject(structuredClone(snap), Math.exp(-dy * 0.006)));
      }
    }, 'values', 'drag');
  }

  duplicate(id: string): string | null {
    const doc = this.app.doc;
    const src = doc.object(id);
    if (!src) return null;
    const copy = structuredClone(src);
    copy.id = uid(copy.kind);
    copy.name = /copy$/.test(copy.name) ? copy.name : `${copy.name} copy`;
    copy.position = [copy.position[0] + 0.25, copy.position[1], copy.position[2] + 0.25];
    for (const m of copy.motions) m.id = uid('motion');
    doc.edit((s) => { s.objects.push(copy); }, 'structure');
    doc.select({ type: 'object', id: copy.id });
    return copy.id;
  }

  remove(id: string) {
    const doc = this.app.doc;
    doc.edit((s) => { s.objects = s.objects.filter((o) => o.id !== id); }, 'structure');
    if (doc.selection.type === 'object' && doc.selection.id === id) doc.select({ type: 'none' });
  }

  // --- painting --------------------------------------------------------------------------------

  private samplePoint(): { point: THREE.Vector3; normal: THREE.Vector3; onSurface: boolean } | null {
    const b = this.brush;
    if (b.target === 'level') {
      const p = this.levelPoint(b.elevation);
      return p ? { point: p, normal: new THREE.Vector3(0, 1, 0), onSurface: false } : null;
    }
    const hit = this.pick();
    if (hit) return { point: hit.point.clone().addScaledVector(hit.normal, Math.max(b.offset, 0.004)), normal: hit.normal, onSurface: b.offset < 0.06 };
    // Off every surface: carry on in the plane facing the camera through the last point.
    const d = this.drag;
    const last = d?.world?.[d.world.length - 1];
    if (!last) return null;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.app.camera.getWorldDirection(new THREE.Vector3()), last);
    const p = new THREE.Vector3();
    return this.ray.ray.intersectPlane(plane, p) ? { point: p, normal: d!.normals![d!.normals!.length - 1].clone(), onSurface: false } : null;
  }

  private pressureOf(e: PointerEvent): number {
    const raw = e.pointerType === 'pen' || (e.pointerType === 'touch' && e.pressure > 0 && e.pressure !== 0.5) ? e.pressure : 1;
    return 1 - this.brush.pressure * (1 - Math.min(Math.max(raw, 0), 1));
  }

  private beginStroke(e: PointerEvent, start: THREE.Vector2) {
    const s = this.samplePoint();
    if (!s) return;
    const b = this.brush;
    const doc = this.app.doc;
    const id = uid('stroke');
    this.drag = { kind: 'paint', id, start, moved: true, world: [s.point], pressures: [this.pressureOf(e)], normals: [s.normal], filtered: s.point.clone(), onSurface: s.onSurface };
    if (b.record && doc.selection.type === 'object') return; // gesture only, no stroke object
    const stroke: StrokeObject = {
      id, name: b.profile === 'tube' ? 'Tube' : 'Stroke', kind: 'stroke', position: s.point.toArray() as Vec3, rotation: [0, 0, 0], visible: true, motions: [],
      profile: b.profile, points: [[0, 0, 0], [0, 0, 0]], pressure: [1, 1], width: b.width, taper: b.taper,
      normal: s.normal.toArray() as Vec3, onSurface: s.onSurface, emission: emission([...b.color] as Vec3, b.luminance), fade: b.fade, born: this.app.clock.elapsed,
    };
    doc.edit((sc) => { sc.objects.push(stroke); }, 'structure', 'paint');
  }

  private extendStroke(e: PointerEvent) {
    const d = this.drag!;
    const s = this.samplePoint();
    if (!s) return;
    const b = this.brush;
    // Smoothing: the brush follows the pointer through a low-pass filter.
    const k = 1 - 0.85 * b.smoothing;
    d.filtered!.lerp(s.point, k);
    const last = d.world![d.world!.length - 1];
    const spacing = Math.max(b.width * 0.6, 0.025);
    if (d.filtered!.distanceTo(last) < spacing) return;
    d.world!.push(d.filtered!.clone());
    d.pressures!.push(this.pressureOf(e));
    d.normals!.push(s.normal);
    d.onSurface = d.onSurface && s.onSurface;
    this.writeStroke(false);
  }

  private writeStroke(final: boolean) {
    const d = this.drag ?? this.finishing;
    if (!d || !d.world) return;
    let pts = d.world, pr = d.pressures!;
    if (final) ({ pts, pr } = simplify(pts, pr, this.brush.width * 0.12));
    if (pts.length > MAX_STROKE_POINTS) ({ pts, pr } = resample(pts, pr, MAX_STROKE_POINTS));
    const origin = pts[0];
    const n = d.normals!.reduce((a, v) => a.add(v), new THREE.Vector3()).normalize();
    this.app.doc.edit((sc) => {
      const o = sc.objects.find((x) => x.id === d.id);
      if (!o || o.kind !== 'stroke') return;
      o.position = origin.toArray() as Vec3;
      o.points = pts.map((p) => [p.x - origin.x, p.y - origin.y, p.z - origin.z] as Vec3);
      o.pressure = pr.slice();
      o.normal = n.toArray() as Vec3;
      o.onSurface = !!d.onSurface;
    }, 'structure', 'paint');
  }
  private finishing: Tools['drag'] = null;

  private finishStroke() {
    const d = this.finishing;
    const doc = this.app.doc;
    if (!d || !d.world) return;
    const b = this.brush;
    if (b.record && doc.selection.type === 'object') {
      // The gesture becomes a motion path of the selected object, relative to its start.
      const { pts } = resample(d.world, d.pressures!, Math.min(d.world.length, 32));
      if (pts.length >= 2) {
        const o0 = pts[0];
        const id = doc.selection.id;
        doc.edit((sc) => {
          const o = sc.objects.find((x) => x.id === id);
          if (!o) return;
          o.motions = o.motions.filter((m) => m.kind !== 'path');
          o.motions.push({ ...motion('path'), path: pts.map((p) => [p.x - o0.x, p.y - o0.y, p.z - o0.z] as Vec3) });
        }, 'structure');
      }
    } else if (d.world.length < 2) {
      doc.edit((sc) => { sc.objects = sc.objects.filter((o) => o.id !== d.id); }, 'structure', 'paint');
    } else {
      this.writeStroke(true);
    }
    this.finishing = null;
  }

  // --- etching ---------------------------------------------------------------------------------

  private etchAt(world: THREE.Vector3) {
    const d = this.drag!;
    const doc = this.app.doc;
    const o = doc.object(d.id!) as GlassObject | undefined;
    const entry = this.app.runtime.entries.get(d.id!);
    if (!o || !entry) return;
    const local = entry.mesh.worldToLocal(world.clone());
    const cx = (local.x / o.size[0] + 0.5) * ETCH, cy = (0.5 - local.y / o.size[1]) * ETCH;
    const rx = (this.brush.etchRadius / o.size[0]) * ETCH, ry = (this.brush.etchRadius / o.size[1]) * ETCH;
    const m = d.mask!;
    for (let y = Math.max(Math.floor(cy - ry - 1), 0); y <= Math.min(Math.ceil(cy + ry + 1), ETCH - 1); y++) {
      for (let x = Math.max(Math.floor(cx - rx - 1), 0); x <= Math.min(Math.ceil(cx + rx + 1), ETCH - 1); x++) {
        const r = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
        const a = Math.min(Math.max(1.25 - r, 0), 1) * 0.6;
        const i = y * ETCH + x;
        m[i] = d.restore ? Math.round(m[i] * (1 - a)) : Math.round(m[i] + (255 - m[i]) * a);
      }
    }
    const encoded = encodeEtch(m);
    doc.edit((sc) => { const g = sc.objects.find((x) => x.id === d.id); if (g && g.kind === 'glass') g.etch = encoded; }, 'values', 'etch');
  }
}

/** Scales an object's own dimensions about its origin. Emitters keep their output if locked. */
export function scaleObject<T extends SceneObject>(o: T, f: number): T {
  const k = Math.min(Math.max(f, 0.05), 20);
  const v3 = (v: Vec3): Vec3 => [v[0] * k, v[1] * k, v[2] * k];
  switch (o.kind) {
    case 'slab': o.size = v3(o.size); break;
    case 'perforated': o.size = [o.size[0] * k, o.size[1] * k, o.size[2]]; break;
    case 'louvers': o.size = [o.size[0] * k, o.size[1] * k, o.size[2]]; break;
    case 'arch': o.size = [o.size[0] * k, o.size[1] * k, o.size[2]]; o.span *= k; o.rise *= k; break;
    case 'cylinder': o.radius *= k; o.height *= k; break;
    case 'sphere': o.radius *= k; break;
    case 'curved': o.radius *= k; o.height *= k; break;
    case 'folded': o.panelWidth *= k; o.height *= k; break;
    case 'emitter': o.size = [o.size[0] * k, o.size[1] * k]; if (o.emission.lockOutput) o.emission.luminance /= k * k; break;
    case 'decal': o.size = [o.size[0] * k, o.size[1] * k]; if (o.emission.lockOutput) o.emission.luminance /= k * k; break;
    case 'stroke': o.points = o.points.map(v3); o.width *= k; if (o.emission.lockOutput) o.emission.luminance /= k * k; break;
    case 'glass': o.size = v3(o.size); break;
    case 'spot': o.spread = Math.min(Math.max(o.spread * k, 0.1), 2.4); break;
  }
  if ('emission' in o && o.emission && o.kind !== 'emitter' && o.kind !== 'decal' && o.kind !== 'stroke' && o.emission.lockOutput) o.emission.luminance /= k * k;
  return o;
}

/** Ramer-Douglas-Peucker on a polyline, carrying the pressure values along. */
function simplify(pts: THREE.Vector3[], pr: number[], tolerance: number): { pts: THREE.Vector3[]; pr: number[] } {
  if (pts.length < 3) return { pts, pr };
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const seg = new THREE.Line3(), closest = new THREE.Vector3();
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    seg.set(pts[a], pts[b]);
    let worst = -1, dist = tolerance;
    for (let i = a + 1; i < b; i++) {
      seg.closestPointToPoint(pts[i], true, closest);
      const d = closest.distanceTo(pts[i]);
      if (d > dist) { dist = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const outP: THREE.Vector3[] = [], outR: number[] = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) { outP.push(pts[i]); outR.push(pr[i]); }
  return { pts: outP, pr: outR };
}

/** Resamples a polyline to n points evenly spaced along its length. */
function resample(pts: THREE.Vector3[], pr: number[], n: number): { pts: THREE.Vector3[]; pr: number[] } {
  if (pts.length <= 2 || n < 2) return { pts, pr };
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + pts[i].distanceTo(pts[i - 1]));
  const total = len[len.length - 1];
  const outP: THREE.Vector3[] = [], outR: number[] = [];
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = (i / (n - 1)) * total;
    while (j < pts.length - 2 && len[j + 1] < s) j++;
    const t = (s - len[j]) / Math.max(len[j + 1] - len[j], 1e-6);
    outP.push(pts[j].clone().lerp(pts[j + 1], t));
    outR.push(pr[j] + (pr[j + 1] - pr[j]) * t);
  }
  return { pts: outP, pr: outR };
}
