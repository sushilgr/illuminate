// World-space Radiance Cascades for a bounded room.
//
// Scene representation: analytic primitives voxelised every time the scene changes into
//   geom  rgba16f  r signed distance to solids, g distance to thin emitters (metres)
//   albedo rgba8   rgb diffuse reflectance
//   emit  rgba16f  rgb emitted radiance of surface emitters
//   j*    rgba16f  prefiltered emission density + anisotropy of thin (line-like) emitters
//   rad   rgba16f  outgoing radiance of surface voxels (the radiance cache cascade rays hit)
// Cascades: a dense hierarchy of probe grids; cascade n has spacing d0 * 2^n, 64 * 4^n
// directions and traces the radiance interval [t0 * s^(n-1), t0 * s^n].
//
// All GPU resources here are created and owned by this class on the renderer's device.

import { ComputePass, GpuTimer, type BindDecl } from './pass';
import structsSrc from './wgsl/structs.wgsl?raw';
import sceneSrc from './wgsl/scene.wgsl?raw';
import gatherSrc from './wgsl/gather.wgsl?raw';
import voxelizeSrc from './wgsl/voxelize.wgsl?raw';
import thinSrc from './wgsl/thin.wgsl?raw';
import mipSrc from './wgsl/mip.wgsl?raw';
import radcacheSrc from './wgsl/radcache.wgsl?raw';
import cascadeSrc from './wgsl/cascade.wgsl?raw';
import lightingSrc from './wgsl/lighting.wgsl?raw';
import measureSrc from './wgsl/measure.wgsl?raw';

export interface GIConfig {
  /** Voxel edge length in metres. */
  voxel: number;
  /** Voxel grid dimensions. Each must be divisible by 2 * probeDiv. */
  grid: [number, number, number];
  /** Cascade 0 probe spacing in voxels. */
  probeDiv: number;
  /** Thin-emitter density grid spacing in voxels. */
  jDiv: number;
  cascades: number;
  /** Start of the cascade 0 interval, in cascade 0 probe spacings ("cascade -1" range). */
  tNear: number;
  /** End of the cascade 0 interval, in cascade 0 probe spacings. */
  t0: number;
  /** Interval length growth per cascade. */
  intervalScale: number;
  /** Hit band around surfaces, in voxels (guards sheets thinner than a voxel). */
  hitBand: number;
  /** Coverage radius of a ray as a fraction of its cone radius (0 = binary visibility). */
  coverage: number;
}

export interface Lighting {
  sunDir: [number, number, number];
  sunTan: number;
  sunIrradiance: [number, number, number];
  sunEnabled: boolean;
  skyGain: number;
  bounceGain: number;
}

export const MAX_APERTURES = 8;
export const APERTURE_FLOATS = 20;

export interface CameraState {
  invViewProj: Float32Array | number[];
  position: [number, number, number];
  width: number;
  height: number;
}

export const PRIM_FLOATS = 32;
export const SEG_FLOATS = 16;

const F16 = 'rgba16float' as const;

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
/** float32 -> float16 bits (round to nearest, clamps to the finite range). */
function toHalf(v: number): number {
  _f32[0] = Math.min(Math.max(v, -65504), 65504);
  const x = _u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = ((x >>> 23) & 0xff) - 127 + 15;
  let mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >> (1 - exp);
    return sign | ((mant + 0x1000) >> 13);
  }
  return sign + (exp << 10) + ((mant + 0x1000) >> 13);
}

function squareToSphere(u0: number, v0: number): [number, number, number] {
  const u = 2 * u0 - 1, v = 2 * v0 - 1;
  const up = Math.abs(u), vp = Math.abs(v);
  const sd = 1 - (up + vp);
  const d = Math.abs(sd);
  const r = 1 - d;
  const phi = (r > 1e-6 ? (vp - up) / r + 1 : 1) * Math.PI * 0.25;
  const z = Math.sign(sd || 1) * (1 - r * r);
  const s = r * Math.sqrt(Math.max(2 - r * r, 0));
  const x = (u >= 0 ? 1 : -1) * Math.abs(Math.cos(phi)) * s;
  const y = (v >= 0 ? 1 : -1) * Math.abs(Math.sin(phi)) * s;
  return [x, z, y];
}

interface CascadeLevel {
  grid: [number, number, number];
  spacing: number;
  stored: number;    // stored direction resolution S
  traced: number;    // traced direction resolution R
  sub: number;       // rays per axis per stored texel
  tA: number;
  tB: number;
  texture: GPUTexture;
  view: GPUTextureView;
  ubo: GPUBuffer;
  bindGroup?: GPUBindGroup;
  rays: number;
}

export class GISystem {
  readonly timer: GpuTimer;
  readonly levels: CascadeLevel[] = [];
  readonly domainSize: [number, number, number];
  readonly probeSpacing: number;
  debugMode = 0;
  debugParam = 0;
  /** Solver iterations per frame; each adds one current-frame bounce. */
  iterations = 1;
  memoryBytes = 0;

  private readonly globals: GPUBuffer;
  private readonly globalsData = new Float32Array((11 + MAX_APERTURES * 5 + 64) * 4);
  private readonly apertureData = new Float32Array(MAX_APERTURES * APERTURE_FLOATS);
  private apertureCount = 0;
  private roomMin: [number, number, number] = [0, 0, 0];
  private roomMax: [number, number, number] = [0, 0, 0];
  private readonly sky: GPUTexture;
  private readonly skySampler: GPUSampler;
  private readonly cameraBuf: GPUBuffer;
  private readonly cameraData = new Float32Array(24);
  private readonly sampler: GPUSampler;

  private primBuf: GPUBuffer;
  private primCapacity = 64;
  private primCount = 0;
  private segBuf: GPUBuffer;
  private segCapacity = 256;
  private segCount = 0;

  private readonly geom: GPUTexture;
  private readonly albedo: GPUTexture;
  private readonly emit: GPUTexture;
  private rad: [GPUTexture, GPUTexture];
  private radIndex = 0;
  private readonly jTex: GPUTexture[];
  private readonly jMips: number;
  private readonly jGrid: [number, number, number];

  private readonly pVoxelize: ComputePass;
  private readonly pThin: ComputePass;
  private readonly pMip: ComputePass;
  private readonly pRadcache: ComputePass;
  private readonly pCascade: ComputePass;
  private readonly pLighting: ComputePass;
  private readonly pMeasure: ComputePass;

  private bgVoxelize?: GPUBindGroup;
  private bgThin?: GPUBindGroup;
  private bgMips: GPUBindGroup[] = [];
  private bgRadcache: GPUBindGroup[] = [];
  private bgCascade: GPUBindGroup[][] = [[], []];
  private bgLighting: (GPUBindGroup | undefined)[] = [undefined, undefined];
  private lightingKey: unknown[][] = [[], []];

  private sceneDirty = true;
  private frame = 0;
  private domainMin: [number, number, number] = [0, 0, 0];
  private lighting: Lighting = {
    sunDir: [0.3, 0.8, 0.5], sunTan: 0.02, sunIrradiance: [0, 0, 0], sunEnabled: false, skyGain: 1, bounceGain: 1,
  };

  constructor(readonly device: GPUDevice, readonly config: GIConfig) {
    const c = config;
    this.timer = new GpuTimer(device);
    this.domainSize = [c.grid[0] * c.voxel, c.grid[1] * c.voxel, c.grid[2] * c.voxel];
    this.probeSpacing = c.voxel * c.probeDiv;

    this.globals = device.createBuffer({ size: this.globalsData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.cameraBuf = device.createBuffer({ size: this.cameraData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge',
    });
    this.sky = device.createTexture({
      label: 'gi.sky', format: F16, size: { width: 128, height: 64 },
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.skySampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
    this.primBuf = this.makeStorage(this.primCapacity * PRIM_FLOATS * 4);
    this.segBuf = this.makeStorage(this.segCapacity * SEG_FLOATS * 4);

    const vol = (label: string, size: [number, number, number], mips = 1) => {
      this.memoryBytes += size[0] * size[1] * size[2] * 8 * (mips > 1 ? 8 / 7 : 1);
      return device.createTexture({
        label, dimension: '3d', format: F16, mipLevelCount: mips,
        size: { width: size[0], height: size[1], depthOrArrayLayers: size[2] },
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    };
    this.geom = vol('gi.geom', c.grid);
    this.albedo = device.createTexture({
      label: 'gi.albedo', dimension: '3d', format: 'rgba8unorm',
      size: { width: c.grid[0], height: c.grid[1], depthOrArrayLayers: c.grid[2] },
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.memoryBytes += c.grid[0] * c.grid[1] * c.grid[2] * 4;
    this.emit = vol('gi.emit', c.grid);
    this.rad = [vol('gi.radA', c.grid), vol('gi.radB', c.grid)];

    this.jGrid = [c.grid[0] / c.jDiv, c.grid[1] / c.jDiv, c.grid[2] / c.jDiv];
    this.jMips = Math.max(1, Math.min(5, Math.floor(Math.log2(Math.min(...this.jGrid) / 2))));
    this.jTex = ['gi.j', 'gi.jA', 'gi.jB'].map((l) => vol(l, this.jGrid, this.jMips));

    // Cascade hierarchy.
    const g0: [number, number, number] = [c.grid[0] / c.probeDiv, c.grid[1] / c.probeDiv, c.grid[2] / c.probeDiv];
    const t0 = c.t0 * this.probeSpacing;
    for (let n = 0; n < c.cascades; n++) {
      const grid: [number, number, number] = [
        Math.max(1, Math.ceil(g0[0] / 2 ** n)), Math.max(1, Math.ceil(g0[1] / 2 ** n)), Math.max(1, Math.ceil(g0[2] / 2 ** n)),
      ];
      const traced = 8 * 2 ** n;
      const sub = n === 0 ? 1 : 2;
      const stored = traced / sub;
      const tA = n === 0 ? c.tNear * this.probeSpacing : t0 * c.intervalScale ** (n - 1);
      const tB = n === c.cascades - 1 ? 1e4 : t0 * c.intervalScale ** n;
      const texture = vol(`gi.cascade${n}`, [grid[0] * stored, grid[1] * stored, grid[2]]);
      const ubo = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.levels.push({
        grid, spacing: this.probeSpacing * 2 ** n, stored, traced, sub, tA, tB,
        texture, view: texture.createView(), ubo,
        rays: grid[0] * grid[1] * grid[2] * traced * traced,
      });
    }
    this.writeCascadeParams();

    // Passes.
    const G: BindDecl = { name: 'G', kind: 'uniform', type: 'Globals' };
    const S: BindDecl = { name: 'samp', kind: 'sampler' };
    const sceneTex: BindDecl[] = [
      { name: 'geomTex', kind: 'tex3d' }, { name: 'radTex', kind: 'tex3d' },
      { name: 'jTex', kind: 'tex3d' }, { name: 'jtA', kind: 'tex3d' }, { name: 'jtB', kind: 'tex3d' },
      { name: 'skyTex', kind: 'tex2d' }, { name: 'skySamp', kind: 'sampler' },
    ];
    this.pVoxelize = new ComputePass(device, 'voxelize', [
      G, { name: 'prims', kind: 'storage', type: 'Prim' }, S, { name: 'jtB', kind: 'tex3d' },
      { name: 'geomOut', kind: 'store3d' }, { name: 'albedoOut', kind: 'store3d', format: 'rgba8unorm' }, { name: 'emitOut', kind: 'store3d' },
    ], [structsSrc, voxelizeSrc]);
    this.pThin = new ComputePass(device, 'thin', [
      G, { name: 'segs', kind: 'storage', type: 'Seg' },
      { name: 'jOut', kind: 'store3d' }, { name: 'jaOut', kind: 'store3d' }, { name: 'jbOut', kind: 'store3d' },
    ], [structsSrc, thinSrc]);
    this.pMip = new ComputePass(device, 'mip', [
      { name: 'src0', kind: 'tex3d' }, { name: 'src1', kind: 'tex3d' }, { name: 'src2', kind: 'tex3d' },
      { name: 'dst0', kind: 'store3d' }, { name: 'dst1', kind: 'store3d' }, { name: 'dst2', kind: 'store3d' },
    ], [mipSrc]);
    this.pRadcache = new ComputePass(device, 'radcache', [
      G, S, ...sceneTex, { name: 'albedoTex', kind: 'tex3d' }, { name: 'emitTex', kind: 'tex3d' }, { name: 'c0Tex', kind: 'tex3d' },
      { name: 'radOut', kind: 'store3d' },
    ], [structsSrc, sceneSrc, gatherSrc, radcacheSrc]);
    this.pCascade = new ComputePass(device, 'cascade', [
      G, { name: 'C', kind: 'uniform', type: 'CascadeParams' }, S, ...sceneTex,
      { name: 'upperTex', kind: 'tex3d' }, { name: 'outTex', kind: 'store3d' },
    ], [structsSrc, sceneSrc, cascadeSrc]);
    this.pLighting = new ComputePass(device, 'lighting', [
      G, { name: 'CAM', kind: 'uniform', type: 'Camera' }, S, ...sceneTex, { name: 'c0Tex', kind: 'tex3d' },
      { name: 'gAlbedo', kind: 'tex2d' }, { name: 'gNormal', kind: 'tex2d' }, { name: 'gEmissive', kind: 'tex2d' },
      { name: 'gDepth', kind: 'depth2d' }, { name: 'litOut', kind: 'store2d' },
    ], [structsSrc, sceneSrc, gatherSrc, lightingSrc]);
    this.pMeasure = new ComputePass(device, 'measure', [
      G, S, ...sceneTex, { name: 'c0Tex', kind: 'tex3d' },
      { name: 'pts', kind: 'storage', type: 'MeterPoint' }, { name: 'outE', kind: 'storage_rw', type: 'vec4f' },
    ], [structsSrc, sceneSrc, gatherSrc, measureSrc]);

    this.buildBindGroups();
  }

  private makeStorage(size: number): GPUBuffer {
    return this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private writeCascadeParams() {
    const coneTan = (res: number) => { const c = 1 - 2 / (res * res); return Math.sqrt(Math.max(1 - c * c, 0)) / c; };
    const N = this.levels.length;
    this.levels.forEach((l, n) => {
      const up = this.levels[Math.min(n + 1, N - 1)];
      const steps = n === N - 1 ? 72 : Math.min(12 + n * 12, 56);
      const d = new Float32Array([
        l.grid[0], l.grid[1], l.grid[2], l.spacing,
        l.stored, l.traced, l.sub, n,
        l.tA, l.tB, coneTan(l.traced), n === N - 1 ? 1 : 0,
        up.grid[0], up.grid[1], up.grid[2], up.stored,
        steps, 0, 0, 0,
      ]);
      this.device.queue.writeBuffer(l.ubo, 0, d);
    });
  }

  private buildBindGroups() {
    const g = { buffer: this.globals };
    const jv = this.jTex.map((t) => t.createView());
    const geomView = this.geom.createView();
    const emitView = this.emit.createView();
    const radViews = this.rad.map((t) => t.createView());

    this.bgVoxelize = this.pVoxelize.bind({
      G: g, prims: { buffer: this.primBuf }, samp: this.sampler, jtB: jv[2],
      geomOut: geomView, albedoOut: this.albedo.createView(), emitOut: emitView,
    });
    const mip0 = (t: GPUTexture) => t.createView({ baseMipLevel: 0, mipLevelCount: 1 });
    this.bgThin = this.pThin.bind({ G: g, segs: { buffer: this.segBuf }, jOut: mip0(this.jTex[0]), jaOut: mip0(this.jTex[1]), jbOut: mip0(this.jTex[2]) });
    this.bgMips = [];
    for (let m = 1; m < this.jMips; m++) {
      const v = (t: GPUTexture, level: number) => t.createView({ baseMipLevel: level, mipLevelCount: 1 });
      this.bgMips.push(this.pMip.bind({
        src0: v(this.jTex[0], m - 1), src1: v(this.jTex[1], m - 1), src2: v(this.jTex[2], m - 1),
        dst0: v(this.jTex[0], m), dst1: v(this.jTex[1], m), dst2: v(this.jTex[2], m),
      }));
    }
    const scene = (radRead: number) => ({
      G: g, samp: this.sampler, geomTex: geomView, radTex: radViews[radRead],
      jTex: jv[0], jtA: jv[1], jtB: jv[2], skyTex: this.sky.createView(), skySamp: this.skySampler,
    });
    // radcache[i] reads rad[i] (previous) and writes rad[1 - i].
    this.bgRadcache = [0, 1].map((i) => this.pRadcache.bind({
      ...scene(i), albedoTex: this.albedo.createView(), emitTex: emitView, c0Tex: this.levels[0].view, radOut: radViews[1 - i],
    }));
    // cascade[i][n] reads rad[i].
    const N = this.levels.length;
    this.bgCascade = [0, 1].map((i) => this.levels.map((l, n) => this.pCascade.bind({
      ...scene(i), C: { buffer: l.ubo },
      // The top cascade has nothing above it; bind any other cascade as a placeholder.
      upperTex: this.levels[n === N - 1 ? (n === 0 ? 0 : n - 1) : n + 1].view,
      outTex: l.view,
    })));
    this.bgLighting = [undefined, undefined];
    this.lightingKey = [[], []];
  }

  setDomain(min: [number, number, number]) { this.domainMin = min; this.sceneDirty = true; }
  setLighting(l: Lighting) { this.lighting = l; }

  /** Interior box of the room and its openings (APERTURE_FLOATS per opening, see the Aperture struct). */
  setRoom(min: [number, number, number], max: [number, number, number], apertures: Float32Array, count: number) {
    this.roomMin = min;
    this.roomMax = max;
    this.apertureCount = Math.min(count, MAX_APERTURES);
    this.apertureData.fill(0);
    this.apertureData.set(apertures.subarray(0, this.apertureCount * APERTURE_FLOATS));
  }

  /** Uploads the exterior radiance map: 128 x 64 RGBA floats, equirectangular, row 0 at the zenith. */
  setSky(texels: Float32Array) {
    const half = new Uint16Array(texels.length);
    for (let i = 0; i < texels.length; i++) half[i] = toHalf(texels[i]);
    this.device.queue.writeTexture({ texture: this.sky }, half, { bytesPerRow: 128 * 8 }, { width: 128, height: 64 });
  }
  get domain() { return { min: this.domainMin, size: this.domainSize }; }

  /** Uploads the analytic scene. prims: PRIM_FLOATS per primitive, segs: SEG_FLOATS per segment. */
  setScene(prims: Float32Array, primCount: number, segs: Float32Array, segCount: number) {
    let rebuild = false;
    if (primCount > this.primCapacity) {
      this.primCapacity = Math.ceil(primCount * 1.5);
      this.primBuf.destroy();
      this.primBuf = this.makeStorage(this.primCapacity * PRIM_FLOATS * 4);
      rebuild = true;
    }
    if (segCount > this.segCapacity) {
      this.segCapacity = Math.ceil(segCount * 1.5);
      this.segBuf.destroy();
      this.segBuf = this.makeStorage(this.segCapacity * SEG_FLOATS * 4);
      rebuild = true;
    }
    if (rebuild) this.buildBindGroups();
    if (primCount > 0) this.device.queue.writeBuffer(this.primBuf, 0, prims.buffer, prims.byteOffset, primCount * PRIM_FLOATS * 4);
    if (segCount > 0) this.device.queue.writeBuffer(this.segBuf, 0, segs.buffer, segs.byteOffset, segCount * SEG_FLOATS * 4);
    this.primCount = primCount;
    this.segCount = segCount;
    this.sceneDirty = true;
  }

  private writeGlobals() {
    const c = this.config;
    const d = this.globalsData;
    const L = this.lighting;
    const sd = L.sunDir;
    const sl = Math.hypot(sd[0], sd[1], sd[2]) || 1;
    let o = 0;
    const put = (a: number, b: number, cc: number, e: number) => { d[o++] = a; d[o++] = b; d[o++] = cc; d[o++] = e; };
    put(this.domainMin[0], this.domainMin[1], this.domainMin[2], c.voxel);
    put(c.grid[0], c.grid[1], c.grid[2], c.voxel * c.jDiv);
    put(this.levels[0].grid[0], this.levels[0].grid[1], this.levels[0].grid[2], this.probeSpacing);
    put(this.levels[0].tA, this.levels[0].tB, c.coverage, this.levels.length);
    put(c.hitBand * c.voxel, L.bounceGain, this.frame, L.skyGain);
    put(sd[0] / sl, sd[1] / sl, sd[2] / sl, L.sunTan);
    put(L.sunIrradiance[0], L.sunIrradiance[1], L.sunIrradiance[2], L.sunEnabled ? 1 : 0);
    put(this.roomMin[0], this.roomMin[1], this.roomMin[2], this.apertureCount);
    put(this.roomMax[0], this.roomMax[1], this.roomMax[2], 0);
    put(0, 0, 0, 0);
    put(this.primCount, this.segCount, this.debugMode, this.debugParam);
    d.set(this.apertureData, o);
    o += this.apertureData.length;
    for (let k = 0; k < 64; k++) {
      const dir = squareToSphere(((k % 8) + 0.5) / 8, (Math.floor(k / 8) + 0.5) / 8);
      put(dir[0], dir[1], dir[2], 0);
    }
    this.device.queue.writeBuffer(this.globals, 0, d);
  }

  /** Runs voxelisation (if the scene changed) and the cascade solve. */
  solve(encoder: GPUCommandEncoder) {
    this.frame++;
    this.writeGlobals();
    const c = this.config;
    const run = (label: string, pass: ComputePass, bg: GPUBindGroup, x: number, y: number, z: number) => {
      const p = encoder.beginComputePass({ label, timestampWrites: this.timer.writes(label) });
      p.setPipeline(pass.pipeline);
      p.setBindGroup(0, bg);
      p.dispatchWorkgroups(x, y, z);
      p.end();
    };
    const c4 = (n: number) => Math.ceil(n / 4);
    if (this.sceneDirty) {
      // Thin emitters first: the voxeliser stores their distance next to the solid distance.
      run('thin', this.pThin, this.bgThin!, c4(this.jGrid[0]), c4(this.jGrid[1]), c4(this.jGrid[2]));
      this.bgMips.forEach((bg, i) => {
        const s = 2 ** (i + 1);
        run('thin', this.pMip, bg, c4(Math.max(1, this.jGrid[0] / s)), c4(Math.max(1, this.jGrid[1] / s)), c4(Math.max(1, this.jGrid[2] / s)));
      });
      run('voxelize', this.pVoxelize, this.bgVoxelize!, c4(c.grid[0]), c4(c.grid[1]), c4(c.grid[2]));
      this.sceneDirty = false;
    }
    for (let it = 0; it < this.iterations; it++) {
      run('radcache', this.pRadcache, this.bgRadcache[this.radIndex], c4(c.grid[0]), c4(c.grid[1]), c4(c.grid[2]));
      this.radIndex = 1 - this.radIndex;
      for (let n = this.levels.length - 1; n >= 0; n--) {
        const l = this.levels[n];
        run(`cascade${n}`, this.pCascade, this.bgCascade[this.radIndex][n],
          Math.ceil((l.grid[0] * l.stored) / 8), Math.ceil((l.grid[1] * l.stored) / 8), l.grid[2]);
      }
    }
  }

  /** Shades the G-buffer into `lit`. Texture arguments are raw GPU textures owned by the renderer. */
  light(encoder: GPUCommandEncoder, gb: { albedo: GPUTexture; normal: GPUTexture; emissive: GPUTexture; depth: GPUTexture }, lit: GPUTexture, cam: CameraState) {
    const ri = this.radIndex;
    const key = [gb.albedo, gb.normal, gb.emissive, gb.depth, lit];
    if (!this.bgLighting[ri] || key.some((k, i) => k !== this.lightingKey[ri][i])) {
      const jv = this.jTex.map((t) => t.createView());
      this.bgLighting[ri] = this.pLighting.bind({
        G: { buffer: this.globals }, CAM: { buffer: this.cameraBuf }, samp: this.sampler,
        geomTex: this.geom.createView(), radTex: this.rad[ri].createView(),
        jTex: jv[0], jtA: jv[1], jtB: jv[2], skyTex: this.sky.createView(), skySamp: this.skySampler, c0Tex: this.levels[0].view,
        gAlbedo: gb.albedo.createView(), gNormal: gb.normal.createView(), gEmissive: gb.emissive.createView(),
        gDepth: gb.depth.createView({ aspect: 'depth-only' }), litOut: lit.createView(),
      });
      this.lightingKey[ri] = key;
    }
    const d = this.cameraData;
    d.set(cam.invViewProj, 0);
    d.set([cam.position[0], cam.position[1], cam.position[2], 0, cam.width, cam.height, 0, 0], 16);
    this.device.queue.writeBuffer(this.cameraBuf, 0, d);
    const p = encoder.beginComputePass({ label: 'lighting', timestampWrites: this.timer.writes('lighting') });
    p.setPipeline(this.pLighting.pipeline);
    p.setBindGroup(0, this.bgLighting[ri]!);
    p.dispatchWorkgroups(Math.ceil(cam.width / 8), Math.ceil(cam.height / 8), 1);
    p.end();
  }

  get totalRays() { return this.levels.reduce((s, l) => s + l.rays, 0); }

  /**
   * Light meter. `points` holds 8 floats per point (position xyz, pad, normal xyz, pad).
   * Resolves to 4 floats per point: irradiance rgb and near-field visibility.
   * Asynchronous read-back; never called from the frame loop.
   */
  async measure(points: Float32Array): Promise<Float32Array> {
    const n = points.length / 8;
    const dev = this.device;
    const inBuf = dev.createBuffer({ size: points.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const outBuf = dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    const readBuf = dev.createBuffer({ size: n * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    dev.queue.writeBuffer(inBuf, 0, points.buffer, points.byteOffset, points.byteLength);
    const jv = this.jTex.map((t) => t.createView());
    const bg = this.pMeasure.bind({
      G: { buffer: this.globals }, samp: this.sampler, geomTex: this.geom.createView(), radTex: this.rad[this.radIndex].createView(),
      jTex: jv[0], jtA: jv[1], jtB: jv[2], skyTex: this.sky.createView(), skySamp: this.skySampler, c0Tex: this.levels[0].view,
      pts: { buffer: inBuf }, outE: { buffer: outBuf },
    });
    const enc = dev.createCommandEncoder({ label: 'illuminate.measure' });
    const p = enc.beginComputePass();
    p.setPipeline(this.pMeasure.pipeline);
    p.setBindGroup(0, bg);
    p.dispatchWorkgroups(Math.ceil(n / 64));
    p.end();
    enc.copyBufferToBuffer(outBuf, 0, readBuf, 0, n * 16);
    dev.queue.submit([enc.finish()]);
    await readBuf.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(readBuf.getMappedRange().slice(0));
    readBuf.unmap();
    [inBuf, outBuf, readBuf].forEach((b) => b.destroy());
    return out;
  }

  dispose() {
    [this.sky, this.geom, this.albedo, this.emit, ...this.rad, ...this.jTex, ...this.levels.map((l) => l.texture)].forEach((t) => t.destroy());
    [this.globals, this.cameraBuf, this.primBuf, this.segBuf, ...this.levels.map((l) => l.ubo)].forEach((b) => b.destroy());
  }
}
