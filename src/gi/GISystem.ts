// World-space Radiance Cascades for a bounded room.
//
// Scene representation: analytic primitives voxelised every time the scene changes into
//   geom    rgba16f  r signed distance to solids, g distance to thin emitters, b signed distance to glass
//   albedo  rgba8    rgb diffuse reflectance
//   emit    rgba16f  rgb emitted radiance of surface emitters
//   glass   rgba8    rgb transmittance per 0.1 m, a frost (+0.5 when the glass casts caustics)
//   j*      rgba16f  prefiltered emission density + anisotropy of thin (line-like) emitters
//   glow    rgba16f  emission density of sunlit frosted glass
//   rad     rgba16f  outgoing radiance of surface voxels (the radiance cache cascade rays hit)
// Cascades: a dense hierarchy of probe grids; cascade n has spacing d0 * 2^n, 64 * 4^n
// directions and traces the radiance interval [t0 * s^(n-1), t0 * s^n].
//
// All GPU resources here are created and owned by this class on the renderer's device.

import { ComputePass, GpuTimer, type BindDecl } from './pass';
import structsSrc from './wgsl/structs.wgsl?raw';
import sceneSrc from './wgsl/scene.wgsl?raw';
import directSrc from './wgsl/direct.wgsl?raw';
import gatherSrc from './wgsl/gather.wgsl?raw';
import voxelizeSrc from './wgsl/voxelize.wgsl?raw';
import thinSrc from './wgsl/thin.wgsl?raw';
import mipSrc from './wgsl/mip.wgsl?raw';
import mip1Src from './wgsl/mip1.wgsl?raw';
import glowSrc from './wgsl/glow.wgsl?raw';
import radcacheSrc from './wgsl/radcache.wgsl?raw';
import cascadeSrc from './wgsl/cascade.wgsl?raw';
import fluenceSrc from './wgsl/fluence.wgsl?raw';
import lightingSrc from './wgsl/lighting.wgsl?raw';
import measureSrc from './wgsl/measure.wgsl?raw';
import glassLightSrc from './wgsl/glasslight.wgsl?raw';
import causticSrc from './wgsl/caustic.wgsl?raw';
import causticBlurSrc from './wgsl/causticblur.wgsl?raw';
import causticHSrc from './wgsl/caustich.wgsl?raw';
import causticVSrc from './wgsl/causticv.wgsl?raw';

export interface GIConfig {
  /** Voxel edge length in metres. */
  voxel: number;
  /** Voxel grid dimensions. Each must be divisible by probeDiv. */
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

export interface ViewState {
  viewProj: ArrayLike<number>;
  invViewProj: ArrayLike<number>;
  position: [number, number, number];
  forward: [number, number, number];
  orthographic: boolean;
  /** Solid angle of the centre pixel (perspective) or world area of a pixel (orthographic). */
  pixelMeasure: number;
  width: number;
  height: number;
  hazeTint: [number, number, number];
  hazeAnisotropy: number;
}

export interface GBuffer { albedo: GPUTexture; normal: GPUTexture; emissive: GPUTexture; depth: GPUTexture }

export const PRIM_FLOATS = 32;
export const SEG_FLOATS = 16;
export const MAX_APERTURES = 8;
export const APERTURE_FLOATS = 20;
export const MAX_SPOTS = 4;
export const SPOT_FLOATS = 24;
export const MAX_SHEETS = 4;
export const SHEET_FLOATS = 16;
export const MAX_CAUSTIC_OBJECTS = 4;
export const CAUSTIC_OBJECT_FLOATS = 24;
export const ETCH_SIZE = 64;

const F16 = 'rgba16float' as const;
const GLOBAL_VEC4 = 14 + MAX_APERTURES * 5 + MAX_SPOTS * 6 + 64;
const CAUSTIC_SCALE = 512;

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
/** float32 -> float16 bits (round to nearest, clamps to the finite range). */
function toHalf(v: number): number {
  _f32[0] = Math.min(Math.max(v, -65504), 65504);
  const x = _u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = ((x >>> 23) & 0xff) - 127 + 15;
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
  rays: number;
}

type Views = Record<string, GPUBindingResource>;

export class GISystem {
  readonly timer: GpuTimer;
  readonly levels: CascadeLevel[] = [];
  readonly domainSize: [number, number, number];
  readonly probeSpacing: number;
  debugMode = 0;
  debugParam = 0;
  /** Solver iterations per frame; each adds one current-frame bounce. */
  iterations = 1;
  reflections = true;
  /** Photons per axis for each caustic object; 0 disables caustics. */
  causticResolution = 256;
  hazeExtinction = 0;
  memoryBytes = 0;

  private readonly globals: GPUBuffer;
  private readonly globalsData = new Float32Array(GLOBAL_VEC4 * 4);
  private readonly cameraBuf: GPUBuffer;
  private readonly cameraData = new Float32Array(32);
  private readonly sheetBuf: GPUBuffer;
  private readonly fluenceBuf: GPUBuffer;
  private readonly causticCamBuf: GPUBuffer;
  private readonly causticCamData = new Float32Array(44);
  private readonly causticObjBuf: GPUBuffer;
  private readonly blurBuf: GPUBuffer;
  private readonly sampler: GPUSampler;
  private readonly skySampler: GPUSampler;

  private primBuf: GPUBuffer;
  private primCapacity = 96;
  private primCount = 0;
  private segBuf: GPUBuffer;
  private segCapacity = 512;
  private segCount = 0;
  private readonly apertureData = new Float32Array(MAX_APERTURES * APERTURE_FLOATS);
  private apertureCount = 0;
  private readonly spotData = new Float32Array(MAX_SPOTS * SPOT_FLOATS);
  private spotCount = 0;
  private sheetCount = 0;
  private causticCount = 0;
  private readonly etchFrame = new Float32Array(12);
  private roomMin: [number, number, number] = [0, 0, 0];
  private roomMax: [number, number, number] = [0, 0, 0];

  private readonly sky: GPUTexture;
  private readonly etch: GPUTexture;
  private readonly geom: GPUTexture;
  private readonly albedo: GPUTexture;
  private readonly emit: GPUTexture;
  private readonly glass: GPUTexture;
  private readonly rad: [GPUTexture, GPUTexture];
  private radIndex = 0;
  private readonly jTex: GPUTexture[];
  private readonly glow: GPUTexture;
  private readonly fluence: GPUTexture;
  private readonly jMips: number;
  private readonly jGrid: [number, number, number];
  private directLevels: CascadeLevel[] | null = null;

  // Screen-sized caustic resources.
  private photons?: GPUBuffer;
  private causticTmp?: GPUTexture;
  private causticTex?: GPUTexture;
  private causticSize: [number, number] = [0, 0];
  private readonly noCaustic: GPUTexture;

  private readonly pVoxelize: ComputePass;
  private readonly pThin: ComputePass;
  private readonly pMip: ComputePass;
  private readonly pMip1: ComputePass;
  private readonly pGlow: ComputePass;
  private readonly pRadcache: ComputePass;
  private readonly pCascade: ComputePass;
  private readonly pFluence: ComputePass;
  private readonly pLighting: ComputePass;
  private readonly pMeasure: ComputePass;
  private readonly pGlassLight: ComputePass;
  private readonly pCaustic: ComputePass;
  private readonly pCausticH: ComputePass;
  private readonly pCausticV: ComputePass;

  private bgVoxelize!: GPUBindGroup;
  private bgThin!: GPUBindGroup;
  private bgMips: GPUBindGroup[] = [];
  private bgGlowMips: GPUBindGroup[] = [];
  private bgGlow!: GPUBindGroup;
  private bgRadcache: GPUBindGroup[] = [];
  private bgCascade: GPUBindGroup[][] = [[], []];
  private bgCascadeDirect: GPUBindGroup[] = [];
  private bgFluence!: GPUBindGroup;
  private screenKey: unknown[] = [];
  private bgLighting = new Map<GPUTexture, Map<string, GPUBindGroup>>();
  private bgCaustic?: GPUBindGroup;
  private bgCausticH?: GPUBindGroup;
  private bgCausticV?: GPUBindGroup;

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

    const ubo = (floats: number) => device.createBuffer({ size: floats * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.globals = ubo(this.globalsData.length);
    this.cameraBuf = ubo(32);
    this.sheetBuf = ubo(4 + MAX_SHEETS * SHEET_FLOATS);
    this.fluenceBuf = ubo(4);
    this.causticCamBuf = ubo(44);
    this.causticObjBuf = ubo(4 + MAX_CAUSTIC_OBJECTS * CAUSTIC_OBJECT_FLOATS);
    this.blurBuf = ubo(4);
    this.sampler = device.createSampler({
      magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
      addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', addressModeW: 'clamp-to-edge',
    });
    this.skySampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'clamp-to-edge' });
    this.sky = device.createTexture({ label: 'gi.sky', format: F16, size: { width: 128, height: 64 }, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.etch = device.createTexture({ label: 'gi.etch', format: 'rgba8unorm', size: { width: ETCH_SIZE, height: ETCH_SIZE }, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.noCaustic = device.createTexture({ label: 'gi.noCaustic', format: F16, size: { width: 1, height: 1 }, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.primBuf = this.makeStorage(this.primCapacity * PRIM_FLOATS * 4);
    this.segBuf = this.makeStorage(this.segCapacity * SEG_FLOATS * 4);

    const vol = (label: string, size: [number, number, number], mips = 1, format: GPUTextureFormat = F16) => {
      this.memoryBytes += size[0] * size[1] * size[2] * (format === F16 ? 8 : 4) * (mips > 1 ? 8 / 7 : 1);
      return device.createTexture({
        label, dimension: '3d', format, mipLevelCount: mips,
        size: { width: size[0], height: size[1], depthOrArrayLayers: size[2] },
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
    };
    this.geom = vol('gi.geom', c.grid);
    this.albedo = vol('gi.albedo', c.grid, 1, 'rgba8unorm');
    this.emit = vol('gi.emit', c.grid);
    this.glass = vol('gi.glass', c.grid, 1, 'rgba8unorm');
    this.rad = [vol('gi.radA', c.grid), vol('gi.radB', c.grid)];
    this.jGrid = [Math.ceil(c.grid[0] / c.jDiv), Math.ceil(c.grid[1] / c.jDiv), Math.ceil(c.grid[2] / c.jDiv)];
    this.jMips = Math.max(1, Math.min(5, Math.floor(Math.log2(Math.min(...this.jGrid) / 2))));
    this.jTex = ['gi.j', 'gi.jA', 'gi.jB'].map((l) => vol(l, this.jGrid, this.jMips));
    this.glow = vol('gi.glow', this.jGrid, this.jMips);

    this.levels = this.makeLevels('gi.cascade');
    const l1 = this.levels[Math.min(1, this.levels.length - 1)];
    this.fluence = vol('gi.fluence', l1.grid);
    device.queue.writeBuffer(this.fluenceBuf, 0, new Float32Array([l1.grid[0], l1.grid[1], l1.grid[2], l1.stored]));

    // Passes.
    const G: BindDecl = { name: 'G', kind: 'uniform', type: 'Globals' };
    const S: BindDecl = { name: 'samp', kind: 'sampler' };
    const scene: BindDecl[] = [
      G, S,
      { name: 'geomTex', kind: 'tex3d' }, { name: 'radTex', kind: 'tex3d' }, { name: 'glassTex', kind: 'tex3d' },
      { name: 'jTex', kind: 'tex3d' }, { name: 'jtA', kind: 'tex3d' }, { name: 'jtB', kind: 'tex3d' }, { name: 'glowTex', kind: 'tex3d' },
      { name: 'skyTex', kind: 'tex2d' }, { name: 'skySamp', kind: 'sampler' },
    ];
    const direct: BindDecl[] = [...scene, { name: 'etchTex', kind: 'tex2d' }];
    const gbuf: BindDecl[] = [{ name: 'gNormal', kind: 'tex2d' }, { name: 'gDepth', kind: 'depth2d' }];
    this.pVoxelize = new ComputePass(device, 'voxelize', [
      G, { name: 'prims', kind: 'storage', type: 'Prim' }, S, { name: 'jtB', kind: 'tex3d' },
      { name: 'geomOut', kind: 'store3d' }, { name: 'albedoOut', kind: 'store3d', format: 'rgba8unorm' },
      { name: 'emitOut', kind: 'store3d' }, { name: 'glassOut', kind: 'store3d', format: 'rgba8unorm' },
    ], [structsSrc, voxelizeSrc]);
    this.pThin = new ComputePass(device, 'thin', [
      G, { name: 'segs', kind: 'storage', type: 'Seg' },
      { name: 'jOut', kind: 'store3d' }, { name: 'jaOut', kind: 'store3d' }, { name: 'jbOut', kind: 'store3d' },
    ], [structsSrc, thinSrc]);
    this.pMip = new ComputePass(device, 'mip', [
      { name: 'src0', kind: 'tex3d' }, { name: 'src1', kind: 'tex3d' }, { name: 'src2', kind: 'tex3d' },
      { name: 'dst0', kind: 'store3d' }, { name: 'dst1', kind: 'store3d' }, { name: 'dst2', kind: 'store3d' },
    ], [mipSrc]);
    this.pMip1 = new ComputePass(device, 'mip1', [{ name: 'src0', kind: 'tex3d' }, { name: 'dst0', kind: 'store3d' }], [mip1Src]);
    this.pGlow = new ComputePass(device, 'glow', [
      ...direct.filter((d) => d.name !== 'glowTex'), { name: 'glowTex', kind: 'tex3d' },
      { name: 'S', kind: 'uniform', type: 'Sheets' }, { name: 'glowOut', kind: 'store3d' },
    ], [structsSrc, sceneSrc, directSrc, glowSrc]);
    this.pRadcache = new ComputePass(device, 'radcache', [
      ...direct, { name: 'albedoTex', kind: 'tex3d' }, { name: 'emitTex', kind: 'tex3d' }, { name: 'c0Tex', kind: 'tex3d' },
      { name: 'radOut', kind: 'store3d' },
    ], [structsSrc, sceneSrc, directSrc, gatherSrc, radcacheSrc]);
    this.pCascade = new ComputePass(device, 'cascade', [
      ...scene, { name: 'C', kind: 'uniform', type: 'CascadeParams' }, { name: 'upperTex', kind: 'tex3d' }, { name: 'outTex', kind: 'store3d' },
    ], [structsSrc, sceneSrc, cascadeSrc]);
    this.pFluence = new ComputePass(device, 'fluence', [
      { name: 'F', kind: 'uniform', type: 'FluenceParams' }, { name: 'c1Tex', kind: 'tex3d' }, { name: 'fluOut', kind: 'store3d' },
    ], [fluenceSrc]);
    this.pLighting = new ComputePass(device, 'lighting', [
      ...direct, { name: 'c0Tex', kind: 'tex3d' }, { name: 'fluTex', kind: 'tex3d' }, { name: 'CAM', kind: 'uniform', type: 'Camera' },
      { name: 'gAlbedo', kind: 'tex2d' }, ...gbuf, { name: 'gEmissive', kind: 'tex2d' },
      { name: 'causticTex', kind: 'tex2d' }, { name: 'litOut', kind: 'store2d' },
    ], [structsSrc, sceneSrc, directSrc, gatherSrc, lightingSrc]);
    this.pMeasure = new ComputePass(device, 'measure', [
      ...direct, { name: 'c0Tex', kind: 'tex3d' },
      { name: 'pts', kind: 'storage', type: 'MeterPoint' }, { name: 'outE', kind: 'storage_rw', type: 'vec4f' },
    ], [structsSrc, sceneSrc, directSrc, gatherSrc, measureSrc]);
    this.pGlassLight = new ComputePass(device, 'glass', [
      ...direct, { name: 'c0Tex', kind: 'tex3d' }, { name: 'CAM', kind: 'uniform', type: 'Camera' },
      { name: 'ggNormal', kind: 'tex2d' }, { name: 'ggAux', kind: 'tex2d' }, { name: 'ggDepth', kind: 'depth2d' }, { name: 'gDepth', kind: 'depth2d' },
      { name: 'reflOut', kind: 'store2d' }, { name: 'scatOut', kind: 'store2d' },
    ], [structsSrc, sceneSrc, directSrc, gatherSrc, glassLightSrc]);
    this.pCaustic = new ComputePass(device, 'caustic', [
      ...direct, { name: 'CAM', kind: 'uniform', type: 'CausticCamera' }, { name: 'OBJ', kind: 'uniform', type: 'CausticObjects' },
      ...gbuf, { name: 'photons', kind: 'storage_rw', type: 'atomic<u32>' },
    ], [structsSrc, sceneSrc, directSrc, causticSrc], 'trace');
    this.pCausticH = new ComputePass(device, 'causticH', [
      { name: 'B', kind: 'uniform', type: 'BlurParams' }, { name: 'photons', kind: 'storage', type: 'u32' }, ...gbuf, { name: 'tmpOut', kind: 'store2d' },
    ], [causticBlurSrc, causticHSrc]);
    this.pCausticV = new ComputePass(device, 'causticV', [
      { name: 'B', kind: 'uniform', type: 'BlurParams' }, { name: 'tmpTex', kind: 'tex2d' }, ...gbuf, { name: 'causticOut', kind: 'store2d' },
    ], [causticBlurSrc, causticVSrc]);

    this.buildBindGroups();
  }

  private makeStorage(size: number): GPUBuffer {
    return this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  private makeLevels(label: string): CascadeLevel[] {
    const c = this.config;
    const coneTan = (res: number) => { const k = 1 - 2 / (res * res); return Math.sqrt(Math.max(1 - k * k, 0)) / k; };
    const g0 = [c.grid[0] / c.probeDiv, c.grid[1] / c.probeDiv, c.grid[2] / c.probeDiv];
    const t0 = c.t0 * this.probeSpacing;
    const levels: CascadeLevel[] = [];
    for (let n = 0; n < c.cascades; n++) {
      const grid: [number, number, number] = [
        Math.max(1, Math.ceil(g0[0] / 2 ** n)), Math.max(1, Math.ceil(g0[1] / 2 ** n)), Math.max(1, Math.ceil(g0[2] / 2 ** n)),
      ];
      const traced = 8 * 2 ** n;
      const sub = n === 0 ? 1 : 2;
      const stored = traced / sub;
      const tA = n === 0 ? c.tNear * this.probeSpacing : t0 * c.intervalScale ** (n - 1);
      const tB = n === c.cascades - 1 ? 1e4 : t0 * c.intervalScale ** n;
      const size: [number, number, number] = [grid[0] * stored, grid[1] * stored, grid[2]];
      this.memoryBytes += size[0] * size[1] * size[2] * 8;
      const texture = this.device.createTexture({
        label: `${label}${n}`, dimension: '3d', format: F16,
        size: { width: size[0], height: size[1], depthOrArrayLayers: size[2] },
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      });
      levels.push({
        grid, spacing: this.probeSpacing * 2 ** n, stored, traced, sub, tA, tB,
        texture, view: texture.createView(),
        ubo: this.device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
        rays: grid[0] * grid[1] * grid[2] * traced * traced,
      });
    }
    const N = levels.length;
    levels.forEach((l, n) => {
      const up = levels[Math.min(n + 1, N - 1)];
      const steps = n === N - 1 ? 72 : Math.min(12 + n * 12, 56);
      this.device.queue.writeBuffer(l.ubo, 0, new Float32Array([
        l.grid[0], l.grid[1], l.grid[2], l.spacing,
        l.stored, l.traced, l.sub, n,
        l.tA, l.tB, coneTan(l.traced), n === N - 1 ? 1 : 0,
        up.grid[0], up.grid[1], up.grid[2], up.stored,
        steps, 0, 0, 0,
      ]));
    });
    return levels;
  }

  /** Resources shared by every pass that includes scene.wgsl / direct.wgsl. */
  private sceneViews(rad: GPUTexture): Views {
    return {
      G: { buffer: this.globals }, samp: this.sampler, geomTex: this.geom.createView(), radTex: rad.createView(),
      glassTex: this.glass.createView(), jTex: this.jTex[0].createView(), jtA: this.jTex[1].createView(), jtB: this.jTex[2].createView(),
      glowTex: this.glow.createView(), skyTex: this.sky.createView(), skySamp: this.skySampler, etchTex: this.etch.createView(),
    };
  }

  private cascadeGroups(levels: CascadeLevel[], rad: GPUTexture): GPUBindGroup[] {
    const N = levels.length;
    const views = this.sceneViews(rad);
    return levels.map((l, n) => this.pCascade.bind({
      ...views, C: { buffer: l.ubo },
      // The top cascade has nothing above it; bind any other cascade as a placeholder.
      upperTex: levels[n === N - 1 ? (n === 0 ? 0 : n - 1) : n + 1].view, outTex: l.view,
    }));
  }

  private buildBindGroups() {
    const g = { buffer: this.globals };
    const mip = (t: GPUTexture, level: number) => t.createView({ baseMipLevel: level, mipLevelCount: 1 });
    this.bgVoxelize = this.pVoxelize.bind({
      G: g, prims: { buffer: this.primBuf }, samp: this.sampler, jtB: this.jTex[2].createView(),
      geomOut: this.geom.createView(), albedoOut: this.albedo.createView(), emitOut: this.emit.createView(), glassOut: this.glass.createView(),
    });
    this.bgThin = this.pThin.bind({ G: g, segs: { buffer: this.segBuf }, jOut: mip(this.jTex[0], 0), jaOut: mip(this.jTex[1], 0), jbOut: mip(this.jTex[2], 0) });
    this.bgMips = [];
    this.bgGlowMips = [];
    for (let m = 1; m < this.jMips; m++) {
      this.bgMips.push(this.pMip.bind({
        src0: mip(this.jTex[0], m - 1), src1: mip(this.jTex[1], m - 1), src2: mip(this.jTex[2], m - 1),
        dst0: mip(this.jTex[0], m), dst1: mip(this.jTex[1], m), dst2: mip(this.jTex[2], m),
      }));
      this.bgGlowMips.push(this.pMip1.bind({ src0: mip(this.glow, m - 1), dst0: mip(this.glow, m) }));
    }
    // The glow pass writes mip 0 of the glow volume, so it cannot also sample it: it is given
    // the emission volume in that slot (its shadow rays never read it).
    this.bgGlow = this.pGlow.bind({ ...this.sceneViews(this.rad[0]), glowTex: this.jTex[0].createView(), S: { buffer: this.sheetBuf }, glowOut: mip(this.glow, 0) });
    // radcache[i] reads rad[i] (previous) and writes rad[1 - i]; cascade[i][n] reads rad[i].
    this.bgRadcache = [0, 1].map((i) => this.pRadcache.bind({
      ...this.sceneViews(this.rad[i]), albedoTex: this.albedo.createView(), emitTex: this.emit.createView(),
      c0Tex: this.levels[0].view, radOut: this.rad[1 - i].createView(),
    }));
    this.bgCascade = [0, 1].map((i) => this.cascadeGroups(this.levels, this.rad[i]));
    if (this.directLevels) this.bgCascadeDirect = this.cascadeGroups(this.directLevels, this.emit);
    this.bgFluence = this.pFluence.bind({ F: { buffer: this.fluenceBuf }, c1Tex: this.levels[Math.min(1, this.levels.length - 1)].view, fluOut: this.fluence.createView() });
    this.bgLighting.clear();
    this.bgCaustic = undefined;
    this.bgGlass = undefined;
  }

  setDomain(min: [number, number, number]) { this.domainMin = min; this.sceneDirty = true; }
  setLighting(l: Lighting) { this.lighting = l; }
  get domain() { return { min: this.domainMin, size: this.domainSize }; }

  /** Interior box of the room and its openings (APERTURE_FLOATS per opening, see the Aperture struct). */
  setRoom(min: [number, number, number], max: [number, number, number], apertures: Float32Array, count: number) {
    this.roomMin = min;
    this.roomMax = max;
    this.apertureCount = Math.min(count, MAX_APERTURES);
    this.apertureData.fill(0);
    this.apertureData.set(apertures.subarray(0, this.apertureCount * APERTURE_FLOATS));
  }

  setSpots(data: Float32Array, count: number) {
    this.spotCount = Math.min(count, MAX_SPOTS);
    this.spotData.fill(0);
    this.spotData.set(data.subarray(0, this.spotCount * SPOT_FLOATS));
  }

  /** Frosted glass sheets that scatter direct light (SHEET_FLOATS each, see glow.wgsl). */
  setSheets(data: Float32Array, count: number) {
    this.sheetCount = Math.min(count, MAX_SHEETS);
    const buf = new Float32Array(4 + MAX_SHEETS * SHEET_FLOATS);
    buf[0] = this.sheetCount;
    buf.set(data.subarray(0, this.sheetCount * SHEET_FLOATS), 4);
    this.device.queue.writeBuffer(this.sheetBuf, 0, buf);
  }

  /** Glass objects that cast sun caustics (CAUSTIC_OBJECT_FLOATS each, see caustic.wgsl). */
  setCausticObjects(data: Float32Array, count: number) {
    this.causticCount = Math.min(count, MAX_CAUSTIC_OBJECTS);
    const buf = new Float32Array(4 + MAX_CAUSTIC_OBJECTS * CAUSTIC_OBJECT_FLOATS);
    buf[0] = this.causticCount;
    buf.set(data.subarray(0, this.causticCount * CAUSTIC_OBJECT_FLOATS), 4);
    this.device.queue.writeBuffer(this.causticObjBuf, 0, buf);
  }

  /**
   * The one glass panel whose frost can be etched: its frame (centre + half width, unit u +
   * half height, unit v) and the mask, ETCH_SIZE squared bytes, 255 where frost is removed.
   */
  setEtch(frame: ArrayLike<number> | null, mask?: Uint8Array) {
    this.etchFrame.fill(0);
    if (frame) { this.etchFrame.set(frame); this.etchFrame[11] = 1; }
    if (mask) {
      const rgba = new Uint8Array(ETCH_SIZE * ETCH_SIZE * 4);
      for (let i = 0; i < ETCH_SIZE * ETCH_SIZE; i++) { rgba[i * 4] = mask[i]; rgba[i * 4 + 3] = 255; }
      this.device.queue.writeTexture({ texture: this.etch }, rgba, { bytesPerRow: ETCH_SIZE * 4 }, { width: ETCH_SIZE, height: ETCH_SIZE });
    }
  }

  /** Uploads the exterior radiance map: 128 x 64 RGBA floats, equirectangular, row 0 at the zenith. */
  setSky(texels: Float32Array) {
    const half = new Uint16Array(texels.length);
    for (let i = 0; i < texels.length; i++) half[i] = toHalf(texels[i]);
    this.device.queue.writeTexture({ texture: this.sky }, half, { bytesPerRow: 128 * 8 }, { width: 128, height: 64 });
  }

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

  private get causticsActive() {
    return this.causticResolution > 0 && this.causticCount > 0 && this.lighting.sunEnabled;
  }

  private writeGlobals(bounceGain: number) {
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
    put(c.hitBand * c.voxel, bounceGain, this.frame, L.skyGain);
    put(sd[0] / sl, sd[1] / sl, sd[2] / sl, L.sunTan);
    put(L.sunIrradiance[0], L.sunIrradiance[1], L.sunIrradiance[2], L.sunEnabled ? 1 : 0);
    put(this.roomMin[0], this.roomMin[1], this.roomMin[2], this.apertureCount);
    put(this.roomMax[0], this.roomMax[1], this.roomMax[2], this.spotCount);
    put(this.reflections ? 1 : 0, this.causticsActive ? 1 : 0, this.hazeExtinction, this.glowActive ? 1 : 0);
    put(this.primCount, this.segCount, this.debugMode, this.debugParam);
    d.set(this.etchFrame, o); o += 12;
    d.set(this.apertureData, o); o += this.apertureData.length;
    d.set(this.spotData, o); o += this.spotData.length;
    for (let k = 0; k < 64; k++) {
      const dir = squareToSphere(((k % 8) + 0.5) / 8, (Math.floor(k / 8) + 0.5) / 8);
      put(dir[0], dir[1], dir[2], 0);
    }
    this.device.queue.writeBuffer(this.globals, 0, d);
  }

  private get glowActive() { return this.sheetCount > 0 && (this.lighting.sunEnabled || this.spotCount > 0); }
  private glowWasActive = false;

  private run(encoder: GPUCommandEncoder, label: string, pass: ComputePass, bg: GPUBindGroup, x: number, y: number, z: number) {
    const p = encoder.beginComputePass({ label, timestampWrites: this.timer.writes(label) });
    p.setPipeline(pass.pipeline);
    p.setBindGroup(0, bg);
    p.dispatchWorkgroups(x, y, z);
    p.end();
  }

  /** Runs voxelisation (if the scene changed) and the cascade solve. */
  solve(encoder: GPUCommandEncoder) {
    this.frame++;
    this.writeGlobals(this.lighting.bounceGain);
    const c = this.config;
    const c4 = (n: number) => Math.ceil(n / 4);
    const jg = this.jGrid;
    if (this.sceneDirty) {
      // Thin emitters first: the voxeliser stores their distance next to the solid distance.
      this.run(encoder, 'thin', this.pThin, this.bgThin, c4(jg[0]), c4(jg[1]), c4(jg[2]));
      this.bgMips.forEach((bg, i) => {
        const s = 2 ** (i + 1);
        this.run(encoder, 'thin', this.pMip, bg, c4(Math.max(1, jg[0] / s)), c4(Math.max(1, jg[1] / s)), c4(Math.max(1, jg[2] / s)));
      });
      this.run(encoder, 'voxelize', this.pVoxelize, this.bgVoxelize, c4(c.grid[0]), c4(c.grid[1]), c4(c.grid[2]));
      this.sceneDirty = false;
    }
    // Frosted glass under a direct beam; run once more after it stops so the volume is cleared.
    if (this.glowActive || this.glowWasActive) {
      this.run(encoder, 'glow', this.pGlow, this.bgGlow, c4(jg[0]), c4(jg[1]), c4(jg[2]));
      this.bgGlowMips.forEach((bg, i) => {
        const s = 2 ** (i + 1);
        this.run(encoder, 'glow', this.pMip1, bg, c4(Math.max(1, jg[0] / s)), c4(Math.max(1, jg[1] / s)), c4(Math.max(1, jg[2] / s)));
      });
      this.glowWasActive = this.glowActive;
    }
    for (let it = 0; it < this.iterations; it++) {
      this.run(encoder, 'radcache', this.pRadcache, this.bgRadcache[this.radIndex], c4(c.grid[0]), c4(c.grid[1]), c4(c.grid[2]));
      this.radIndex = 1 - this.radIndex;
      this.runCascades(encoder, this.levels, this.bgCascade[this.radIndex]);
    }
    const l1 = this.levels[Math.min(1, this.levels.length - 1)];
    if (this.hazeExtinction > 0) this.run(encoder, 'fluence', this.pFluence, this.bgFluence, c4(l1.grid[0]), c4(l1.grid[1]), c4(l1.grid[2]));
  }

  private runCascades(encoder: GPUCommandEncoder, levels: CascadeLevel[], groups: GPUBindGroup[]) {
    for (let n = levels.length - 1; n >= 0; n--) {
      const l = levels[n];
      this.run(encoder, `cascade${n}`, this.pCascade, groups[n], Math.ceil((l.grid[0] * l.stored) / 8), Math.ceil((l.grid[1] * l.stored) / 8), l.grid[2]);
    }
  }

  /**
   * Solves direct light only (emitters seen directly, no bounces) into a second cascade set.
   * Used by the direct / full comparison; allocated on first use.
   */
  solveDirect(encoder: GPUCommandEncoder) {
    if (!this.directLevels) {
      this.directLevels = this.makeLevels('gi.direct');
      this.bgCascadeDirect = this.cascadeGroups(this.directLevels, this.emit);
    }
    this.runCascades(encoder, this.directLevels, this.bgCascadeDirect);
  }

  private ensureScreen(gb: GBuffer, width: number, height: number) {
    const key = [gb.albedo, gb.normal, gb.emissive, gb.depth, width, height];
    if (key.every((k, i) => k === this.screenKey[i])) return;
    this.screenKey = key;
    this.bgLighting.clear();
    this.bgCaustic = undefined;
    if (width !== this.causticSize[0] || height !== this.causticSize[1]) {
      this.photons?.destroy(); this.causticTmp?.destroy(); this.causticTex?.destroy();
      this.photons = undefined; this.causticTmp = undefined; this.causticTex = undefined;
      this.causticSize = [width, height];
    }
  }

  private ensureCaustic(gb: GBuffer) {
    const [w, h] = this.causticSize;
    if (!this.photons) {
      this.photons = this.device.createBuffer({ size: w * h * 12, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      const tex = (label: string) => this.device.createTexture({ label, format: F16, size: { width: w, height: h }, usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
      this.causticTmp = tex('gi.causticTmp');
      this.causticTex = tex('gi.caustic');
      this.bgCaustic = undefined;
      this.bgLighting.clear();
    }
    if (!this.bgCaustic) {
      const gbuf = { gNormal: gb.normal.createView(), gDepth: gb.depth.createView({ aspect: 'depth-only' }) };
      this.bgCaustic = this.pCaustic.bind({ ...this.sceneViews(this.rad[0]), CAM: { buffer: this.causticCamBuf }, OBJ: { buffer: this.causticObjBuf }, ...gbuf, photons: { buffer: this.photons } });
      this.bgCausticH = this.pCausticH.bind({ B: { buffer: this.blurBuf }, photons: { buffer: this.photons }, ...gbuf, tmpOut: this.causticTmp!.createView() });
      this.bgCausticV = this.pCausticV.bind({ B: { buffer: this.blurBuf }, tmpTex: this.causticTmp!.createView(), ...gbuf, causticOut: this.causticTex!.createView() });
    }
  }

  /**
   * Shades the G-buffer into `lit`. With `direct`, the direct-only cascade set is used.
   * Texture arguments are raw GPU textures owned by the renderer.
   */
  light(encoder: GPUCommandEncoder, gb: GBuffer, lit: GPUTexture, view: ViewState, direct = false) {
    this.ensureScreen(gb, view.width, view.height);
    const w = view.width, h = view.height;
    const caustics = this.causticsActive && !direct;
    if (caustics) {
      this.ensureCaustic(gb);
      const N = this.causticResolution;
      const d = this.causticCamData;
      d.set(view.viewProj, 0);
      d.set(view.invViewProj, 16);
      d.set([view.position[0], view.position[1], view.position[2], view.orthographic ? 1 : 0, w, h, N, CAUSTIC_SCALE, view.forward[0], view.forward[1], view.forward[2], view.pixelMeasure], 32);
      this.device.queue.writeBuffer(this.causticCamBuf, 0, d);
      this.device.queue.writeBuffer(this.blurBuf, 0, new Float32Array([w, h, 0, CAUSTIC_SCALE]));
      encoder.clearBuffer(this.photons!);
      this.run(encoder, 'caustics', this.pCaustic, this.bgCaustic!, Math.ceil(N / 8), Math.ceil(N / 8), this.causticCount);
      this.run(encoder, 'caustics', this.pCausticH, this.bgCausticH!, Math.ceil(w / 8), Math.ceil(h / 8), 1);
      this.run(encoder, 'caustics', this.pCausticV, this.bgCausticV!, Math.ceil(w / 8), Math.ceil(h / 8), 1);
    }
    const ri = this.radIndex;
    const key = `${direct ? 'd' : ri}:${caustics ? 1 : 0}`;
    let groups = this.bgLighting.get(lit);
    if (!groups) { groups = new Map(); this.bgLighting.set(lit, groups); }
    let bg = groups.get(key);
    if (!bg) {
      const levels = direct && this.directLevels ? this.directLevels : this.levels;
      bg = this.pLighting.bind({
        ...this.sceneViews(direct ? this.emit : this.rad[ri]), c0Tex: levels[0].view, fluTex: this.fluence.createView(), CAM: { buffer: this.cameraBuf },
        gAlbedo: gb.albedo.createView(), gNormal: gb.normal.createView(), gEmissive: gb.emissive.createView(),
        gDepth: gb.depth.createView({ aspect: 'depth-only' }),
        causticTex: (caustics ? this.causticTex! : this.noCaustic).createView(), litOut: lit.createView(),
      });
      groups.set(key, bg);
    }
    const d = this.cameraData;
    d.set(view.invViewProj, 0);
    d.set([
      view.position[0], view.position[1], view.position[2], view.orthographic ? 1 : 0,
      w, h, 1, 0,
      view.forward[0], view.forward[1], view.forward[2], 0,
      view.hazeTint[0], view.hazeTint[1], view.hazeTint[2], view.hazeAnisotropy,
    ], 16);
    this.device.queue.writeBuffer(this.cameraBuf, 0, d);
    this.run(encoder, 'lighting', this.pLighting, bg, Math.ceil(w / 8), Math.ceil(h / 8), 1);
  }

  /**
   * Lights the glass layer: reflection and frost scatter for every glass pixel in front of
   * the opaque scene. Call after light(); it reuses that call's camera.
   */
  lightGlass(encoder: GPUCommandEncoder, glass: { normal: GPUTexture; aux: GPUTexture; depth: GPUTexture }, opaqueDepth: GPUTexture, refl: GPUTexture, scat: GPUTexture, width: number, height: number) {
    const key = [glass.normal, glass.aux, glass.depth, opaqueDepth, refl, scat, this.radIndex];
    if (!this.bgGlass || key.some((k, i) => k !== this.glassKey[i])) {
      this.bgGlass = this.pGlassLight.bind({
        ...this.sceneViews(this.rad[this.radIndex]), c0Tex: this.levels[0].view, CAM: { buffer: this.cameraBuf },
        ggNormal: glass.normal.createView(), ggAux: glass.aux.createView(), ggDepth: glass.depth.createView({ aspect: 'depth-only' }),
        gDepth: opaqueDepth.createView({ aspect: 'depth-only' }), reflOut: refl.createView(), scatOut: scat.createView(),
      });
      this.glassKey = key;
    }
    this.run(encoder, 'glass', this.pGlassLight, this.bgGlass, Math.ceil(width / 8), Math.ceil(height / 8), 1);
  }
  private bgGlass?: GPUBindGroup;
  private glassKey: unknown[] = [];

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
    const bg = this.pMeasure.bind({ ...this.sceneViews(this.rad[this.radIndex]), c0Tex: this.levels[0].view, pts: { buffer: inBuf }, outE: { buffer: outBuf } });
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
    const tex = [this.sky, this.etch, this.noCaustic, this.geom, this.albedo, this.emit, this.glass, ...this.rad, ...this.jTex, this.glow, this.fluence,
      ...this.levels.map((l) => l.texture), ...(this.directLevels ?? []).map((l) => l.texture), this.causticTmp, this.causticTex];
    for (const t of tex) t?.destroy();
    const buf = [this.globals, this.cameraBuf, this.sheetBuf, this.fluenceBuf, this.causticCamBuf, this.causticObjBuf, this.blurBuf, this.primBuf, this.segBuf,
      ...this.levels.map((l) => l.ubo), ...(this.directLevels ?? []).map((l) => l.ubo), this.photons];
    for (const b of buf) b?.destroy();
  }
}
