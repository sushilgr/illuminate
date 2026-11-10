// Illuminate: lighting-core prototype.
// Scope of this stage: world-space Radiance Cascades with one thin emitter, blockers and a
// coloured bounce surface, a deferred shading pass, and diagnostics. The full interface,
// painting, glass and motion systems build on this foundation.
import * as THREE from 'three/webgpu';
import { mrt, normalWorld, output, renderOutput, screenUV, texture, uniform, vec4 } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GISystem, type GIConfig } from './gi/GISystem';
import { createAtelier } from './scene/atelier';
import { SceneRuntime } from './scene/SceneRuntime';
import type { RibbonObject } from './scene/types';

const params = new URLSearchParams(location.search);
const num = (k: string, d: number) => (params.has(k) ? Number(params.get(k)) : d);

const QUALITY: Record<string, GIConfig> = {
  // Domain is 6.72 x 3.36 x 5.6 m in every tier; only the sampling density changes.
  tiny:   { voxel: 0.14,   grid: [48, 24, 40],    probeDiv: 2, jDiv: 1, cascades: 4, tNear: 1.0, t0: 1.5, intervalScale: 2.8 },
  low:    { voxel: 0.07,   grid: [96, 48, 80],    probeDiv: 2, jDiv: 1, cascades: 5, tNear: 1.0, t0: 1.5, intervalScale: 2.8 },
  medium: { voxel: 0.0525, grid: [128, 64, 104],  probeDiv: 2, jDiv: 2, cascades: 6, tNear: 1.0, t0: 1.5, intervalScale: 2.5 },
  high:   { voxel: 0.035,  grid: [192, 96, 160],  probeDiv: 2, jDiv: 2, cascades: 6, tNear: 1.0, t0: 1.5, intervalScale: 2.5 },
};

function notice(title: string, body: string) {
  const el = document.getElementById('notice')!;
  el.style.display = 'grid';
  el.querySelector('h1')!.textContent = title;
  el.querySelector('p')!.textContent = body;
}

async function start() {
  if (!('gpu' in navigator)) {
    notice('WebGPU is not available', 'Illuminate computes its lighting with WebGPU compute shaders. Open it in a current version of Chrome, Edge or Safari on a device with WebGPU enabled.');
    return;
  }
  const renderer = new THREE.WebGPURenderer({ antialias: false, powerPreference: 'high-performance' });
  await renderer.init();
  const backend = renderer.backend as unknown as { device?: GPUDevice; get(o: unknown): { texture?: GPUTexture }; isWebGPUBackend?: boolean };
  if (!backend.isWebGPUBackend || !backend.device) {
    notice('WebGPU is not available', 'The renderer fell back to WebGL, which cannot run the lighting solver. Open Illuminate in a browser with WebGPU enabled.');
    return;
  }
  const device = backend.device;
  device.lost.then((info) => {
    (window as unknown as { __lost?: string }).__lost = `${info.reason}: ${info.message}`;
    console.error('WebGPU device lost', info.reason, info.message);
  });
  const view = document.getElementById('view')!;
  view.appendChild(renderer.domElement);
  renderer.toneMapping = THREE.NoToneMapping;

  const qualityName = params.get('q') ?? 'high';
  const cfg = { ...(QUALITY[qualityName] ?? QUALITY.high) };
  cfg.cascades = num('cascades', cfg.cascades);
  cfg.intervalScale = num('scale', cfg.intervalScale);
  cfg.t0 = num('t0', cfg.t0);
  const gi = new GISystem(device, cfg);
  gi.debugMode = num('dbg', 0);
  gi.debugParam = num('dbgp', 0);
  gi.iterations = num('iter', 1);

  const runtime = new SceneRuntime(createAtelier(), gi);
  const scene = new THREE.Scene();
  scene.add(runtime.root);

  const camera = new THREE.PerspectiveCamera(num('fov', 38), 1, 0.05, 60);
  camera.position.set(num('cx', -2.35), num('cy', 1.5), num('cz', 2.15));
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(num('tx', 0.35), num('ty', 1.05), num('tz', -0.7));
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.update();

  // G-buffer: albedo, world normal, emitted radiance, depth.
  const gbuffer = new THREE.RenderTarget(4, 4, { count: 3, type: THREE.HalfFloatType, depthBuffer: true });
  gbuffer.textures[0].name = 'output';
  gbuffer.textures[1].name = 'normal';
  gbuffer.textures[2].name = 'emissive';
  for (const t of gbuffer.textures) { t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; }
  gbuffer.depthTexture = new THREE.DepthTexture(4, 4);
  gbuffer.depthTexture.type = THREE.FloatType;
  const gbufferMRT = mrt({ output, normal: vec4(normalWorld, 1), emissive: vec4(0, 0, 0, 1) });

  // Lit HDR image written by the deferred lighting compute pass.
  let lit = new THREE.StorageTexture(4, 4);
  const exposure = uniform(2 ** num('ev', 0));
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  const litNode = texture(lit, screenUV);
  pipeline.outputNode = renderOutput(vec4(litNode.rgb.mul(exposure), 1), THREE.AgXToneMapping, THREE.SRGBColorSpace);

  // ?capture renders the final image into a texture and exposes capture() for read-back.
  const captureRT = params.has('capture') ? new THREE.RenderTarget(4, 4, { type: THREE.UnsignedByteType, depthBuffer: false }) : null;
  let width = 0, height = 0;
  const renderScale = num('rs', 1);
  function resize() {
    const w = Math.max(view.clientWidth, 1), h = Math.max(view.clientHeight, 1);
    const dpr = Math.min(window.devicePixelRatio || 1, num('dpr', 1.5)) * renderScale;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    width = size.x; height = size.y;
    gbuffer.setSize(width, height);
    captureRT?.setSize(width, height);
    lit.dispose();
    lit = new THREE.StorageTexture(width, height);
    lit.type = THREE.HalfFloatType;
    lit.minFilter = THREE.LinearFilter;
    lit.magFilter = THREE.LinearFilter;
    lit.generateMipmaps = false;
    renderer.initTexture(lit);
    litNode.value = lit;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(view);

  // --- prototype controls ---------------------------------------------------------------
  const state = { paused: params.has('paused'), time: num('time', 0), bounce: num('bounce', 1), emitter: true, frames: 0 };
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') { state.paused = !state.paused; e.preventDefault(); }
    else if (e.key >= '0' && e.key <= '8') gi.debugMode = Number(e.key);
    else if (e.key === 'b') state.bounce = state.bounce > 0 ? 0 : 1;
    else if (e.key === 'e') state.emitter = !state.emitter;
    else if (e.key === 'ArrowRight') gi.debugParam = (gi.debugParam + 1) % 16;
    else if (e.key === 'ArrowLeft') gi.debugParam = (gi.debugParam + 15) % 16;
    else if (e.key === '=' || e.key === '+') exposure.value *= 2 ** 0.25;
    else if (e.key === '-') exposure.value /= 2 ** 0.25;
    else if (e.key === 'i') gi.iterations = gi.iterations === 1 ? 2 : 1;
    else if (e.key === 'h') hud.style.display = hud.style.display === 'none' ? '' : 'none';
  });

  const hud = document.getElementById('hud')!;
  if (params.has('nohud')) hud.style.display = 'none';
  const modes = ['final', 'irradiance', 'albedo', 'normal', 'near-field visibility', 'voxel proxy distance', 'cascade 0 direction', 'radiance cache', 'sun'];
  const invViewProj = new THREE.Matrix4();
  const clock = new THREE.Clock();
  let cpuMs = 0, frameMs = 16.7, last = performance.now();

  function animate(t: number) {
    // Slow default motion: the ribbon sways and breathes, the screen turns.
    const ribbon = runtime.object('ribbon') as RibbonObject;
    ribbon.rotation[1] = 0.22 + 0.16 * Math.sin((t / 14) * Math.PI * 2);
    ribbon.position[1] = 1.72 + 0.05 * Math.sin((t / 9) * Math.PI * 2);
    ribbon.level = state.emitter ? 0.86 + 0.14 * Math.sin((t / 7) * Math.PI * 2) : 0;
    const screen = runtime.object('screen')!;
    screen.rotation[1] = -2.05 + 0.3 * Math.sin((t / 18) * Math.PI * 2);
    runtime.touch();
  }

  function frame() {
    const now = performance.now();
    frameMs = frameMs * 0.95 + (now - last) * 0.05;
    last = now;
    const dt = clock.getDelta();
    if (!state.paused) state.time += dt;
    const t0 = performance.now();

    animate(state.time);
    controls.update();
    gi.setLighting(runtime.lighting(state.bounce));
    runtime.sync();

    renderer.setMRT(gbufferMRT);
    renderer.setRenderTarget(gbuffer);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.setMRT(null);

    const tex = (t: THREE.Texture) => backend.get(t).texture!;
    invViewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    const encoder = device.createCommandEncoder({ label: 'illuminate.gi' });
    gi.timer.begin();
    gi.solve(encoder);
    gi.light(encoder, {
      albedo: tex(gbuffer.textures[0]), normal: tex(gbuffer.textures[1]), emissive: tex(gbuffer.textures[2]), depth: tex(gbuffer.depthTexture!),
    }, tex(lit), { invViewProj: invViewProj.elements, position: [camera.position.x, camera.position.y, camera.position.z], width, height });
    gi.timer.resolve(encoder);
    device.queue.submit([encoder.finish()]);
    gi.timer.collect();

    if (captureRT) {
      // Headless / still capture path: the display transform runs into a texture instead of the canvas.
      renderer.setRenderTarget(captureRT);
      pipeline.render();
      renderer.setRenderTarget(null);
    } else {
      pipeline.render();
    }
    cpuMs = cpuMs * 0.95 + (performance.now() - t0) * 0.05;
    state.frames++;

    if (state.frames % 20 === 0 && hud.style.display !== 'none') {
      const tm = gi.timer;
      const ms = (k: string) => (tm.results.get(k) ?? 0).toFixed(2);
      const casc = gi.levels.map((_, n) => ms(`cascade${n}`)).join(' ');
      hud.innerHTML =
        `<b>Illuminate</b>  lighting core prototype\n` +
        `${width} x ${height}   ${(1000 / frameMs).toFixed(0)} fps   cpu ${cpuMs.toFixed(2)} ms\n` +
        `gpu  voxelize ${ms('voxelize')}  thin ${ms('thin')}  cache ${ms('radcache')}  lighting ${ms('lighting')}\n` +
        `     cascades ${casc}\n` +
        `     total ${tm.total().toFixed(2)} ms${tm.supported ? '' : ' (timestamp queries unavailable)'}\n` +
        `gi   ${qualityName}: voxel ${(cfg.voxel * 100).toFixed(1)} cm, ${gi.levels.length} cascades, ${(gi.totalRays / 1e6).toFixed(2)} M rays, ${(gi.memoryBytes / 2 ** 20).toFixed(0)} MB\n` +
        `view <b>${modes[gi.debugMode] ?? gi.debugMode}</b>${gi.debugMode === 6 ? ' ' + gi.debugParam : ''}   bounce ${state.bounce ? 'on' : 'off'}   emitter ${state.emitter ? 'on' : 'off'}   iter ${gi.iterations}\n` +
        `keys 0-8 views   b bounce   e emitter   i iterations   space pause   -/= exposure   h hide`;
    }
  }
  // ?manual: frames are advanced explicitly through step() (used by headless checks).
  const manual = params.has('manual');
  if (!manual) {
    renderer.setAnimationLoop(frame);
    document.addEventListener('visibilitychange', () => {
      renderer.setAnimationLoop(document.hidden ? null : frame);
      if (!document.hidden) { clock.getDelta(); last = performance.now(); }
    });
  }
  async function step(n = 1) {
    for (let i = 0; i < n; i++) {
      frame();
      await device.queue.onSubmittedWorkDone();
    }
  }

  /** Reads the displayed image back and paints it onto a 2D canvas over the view. */
  async function capture(): Promise<boolean> {
    if (!captureRT) return false;
    const px = await renderer.readRenderTargetPixelsAsync(captureRT, 0, 0, width, height);
    let c = document.getElementById('capture') as HTMLCanvasElement | null;
    if (!c) {
      c = document.createElement('canvas');
      c.id = 'capture';
      c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%';
      view.appendChild(c);
    }
    c.width = width; c.height = height;
    const img = new ImageData(width, height);
    const src = new Uint8Array(px.buffer, px.byteOffset, width * height * 4);
    const rowBytes = src.length / height;
    for (let y = 0; y < height; y++) img.data.set(src.subarray(y * rowBytes, y * rowBytes + width * 4), y * width * 4);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    c.getContext('2d')!.putImageData(img, 0, 0);
    return true;
  }

  // Hooks for automated checks.
  Object.assign(window, { __illuminate: { gi, runtime, state, camera, controls, renderer, exposure, capture, step } });
}

start().catch((err) => {
  console.error(err);
  notice('Illuminate could not start', String(err?.message ?? err));
});
