// Keeps the three.js scene graph and the GI primitive buffers in step with the scene description.
import * as THREE from 'three/webgpu';
import type { GISystem, Lighting } from '../gi/GISystem';
import { buildObject, buildRoom, type SurfaceMaterial } from './meshes';
import { ScenePacker } from './pack';
import type { SceneDescription, SceneObject } from './types';

export class SceneRuntime {
  readonly root = new THREE.Group();
  readonly meshes = new Map<string, THREE.Mesh>();
  private readonly packer = new ScenePacker();
  private roomGroup?: THREE.Group;
  dirty = true;

  constructor(public description: SceneDescription, private readonly gi: GISystem) {
    this.rebuild();
  }

  rebuild() {
    this.root.clear();
    this.meshes.clear();
    const margin = (this.gi.domainSize[0] - this.description.room.size[0]) / 2;
    this.roomGroup = buildRoom(this.description.room, margin);
    this.root.add(this.roomGroup);
    for (const o of this.description.objects) {
      const m = buildObject(o);
      this.meshes.set(o.id, m);
      this.root.add(m);
    }
    const [w, h, d] = this.description.room.size;
    const s = this.gi.domainSize;
    this.gi.setDomain([-s[0] / 2, h / 2 - s[1] / 2, -s[2] / 2]);
    void w; void d;
    this.dirty = true;
  }

  object(id: string): SceneObject | undefined {
    return this.description.objects.find((o) => o.id === id);
  }

  /** Call after mutating object transforms / emission. */
  touch() { this.dirty = true; }

  lighting(bounceGain: number): Lighting {
    const dl = this.description.daylight;
    const ce = Math.cos(dl.sunElevation), se = Math.sin(dl.sunElevation);
    const sunDir: [number, number, number] = [ce * Math.cos(dl.sunAzimuth), se, ce * Math.sin(dl.sunAzimuth)];
    const b = dl.skyBrightness;
    const t = dl.skyTint;
    const grey = (t[0] + t[1] + t[2]) / 3;
    // Overcast skies lose their tint and become brighter towards the zenith.
    const c = dl.cloudiness;
    const mixc = (x: number) => x * (1 - c * 0.75) + grey * c * 0.75;
    const zen: [number, number, number] = [mixc(t[0]) * b, mixc(t[1]) * b, mixc(t[2]) * b];
    const hk = 1.35 - 0.55 * c;
    const hor: [number, number, number] = [(zen[0] * 0.55 + b * 0.45) * hk, (zen[1] * 0.55 + b * 0.45) * hk, (zen[2] * 0.55 + b * 0.42) * hk];
    const sunK = dl.sunBrightness * (1 - 0.92 * c) * Math.max(se, 0) ** 0.25;
    return {
      sunDir, sunTan: Math.tan((0.27 + 3.0 * c) * Math.PI / 180),
      sunIrradiance: [sunK * 1.0, sunK * 0.93, sunK * 0.82], sunEnabled: sunK > 1e-4,
      skyZenith: zen, skyHorizon: hor, skyGround: [b * 0.16, b * 0.15, b * 0.13],
      skyGain: 1, bounceGain,
    };
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
