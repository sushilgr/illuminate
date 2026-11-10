// Illuminate: a playground for light and matter.
import * as THREE from 'three/webgpu';
import './ui/styles.css';
import { App, DEFAULT_QUALITY, TIERS } from './app/App';
import { validate } from './gi/validate';
import { PRESETS, createAtelier } from './scene/presets';
import { createTestScene } from './scene/tests';
import type { Quality, SceneDescription } from './scene/types';
import { mountInterface } from './ui/Shell';
import { loadQuality, loadScene } from './ui/storage';

const params = new URLSearchParams(location.search);

function notice(title: string, body: string) {
  const el = document.getElementById('notice')!;
  el.hidden = false;
  el.querySelector('h1')!.textContent = title;
  el.querySelector('p')!.textContent = body;
}

async function start() {
  if (!('gpu' in navigator)) {
    notice('WebGPU is not available', 'Illuminate computes its lighting with WebGPU compute shaders, and there is no reduced mode without them. Open it in a current version of Chrome, Edge or Safari on a device with WebGPU enabled.');
    return;
  }
  const three = new THREE.WebGPURenderer({ antialias: false, powerPreference: 'high-performance' });
  await three.init();
  const backend = three.backend as unknown as { device?: GPUDevice; isWebGPUBackend?: boolean };
  if (!backend.isWebGPUBackend || !backend.device) {
    notice('WebGPU is not available', 'This browser fell back to WebGL, which cannot run the lighting solver. Open Illuminate in a browser with WebGPU enabled.');
    return;
  }
  backend.device.lost.then((info) => {
    (window as unknown as { __lost?: string }).__lost = `${info.reason}: ${info.message}`;
    if (info.reason !== 'destroyed') notice('The graphics device was lost', 'The browser reset the GPU. Reload the page to continue; your scene is saved locally.');
  });

  // Scene: a validation scene or a named preset from the URL, else the saved scene, else the flagship.
  const test = params.has('scene') ? createTestScene(params.get('scene')!) : null;
  const preset = params.has('preset') ? PRESETS.find((p) => p.name.toLowerCase().replace(/\s+/g, '-') === params.get('preset')) : undefined;
  const scene: SceneDescription = test ?? preset?.make() ?? (params.has('fresh') ? null : loadScene()) ?? createAtelier();
  const quality: Quality = { ...DEFAULT_QUALITY(), ...loadQuality() };
  const tier = params.get('q') ?? undefined;
  if (tier && TIERS[tier]) quality.tier = tier === 'tiny' ? 'auto' : (tier as Quality['tier']);
  if (params.has('mp')) quality.pixels = Number(params.get('mp'));

  const app = new App(three, document.getElementById('view')!, scene, quality, { manual: params.has('manual'), tier, offscreen: params.has('capture') });
  if (params.has('paused')) app.clock.playing = false;
  if (params.has('time')) app.clock.time = Number(params.get('time'));
  if (params.has('dbg')) app.view = Number(params.get('dbg'));
  if (params.has('bounce')) app.bounce = Number(params.get('bounce'));
  if (params.has('ev')) app.doc.scene.camera.exposure = Number(params.get('ev'));

  if (!params.has('bare')) mountInterface(app, { persist: !test && !params.has('manual') });

  // Hooks for automated checks.
  const capture = async (scale = 1) => {
    const img = await app.still(scale, 1);
    let c = document.getElementById('capture') as HTMLCanvasElement | null;
    if (!c) {
      c = document.createElement('canvas');
      c.id = 'capture';
      c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:50';
      document.body.appendChild(c);
    }
    c.width = img.width; c.height = img.height;
    c.getContext('2d')!.putImageData(img, 0, 0);
    return true;
  };
  Object.assign(window, {
    __illuminate: {
      app, capture, step: (n = 1) => app.step(n),
      get gi() { return app.gi; },
      get state() { return { frames: app.frames }; },
      validate: () => validate(params.get('scene') ?? '', app.gi, (n) => app.step(n)),
    },
  });
}

start().catch((err) => {
  console.error(err);
  notice('Illuminate could not start', String(err?.message ?? err));
});
