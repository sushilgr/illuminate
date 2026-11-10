// Keeps the three.js scene graph and the GI inputs in step with the scene description.
import * as THREE from 'three/webgpu';
import { APERTURE_FLOATS, MAX_APERTURES, type GISystem, type Lighting } from '../gi/GISystem';
import { buildObject, buildRoom, type SurfaceMaterial } from './meshes';
import { ScenePacker, packApertures } from './pack';
import { computeSky, type SkyState } from './sky';
import type { SceneDescription, SceneObject } from './types';

export class SceneRuntime {
  readonly root = new THREE.Group();
  readonly meshes = new Map<string, THREE.Mesh>();
  private readonly packer = new ScenePacker();
  private readonly apertures = new Float32Array(MAX_APERTURES * APERTURE_FLOATS);
  private roomGroup?: THREE.Group;
  private skyKey = '';
  sky: SkyState;
  /** Set when object transforms, shapes or emission changed. */
  dirty = true;

  constructor(public description: SceneDescription, private readonly gi: GISystem) {
    this.sky = computeSky(description.daylight);
    this.rebuild();
  }

  /** Rebuilds every mesh. Call after structural edits (objects added or removed, room or openings changed). */
  rebuild() {
    this.root.clear();
    this.meshes.clear();
    const room = this.description.room;
    this.roomGroup = buildRoom(room);
    this.root.add(this.roomGroup);
    for (const o of this.description.objects) {
      const m = buildObject(o);
      this.meshes.set(o.id, m);
      this.root.add(m);
    }
    const [w, h, d] = room.size;
    const s = this.gi.domainSize;
    this.gi.setDomain([-s[0] / 2, h / 2 - s[1] / 2, -s[2] / 2]);
    const count = packApertures(room, this.apertures);
    this.gi.setRoom([-w / 2, 0, -d / 2], [w / 2, h, d / 2], this.apertures, count);
    this.dirty = true;
  }

  object(id: string): SceneObject | undefined {
    return this.description.objects.find((o) => o.id === id);
  }

  /** Call after mutating object transforms / emission. */
  touch() { this.dirty = true; }

  lighting(bounceGain: number): Lighting {
    const dl = this.description.daylight;
    const key = JSON.stringify(dl);
    if (key !== this.skyKey) {
      this.skyKey = key;
      this.sky = computeSky(dl, this.sky.texels);
      this.gi.setSky(this.sky.texels);
    }
    const s = this.sky;
    return { sunDir: s.sunDir, sunTan: s.sunTan, sunIrradiance: s.sunIrradiance, sunEnabled: s.sunEnabled, skyGain: 1, bounceGain };
  }

  /** Pushes transforms to meshes and, if anything changed, re-packs the GI scene. */
  sync() {
    for (const o of this.description.objects) {
      const m = this.meshes.get(o.id);
      if (!m) continue;
      m.position.set(o.position[0], o.position[1], o.position[2]);
      m.rotation.set(o.rotation[0], o.rotation[1], o.rotation[2], 'XYZ');
      m.visible = o.visible !== false;
      const mat = m.material as SurfaceMaterial;
      const level = o.kind === 'ribbon' ? o.level : 1;
      const e = o.emission ?? [0, 0, 0];
      mat.userData.emission.set(e[0] * level, e[1] * level, e[2] * level);
      if (o.kind !== 'ribbon') mat.userData.albedo.set(o.albedo[0], o.albedo[1], o.albedo[2]);
    }
    if (this.dirty) {
      const hJ = this.gi.config.voxel * this.gi.config.jDiv;
      this.packer.pack(this.description, 1.5 * hJ);
      this.gi.setScene(this.packer.prims, this.packer.primCount, this.packer.segs, this.packer.segCount);
      this.dirty = false;
    }
  }
}
