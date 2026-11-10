// Application core: owns the renderer, the solver, the scene document and the scene clock.
// The interface (src/ui) and the editing tools (src/edit) talk to this class; the frame loop
// never goes through any interface code.
import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GISystem, type GIConfig } from '../gi/GISystem';
import { Renderer } from '../render/Renderer';
import { SceneDocument } from '../scene/Document';
import { SceneRuntime } from '../scene/SceneRuntime';
import { SCENE_VERSION, type Quality, type SceneDescription } from '../scene/types';

const COMMON = { probeDiv: 4, tNear: 1.0, t0: 2.0, intervalScale: 4, hitBand: 0.15, coverage: 0.35 };
/** The domain encloses the 6.16 x 3.3 x 5.04 m room with a wall margin in every tier. */
export const TIERS: Record<string, GIConfig> = {
  tiny:   { ...COMMON, voxel: 0.14,   grid: [48, 28, 40],    jDiv: 1, cascades: 2 },
  low:    { ...COMMON, voxel: 0.07,   grid: [96, 56, 80],    jDiv: 1, cascades: 3 },
  medium: { ...COMMON, voxel: 0.0525, grid: [128, 72, 108],  jDiv: 2, cascades: 3 },
  high:   { ...COMMON, voxel: 0.035,  grid: [192, 108, 160], jDiv: 2, cascades: 4 },
};
const ORDER = ['low', 'medium', 'high'] as const;

export const DEFAULT_QUALITY = (): Quality => ({ tier: 'auto', pixels: 2.1, iterations: 1, reflections: true, caustics: 'high', coverage: 0.35 });

export interface Stats {
  fps: number;
  frameMs: number;
  cpuMs: number;
  gpuMs: number;
  tier: string;
  width: number;
  height: number;
  rays: number;
  memoryMB: number;
}

export interface Clock {
  /** Position in the loop, seconds. */
  time: number;
  playing: boolean;
  /** Monotonic play time, used by fading strokes. */
  elapsed: number;
}

type Camera = THREE.PerspectiveCamera | THREE.OrthographicCamera;

export class App {
  readonly doc: SceneDocument;
  readonly clock: Clock = { time: 0, playing: true, elapsed: 0 };
  readonly stats: Stats = { fps: 0, frameMs: 16.7, cpuMs: 0, gpuMs: 0, tier: 'medium', width: 0, height: 0, rays: 0, memoryMB: 0 };
  readonly overlay = new THREE.Scene();
  gi!: GISystem;
  renderer!: Renderer;
  runtime!: SceneRuntime;
  camera: Camera;
  readonly controls: OrbitControls;
  quality: Quality;
  tier = 'medium';
  /** Diagnostic view of the lighting pass (0 = final image). */
  view = 0;
  bounce = 1;
  /** Listeners called once per frame after rendering (interface readouts). */
  readonly onFrame = new Set<() => void>();
  /** Called when the solver was rebuilt (tier change). */
  readonly onRebuild = new Set<() => void>();
  frames = 0;

  private readonly perspective = new THREE.PerspectiveCamera(40, 1, 0.05, 60);
  private readonly orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.05, 60);
  private last = performance.now();
  private manual = false;
  private capturing = false;
  /** Never present to the canvas (headless checks render into the capture target only). */
  private offscreen = false;
  private renderScale = 1;
  private slow = 0;
  private fast = 0;
  private cssSize = new THREE.Vector2(1, 1);
  /** Interface panels over the viewport (CSS px); the picture is centred in what remains visible. */
  private insets = { left: 0, right: 0, top: 0, bottom: 0 };

  constructor(readonly three: THREE.WebGPURenderer, readonly host: HTMLElement, scene: SceneDescription, quality: Quality, opts: { manual?: boolean; tier?: string; offscreen?: boolean } = {}) {
    this.doc = new SceneDocument(scene);
    this.quality = quality;
    this.manual = !!opts.manual;
    this.offscreen = !!opts.offscreen;
    this.camera = this.perspective;
    host.appendChild(three.domElement);
    this.controls = new OrbitControls(this.perspective, three.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.addEventListener('end', () => this.storeCamera());
    this.tier = opts.tier ?? (quality.tier === 'auto' ? 'medium' : quality.tier);
    this.build();
    this.applyCamera();
    new ResizeObserver(() => this.resize()).observe(host);
    this.doc.on((kind) => { if (kind === 'load') this.applyCamera(); });
    if (!this.manual) {
      three.setAnimationLoop(() => this.frame());
      document.addEventListener('visibilitychange', () => {
        three.setAnimationLoop(document.hidden ? null : () => this.frame());
        this.last = performance.now();
      });
    }
  }

  get device(): GPUDevice { return (this.three.backend as unknown as { device: GPUDevice }).device; }

  /** (Re)creates everything that depends on the GI tier. */
  private build() {
    this.runtime?.dispose();
    this.renderer?.dispose();
    this.gi?.dispose();
    const cfg = { ...TIERS[this.tier] };
    cfg.coverage = this.quality.coverage;
    this.gi = new GISystem(this.device, cfg);
    this.renderer = new Renderer(this.three, this.gi);
    this.runtime = new SceneRuntime(this.gi, this.renderer.shared);
    this.renderer.onResize = () => this.runtime.refreshOptics();
    if (this.offscreen) this.renderer.enableCapture();
    this.stats.tier = this.tier;
    this.stats.rays = this.gi.totalRays;
    this.stats.memoryMB = Math.round(this.gi.memoryBytes / 2 ** 20);
    this.resize();
    for (const fn of this.onRebuild) fn();
  }

  setTier(tier: string) {
    if (tier === this.tier || !TIERS[tier]) return;
    this.tier = tier;
    this.build();
  }

  setQuality(q: Quality) {
    const rebuild = q.coverage !== this.quality.coverage;
    this.quality = q;
    if (q.tier !== 'auto' && q.tier !== this.tier) this.setTier(q.tier);
    else if (rebuild) this.build();
    this.resize();
  }

  resize() {
    const w = Math.max(this.host.clientWidth, 1), h = Math.max(this.host.clientHeight, 1);
    this.cssSize.set(w, h);
    // Pixel budget: the drawing buffer is capped (by default near 1080p), then scaled adaptively.
    const dpr = Math.min(window.devicePixelRatio || 1, Math.sqrt((this.quality.pixels * 1e6) / (w * h))) * this.renderScale;
    this.three.setPixelRatio(dpr);
    this.three.setSize(w, h);
    const size = this.three.getDrawingBufferSize(new THREE.Vector2());
    this.renderer.resize(size.x, size.y);
    this.stats.width = size.x;
    this.stats.height = size.y;
    this.updateProjection();
  }

  /** Tells the camera which part of the viewport the interface covers. */
  setInsets(insets: { left: number; right: number; top: number; bottom: number }) {
    this.insets = insets;
    this.updateProjection();
  }

  private updateProjection() {
    const c = this.doc.scene.camera;
    const aspect = this.cssSize.x / this.cssSize.y;
    // Shift the principal point to the centre of the uncovered area (never by more than a third of the frame).
    const w = this.cssSize.x, h = this.cssSize.y, i = this.insets;
    const ox = Math.min(Math.max((i.right - i.left) / 2, -w / 3), w / 3), oy = Math.min(Math.max((i.bottom - i.top) / 2, -h / 3), h / 3);
    for (const cam of [this.perspective, this.orthographic]) {
      if (ox === 0 && oy === 0) cam.clearViewOffset(); else cam.setViewOffset(w, h, ox, oy, w, h);
    }
    // 35 mm equivalent: the sensor is 24 mm tall.
    const fov = (2 * Math.atan(12 / c.focal) * 180) / Math.PI;
    this.perspective.fov = fov;
    this.perspective.aspect = aspect;
    this.perspective.updateProjectionMatrix();
    const dist = this.orthographic.position.distanceTo(this.controls.target);
    const halfH = dist * Math.tan((fov * Math.PI) / 360);
    this.orthographic.left = -halfH * aspect; this.orthographic.right = halfH * aspect;
    this.orthographic.top = halfH; this.orthographic.bottom = -halfH;
    this.orthographic.updateProjectionMatrix();
  }

  /** Moves the view camera to the document's camera. */
  applyCamera() {
    const c = this.doc.scene.camera;
    const cam = c.projection === 'orthographic' ? this.orthographic : this.perspective;
    cam.position.set(...c.position);
    this.controls.object = cam;
    this.controls.target.set(...c.target);
    this.camera = cam;
    this.controls.update();
    this.updateProjection();
  }

  /** Writes the view camera back into the document (after navigation). Not an undo step. */
  storeCamera() {
    const c = this.doc.scene.camera;
    c.position = this.camera.position.toArray() as [number, number, number];
    c.target = this.controls.target.toArray() as [number, number, number];
  }

  /** Loop phase 0..1. */
  get phase() { return (this.clock.time / Math.max(this.doc.scene.loop, 0.1)) % 1; }

  frame() {
    const now = performance.now();
    const dt = Math.min((now - this.last) / 1000, 0.1);
    const s = this.stats;
    s.frameMs = s.frameMs * 0.95 + (now - this.last) * 0.05;
    s.fps = 1000 / s.frameMs;
    this.last = now;
    const scene = this.doc.scene;
    if (this.clock.playing && !this.manual) {
      this.clock.time = (this.clock.time + dt) % Math.max(scene.loop, 0.1);
      this.clock.elapsed += dt;
    }
    const t0 = performance.now();
    this.controls.update();
    if (this.camera === this.orthographic) this.updateProjection();
    const gi = this.gi;
    gi.debugMode = this.view;
    gi.iterations = this.quality.iterations;
    gi.reflections = this.quality.reflections;
    gi.causticResolution = this.quality.caustics === 'off' ? 0 : this.quality.caustics === 'low' ? 192 : 384;
    gi.setLighting(this.runtime.sync(scene, this.phase, this.clock.elapsed, this.bounce));
    this.renderer.setFinish(scene.finish, scene.camera.exposure);
    this.renderer.render(this.runtime.opaque, this.runtime.glassLayer, this.runtime.glass, this.runtime.hasGlass, this.camera, scene.atmosphere,
      this.capturing || this.offscreen ? null : this.overlay, this.capturing || this.offscreen);
    s.cpuMs = s.cpuMs * 0.95 + (performance.now() - t0) * 0.05;
    s.gpuMs = gi.timer.total();
    this.frames++;
    if (!this.manual) this.adapt();
    for (const fn of this.onFrame) fn();
  }

  /**
   * Adaptive quality with hysteresis. Sustained slow frames first lower the render scale, then
   * drop a GI tier; sustained fast frames win them back in the opposite order. A change needs
   * about two seconds of evidence in one direction, so quality does not oscillate.
   */
  private adapt() {
    if (this.quality.tier !== 'auto' || document.hidden) return;
    const ms = this.stats.frameMs;
    if (ms > 21) { this.slow++; this.fast = 0; } else if (ms < 13.5) { this.fast++; this.slow = 0; } else { this.slow = 0; this.fast = 0; }
    if (this.slow > 120) {
      this.slow = 0;
      if (this.renderScale > 0.72) { this.renderScale = Math.max(this.renderScale - 0.14, 0.72); this.resize(); }
      else { const i = ORDER.indexOf(this.tier as typeof ORDER[number]); if (i > 0) { this.renderScale = 1; this.setTier(ORDER[i - 1]); } }
    } else if (this.fast > 600) {
      this.fast = 0;
      if (this.renderScale < 1) { this.renderScale = Math.min(this.renderScale + 0.14, 1); this.resize(); }
    }
  }

  // --- capture and automation ----------------------------------------------------------------

  /** Advances `n` frames, waiting for the GPU each time (headless checks, deterministic capture). */
  async step(n = 1) {
    for (let i = 0; i < n; i++) {
      this.frame();
      await this.device.queue.onSubmittedWorkDone();
    }
  }

  /** Renders the current view at `scale` times the display resolution and returns the image. */
  async still(scale = 1, settle = 6): Promise<ImageData> {
    const w = this.renderer.width, h = this.renderer.height;
    const wasManual = this.manual;
    this.manual = true;
    this.three.setAnimationLoop(null);
    this.renderer.enableCapture();
    this.capturing = true;
    if (scale !== 1) this.renderer.resize(Math.round(w * scale), Math.round(h * scale));
    await this.step(settle);
    const img = await this.renderer.readCapture();
    this.capturing = false;
    if (scale !== 1) this.renderer.resize(w, h);
    this.manual = wasManual;
    if (!wasManual) { this.last = performance.now(); this.three.setAnimationLoop(() => this.frame()); }
    return img;
  }

  /**
   * Renders one loop frame by frame at a fixed time step and hands each frame to `onFrame`.
   * Everything is a function of the loop phase, so the result is the same on every run.
   */
  async loopFrames(fps: number, onFrame: (img: ImageData, index: number, count: number) => Promise<void> | void, shouldStop?: () => boolean) {
    const count = Math.round(this.doc.scene.loop * fps);
    const wasManual = this.manual, wasPlaying = this.clock.playing, t = this.clock.time;
    this.manual = true;
    this.three.setAnimationLoop(null);
    this.renderer.enableCapture();
    this.capturing = true;
    // Settle the bounces on the first frame before recording.
    this.clock.time = 0;
    await this.step(8);
    for (let i = 0; i < count; i++) {
      if (shouldStop?.()) break;
      this.clock.time = (i / count) * this.doc.scene.loop;
      await this.step(1);
      await onFrame(await this.renderer.readCapture(), i, count);
    }
    this.capturing = false;
    this.clock.time = t;
    this.clock.playing = wasPlaying;
    this.manual = wasManual;
    if (!wasManual) { this.last = performance.now(); this.three.setAnimationLoop(() => this.frame()); }
  }

  serialize(): string {
    this.storeCamera();
    return JSON.stringify({ ...this.doc.scene, version: SCENE_VERSION }, null, 1);
  }
}
