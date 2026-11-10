// Keeps the three.js scene graphs and the GI inputs in step with the scene document.
// The document holds rest values; every frame they are evaluated at the scene clock (motions,
// fades) and the evaluated copies drive both the meshes and the solver.
import * as THREE from 'three/webgpu';
import {
  CAUSTIC_OBJECT_FLOATS, ETCH_SIZE, MAX_CAUSTIC_OBJECTS, MAX_SHEETS, SHEET_FLOATS, type GISystem, type Lighting,
} from '../gi/GISystem';
import { createGlassMaterials, type GlassMaterials, type OpticsShared } from '../render/optics';
import { applyMotions, evaluateAperture, evaluateObject } from './animate';
import { SURFACES, buildGeometry, buildRoom, geometryKey, setSurface, spotLensGeometry, surfaceMaterial, type RoomMeshes, type SurfaceMaterial } from './meshes';
import { ScenePacker, castsCaustics } from './pack';
import { computeSky, type SkyState } from './sky';
import type { Aperture, Daylight, GlassObject, SceneDescription, SceneObject, Vec3 } from './types';

interface Entry {
  key: string;
  mesh: THREE.Mesh;
  material: SurfaceMaterial | null;
  /** Glass: second mesh for the glass G-buffer, and its materials. */
  layer?: THREE.Mesh;
  glass?: GlassMaterials;
  /** Light aperture: its luminous lens. */
  lens?: THREE.Mesh;
  etch?: string;
}

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

export function decodeEtch(s: string | undefined): Uint8Array | null {
  if (!s) return null;
  try {
    const bin = atob(s);
    if (bin.length !== ETCH_SIZE * ETCH_SIZE) return null;
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch { return null; }
}

export function encodeEtch(mask: Uint8Array): string {
  let s = '';
  for (let i = 0; i < mask.length; i++) s += String.fromCharCode(mask[i]);
  return btoa(s);
}

export class SceneRuntime {
  /** Opaque meshes, rendered into the G-buffer. */
  readonly opaque = new THREE.Scene();
  /** Glass, drawn twice: its normals (layer) and the refracting composite. */
  readonly glassLayer = new THREE.Scene();
  readonly glass = new THREE.Scene();
  readonly entries = new Map<string, Entry>();
  room!: RoomMeshes;
  sky: SkyState;
  /** Evaluated copies for the current frame, in document order. */
  evaluated: { value: SceneObject; level: number }[] = [];
  apertures: Aperture[] = [];
  daylight: Daylight;
  hasGlass = false;

  private readonly packer = new ScenePacker();
  private roomKey = '';
  private skyKey = '';
  private packKey = '';
  private readonly sheets = new Float32Array(MAX_SHEETS * SHEET_FLOATS);
  private readonly caustics = new Float32Array(MAX_CAUSTIC_OBJECTS * CAUSTIC_OBJECT_FLOATS);

  constructor(private readonly gi: GISystem, private readonly optics: OpticsShared) {
    this.daylight = { skyBrightness: 0, skyTint: [1, 1, 1], turbidity: 3, sunElevation: 1, sunAzimuth: 0, sunBrightness: 0, cloudiness: 0, groundAlbedo: 0, motions: [] };
    this.sky = computeSky(this.daylight);
  }

  /** Glass materials read screen-sized textures; call after the renderer resized them. */
  refreshOptics() { for (const e of this.entries.values()) e.glass?.refresh(); }

  private buildRoomMeshes(scene: SceneDescription) {
    const room = scene.room;
    // Shutters only scale the blinds; everything else about the room rebuilds its meshes.
    const key = JSON.stringify({ ...room, apertures: room.apertures.map((a) => ({ ...a, shutter: 0, motions: 0 })) });
    if (key === this.roomKey) return;
    this.roomKey = key;
    if (this.room) {
      this.opaque.remove(this.room.group);
      this.room.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
    }
    this.room = buildRoom(room);
    this.opaque.add(this.room.group);
    const [, h] = room.size;
    const s = this.gi.domainSize;
    this.gi.setDomain([-s[0] / 2, h / 2 - s[1] / 2, -s[2] / 2]);
    this.packKey = '';
  }

  private removeEntry(id: string) {
    const e = this.entries.get(id);
    if (!e) return;
    e.mesh.parent?.remove(e.mesh);
    e.layer?.parent?.remove(e.layer);
    e.mesh.geometry.dispose();
    e.lens?.geometry.dispose();
    e.material?.dispose();
    e.glass?.dispose();
    this.entries.delete(id);
  }

  private ensureEntry(o: SceneObject): Entry {
    const key = o.kind + geometryKey(o);
    let e = this.entries.get(o.id);
    if (e && e.key === key) return e;
    if (e) this.removeEntry(o.id);
    const geometry = buildGeometry(o);
    if (o.kind === 'glass') {
      const glass = createGlassMaterials(this.optics, o);
      const mesh = new THREE.Mesh(geometry, glass.composite);
      const layer = new THREE.Mesh(geometry, glass.gbuffer);
      this.glass.add(mesh);
      this.glassLayer.add(layer);
      e = { key, mesh, material: null, layer, glass };
    } else {
      const strip = o.kind === 'stroke' || o.kind === 'decal';
      const material = surfaceMaterial(SURFACES.BLACK, [0, 0, 0], strip ? THREE.DoubleSide : THREE.FrontSide);
      const mesh = new THREE.Mesh(geometry, material);
      this.opaque.add(mesh);
      e = { key, mesh, material };
      if (o.kind === 'spot') {
        e.lens = new THREE.Mesh(spotLensGeometry(), surfaceMaterial(SURFACES.BLACK));
        mesh.add(e.lens);
      }
    }
    e.mesh.name = o.id;
    this.entries.set(o.id, e);
    return e;
  }

  /** Brings meshes, materials and the GI inputs up to date for loop phase `phase` (0..1). */
  sync(scene: SceneDescription, phase: number, elapsed: number, bounceGain = 1): Lighting {
    this.buildRoomMeshes(scene);
    const room = scene.room;

    // Objects.
    const seen = new Set<string>();
    this.evaluated.length = 0;
    let hasGlass = false;
    let etched: GlassObject | null = null;
    for (const o of scene.objects) {
      seen.add(o.id);
      const ev = evaluateObject(o, phase, elapsed);
      this.evaluated.push(ev);
      const v = ev.value;
      const e = this.ensureEntry(v);
      e.mesh.position.set(v.position[0], v.position[1], v.position[2]);
      e.mesh.rotation.set(v.rotation[0], v.rotation[1], v.rotation[2], 'XYZ');
      e.mesh.visible = v.visible;
      if (e.layer) { e.layer.position.copy(e.mesh.position); e.layer.rotation.copy(e.mesh.rotation); e.layer.visible = v.visible; }
      if (v.kind === 'glass') {
        hasGlass ||= v.visible;
        e.glass!.update(v);
        if (v.shape === 'slab' && v.etch && !etched) etched = v;
        if (e.etch !== v.etch) { e.etch = v.etch; e.glass!.setEtch(decodeEtch(v.etch)); }
      } else if (e.material) {
        const k = ev.level;
        if (v.kind === 'emitter' || v.kind === 'stroke' || v.kind === 'decal') {
          const L = v.emission.luminance * k;
          setSurface(e.material, SURFACES.BLACK, [v.emission.color[0] * L, v.emission.color[1] * L, v.emission.color[2] * L]);
        } else if (v.kind === 'spot') {
          setSurface(e.material, SURFACES.FIXTURE, [0, 0, 0]);
          // The lens shows the beam's luminance: intensity over the lens area, kept displayable.
          const L = Math.min((v.flux * k) / (2 * Math.PI * (1 - Math.cos(v.spread / 2))) / 0.0066, 600);
          setSurface(e.lens!.material as SurfaceMaterial, SURFACES.BLACK, [v.color[0] * L, v.color[1] * L, v.color[2] * L]);
        } else {
          const em = v.emission ? v.emission.luminance * k : 0;
          setSurface(e.material, v.surface, v.emission ? [v.emission.color[0] * em, v.emission.color[1] * em, v.emission.color[2] * em] : [0, 0, 0]);
        }
      }
    }
    for (const id of [...this.entries.keys()]) if (!seen.has(id)) this.removeEntry(id);
    this.hasGlass = hasGlass;

    // Room surfaces, openings and blinds.
    setSurface(this.room.materials.wall, room.wall, [0, 0, 0]);
    setSurface(this.room.materials.floor, room.floor, [0, 0, 0]);
    setSurface(this.room.materials.ceiling, room.ceiling, [0, 0, 0]);
    this.apertures = room.apertures.map((a) => evaluateAperture(a, phase));
    for (const a of this.apertures) {
      const blind = this.room.blinds.get(a.id);
      if (blind) { blind.scale.y = Math.max(a.shutter, 1e-4); blind.visible = a.shutter > 0.001; }
    }

    // Daylight.
    this.daylight = applyMotions(scene.daylight, phase).value;
    const dl = this.daylight;
    const skyKey = `${dl.skyBrightness},${dl.skyTint},${dl.turbidity},${dl.sunElevation},${dl.sunAzimuth},${dl.sunBrightness},${dl.cloudiness},${dl.groundAlbedo}`;
    if (skyKey !== this.skyKey) {
      this.skyKey = skyKey;
      this.sky = computeSky(dl, this.sky.texels);
      this.gi.setSky(this.sky.texels);
    }

    // GI inputs, re-packed only when something that reaches the solver changed.
    const cfg = this.gi.config;
    this.packer.pack(room, this.apertures, this.evaluated, cfg.voxel, cfg.jDiv);
    const p = this.packer;
    const packKey = hashFloats(p.prims, p.primCount * 32) + ':' + hashFloats(p.segs, p.segCount * 16) + ':' + p.primCount + ':' + p.segCount;
    if (packKey !== this.packKey) {
      this.packKey = packKey;
      this.gi.setScene(p.prims, p.primCount, p.segs, p.segCount);
    }
    const [w, h, d] = room.size;
    this.gi.setRoom([-w / 2, 0, -d / 2], [w / 2, h, d / 2], p.apertures, p.apertureCount);
    this.gi.setSpots(p.spots, p.spotCount);
    this.packGlass(etched);

    const s = this.sky;
    return { sunDir: s.sunDir, sunTan: s.sunTan, sunIrradiance: s.sunIrradiance, sunEnabled: s.sunEnabled, skyGain: 1, bounceGain };
  }

  /** Frosted sheets (scatter direct light), caustic casters and the etched panel. */
  private packGlass(etched: GlassObject | null) {
    let sheets = 0, casters = 0;
    for (const ev of this.evaluated) {
      const o = ev.value;
      if (o.kind !== 'glass' || !o.visible) continue;
      _e.set(o.rotation[0], o.rotation[1], o.rotation[2], 'XYZ');
      _q.setFromEuler(_e);
      const ax = _v.set(1, 0, 0).applyQuaternion(_q).toArray() as Vec3;
      const ay = _v.set(0, 1, 0).applyQuaternion(_q).toArray() as Vec3;
      const k = 1 / Math.max(o.absorption, 1e-3);
      const sigma: Vec3 = [-Math.log(Math.max(o.tint[0], 1e-3)) * k, -Math.log(Math.max(o.tint[1], 1e-3)) * k, -Math.log(Math.max(o.tint[2], 1e-3)) * k];
      if (o.shape === 'slab' && o.frost > 0.01 && sheets < MAX_SHEETS) {
        const T = sigma.map((s) => Math.exp(-s * o.size[2]));
        this.sheets.set([
          o.position[0], o.position[1], o.position[2], o.size[0] / 2,
          ax[0], ax[1], ax[2], o.size[1] / 2,
          ay[0], ay[1], ay[2], o.size[2] / 2,
          T[0], T[1], T[2], o.frost,
        ], sheets * SHEET_FLOATS);
        sheets++;
      }
      if (castsCaustics(o) && casters < MAX_CAUSTIC_OBJECTS) {
        const shape = { slab: 0, lens: 1, prism: 2, rod: 3 }[o.shape];
        const [sx, sy, sz] = o.size;
        const size: Vec3 = o.shape === 'slab' ? [sx / 2, sy / 2, sz / 2] : o.shape === 'lens' ? [sx / 2, sz, 0] : o.shape === 'prism' ? [sx, sy / 2, 0] : [sx / 2, sy / 2, 0];
        const radius = o.shape === 'lens' ? sx / 2 : 0.5 * Math.hypot(sx, sy, o.shape === 'slab' ? sz : sx);
        this.caustics.set([
          o.position[0], o.position[1], o.position[2], shape,
          _q.x, _q.y, _q.z, _q.w,
          size[0], size[1], size[2], 0,
          o.ior, o.frost, o.dispersion, radius * 1.02,
          sigma[0], sigma[1], sigma[2], o === etched ? 1 : 0,
          o.shape === 'slab' ? o.fluteDepth : 0, Math.max(o.fluteSpacing, 0.005), 0, 0,
        ], casters * CAUSTIC_OBJECT_FLOATS);
        casters++;
      }
    }
    this.gi.setSheets(this.sheets, sheets);
    this.gi.setCausticObjects(this.caustics, casters);
    if (etched) {
      _e.set(etched.rotation[0], etched.rotation[1], etched.rotation[2], 'XYZ');
      _q.setFromEuler(_e);
      const ax = _v.set(1, 0, 0).applyQuaternion(_q).toArray();
      const ay = _v.set(0, 1, 0).applyQuaternion(_q).toArray();
      const key = etched.etch!;
      const mask = key !== this.etchKey ? decodeEtch(key) ?? undefined : undefined;
      this.etchKey = key;
      this.gi.setEtch([etched.position[0], etched.position[1], etched.position[2], etched.size[0] / 2, ax[0], ax[1], ax[2], etched.size[1] / 2, ay[0], ay[1], ay[2], 1], mask);
    } else {
      this.gi.setEtch(null);
      this.etchKey = '';
    }
  }
  private etchKey = '';

  dispose() {
    for (const id of [...this.entries.keys()]) this.removeEntry(id);
    this.room?.group.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
  }

  /** Meshes that can be picked, with the id of the object each belongs to. */
  pickables(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [];
    for (const e of this.entries.values()) if (e.mesh.visible) out.push(e.mesh);
    return out;
  }
}

/** Cheap content hash of the first n floats (FNV-1a over their bits). */
function hashFloats(a: Float32Array, n: number): string {
  const u = new Uint32Array(a.buffer, a.byteOffset, n);
  let h1 = 0x811c9dc5, h2 = 0x1b873593;
  for (let i = 0; i < n; i++) {
    h1 = Math.imul(h1 ^ u[i], 0x01000193);
    h2 = Math.imul(h2 + u[i], 0x85ebca6b) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
