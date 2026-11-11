// Clip director: builds lighting set-ups from the app's own objects and records each as a clean
// full-frame clip (no interface, no captions). One H.264 stream, a keyframe at every clip start.
// window.__reelOpts: { dry, clips: [...names], sheetEvery, frames }
(() => {
  const S = window.__illuminate, app = S.app, doc = app.doc;
  const opts = window.__reelOpts || {};
  const FPS = 30, W = app.renderer.width, H = app.renderer.height;
  const R = window.__reel = { n: 0, done: false, err: null, chunks: [], bytes: 0, marks: [], thumbs: [], sec: '' };
  const cv = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = cv.getContext('2d');
  app.renderer.captureOverlay = false;
  const realInsets = app.setInsets.bind(app);
  app.setInsets = () => {};
  realInsets({ left: 0, right: 0, top: 0, bottom: 0 });

  const el = app.three.domElement;
  el.setPointerCapture = () => {}; el.releasePointerCapture = () => {}; el.hasPointerCapture = () => false;
  const V = app.camera.position.clone();
  const screenOf = (p) => { V.set(p[0], p[1], p[2]).project(app.camera); return { x: (V.x * 0.5 + 0.5) * innerWidth, y: (0.5 - V.y * 0.5) * innerHeight }; };
  const pe = (type, x, y, down = true) => el.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, buttons: down ? 1 : 0, pointerId: 1, pointerType: 'mouse', pressure: down ? 0.5 : 0, bubbles: true, cancelable: true, isPrimary: true }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = (label) => [...document.querySelectorAll('.inspector .row')].find((r) => r.querySelector('.label')?.textContent.trim() === label);
  const setSlider = (label, frac) => { const r = row(label)?.querySelector('input[type=range]'); if (!r) throw new Error('no slider ' + label); r.value = String(frac); r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); };
  const ease = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const hex = (h) => [lin(((h >> 16) & 255) / 255), lin(((h >> 8) & 255) / 255), lin((h & 255) / 255)];

  let enc = null, forceKey = true;
  if (!opts.dry) {
    enc = new VideoEncoder({ output: (c) => { const b = new Uint8Array(c.byteLength); c.copyTo(b); R.chunks.push(b); R.bytes += b.length; }, error: (e) => { R.err = 'encoder: ' + e; } });
    enc.configure({ codec: 'avc1.640033', width: W, height: H, bitrate: opts.bitrate || 24e6, framerate: FPS, avc: { format: 'annexb' }, latencyMode: 'quality' });
  }
  let rate = 1;
  async function frame(record = true) {
    if (R.err) throw new Error(R.err);
    const loop = Math.max(doc.scene.loop, 0.1);
    app.clock.time = (app.clock.time + rate / FPS + loop) % loop; app.clock.elapsed += 1 / FPS;
    await app.step(1);
    if (!record) return;
    const img = await app.renderer.readCapture();
    g.putImageData(img, 0, 0);
    if (opts.sheetEvery && R.n % opts.sheetEvery === 0) { const t = Object.assign(document.createElement('canvas'), { width: 640, height: 360 }); t.getContext('2d').drawImage(cv, 0, 0, 640, 360); R.thumbs.push([R.n, t]); }
    if (enc) {
      const vf = new VideoFrame(cv, { timestamp: Math.round((R.n * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: forceKey || R.n % 30 === 0 }); vf.close(); forceKey = false;
      if (enc.encodeQueueSize > 3) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }));
    }
    R.n++;
  }

  // --- a kit of objects, cloned from the built-in scenes -----------------------------------------
  const K = {};
  const entry = (name) => [...document.querySelectorAll('.menu .entry')].find((e) => e.querySelector('span')?.textContent.trim() === name);
  async function loadPreset(name) {
    document.querySelector('.top .title').click();
    if (!entry(name)) document.querySelector('.top .title').click();
    entry(name).click();
    await app.step(1);
    return structuredClone(doc.scene);
  }
  const pick = (scene, name) => structuredClone(scene.objects.find((o) => o.name === name || o.kind === name));
  let uid = 0;
  const make = (tpl, patch) => { const o = { ...structuredClone(tpl), motions: [], visible: true, ...patch }; o.id = `${o.kind}-clip-${++uid}`; return o; };
  const mo = (kind, p = {}) => ({ id: `m${++uid}`, kind, enabled: true, amplitude: 0.3, cycles: 1, phase: 0, easing: 'sine', axis: 'y', ...p });
  const surf = (h, roughness = 0.9, metal = 0) => ({ color: hex(h), roughness, metal });
  // Saturated emission colours (linear, normalised).
  const C = { magenta: [1, 0.03, 0.42], cyan: [0.02, 0.75, 1], blue: [0.06, 0.2, 1], amber: [1, 0.36, 0.03], red: [1, 0.05, 0.04], lime: [0.35, 1, 0.08], violet: [0.42, 0.08, 1], teal: [0.02, 1, 0.6], pink: [1, 0.12, 0.3] };
  const tube = (name, position, rotation, points, color, luminance, width = 0.035, motions = []) => make(K.ribbon, {
    name, profile: 'tube', position, rotation, points, pressure: points.map(() => 1), width, taper: 0, onSurface: false, emission: { color, luminance, lockOutput: false }, motions });
  const P = {
    line: (len, n = 8) => Array.from({ length: n + 1 }, (_, i) => [0, (i / n - 0.5) * len, 0]),
    hline: (len, n = 8) => Array.from({ length: n + 1 }, (_, i) => [(i / n - 0.5) * len, 0, 0]),
    arc: (r, a0, a1, n = 28) => Array.from({ length: n + 1 }, (_, i) => { const a = lerp(a0, a1, i / n); return [Math.cos(a) * r, Math.sin(a) * r, 0]; }),
    wave: (len, amp, waves, n = 40, depth = 0) => Array.from({ length: n + 1 }, (_, i) => { const s = i / n - 0.5; return [s * len, amp * Math.sin(s * waves * 6.2832), depth * Math.cos(s * waves * 6.2832)]; }),
  };
  const panelLight = (name, position, rotation, size, color, luminance, motions = []) => make(K.globe, { name, shape: 'rect', position, rotation, size, emission: { color, luminance, lockOutput: false }, motions });

  function base(name, { wall = 0x8d8a88, floor = 0x1b1a1d, ceiling = 0x4c4a49, floorRough = 0.22 } = {}) {
    const s = structuredClone(K.atelier);
    s.name = name; s.objects = []; s.loop = 40;
    s.room.wall = surf(wall, 0.9); s.room.floor = surf(floor, floorRough); s.room.ceiling = surf(ceiling, 0.95);
    s.daylight.motions = [];
    s.finish = { ...s.finish, toneMap: 'neutral', bloom: 0.2, saturation: 1.12, vignette: 0.16, grain: 0.012, whiteBalance: 6500, contrast: 1.04 };
    s.atmosphere = { haze: 0, tint: [1, 1, 1], anisotropy: 0.55 };
    return s;
  }
  const twilight = (s, { el = -0.05, az = 2.6, sky = 1.2, tint = [0.2, 0.36, 1.25], turbidity = 2.2 } = {}) => {
    Object.assign(s.daylight, { sunElevation: el, sunAzimuth: az, sunBrightness: 0, skyBrightness: sky * 2.6, skyTint: tint, turbidity, cloudiness: 0 });
  };
  const setCam = (s, position, target, focal, exposure) => { Object.assign(s.camera, { projection: 'perspective', position, target, focal, exposure }); };

  // --- clips ---------------------------------------------------------------------------------------
  // Each returns { scene, frames, rate, from, to, each }.
  const clips = {
    neon_loft() {
      const s = base('Neon loft');
      twilight(s, { sky: 1.6 });
      s.objects = [
        make(K.curved, { name: 'Screen', position: [0.8, 0.85, -0.6], rotation: [0, -2.85, 0], surface: surf(0xe8e4dd, 0.85), motions: [mo('pendulum', { amplitude: 0.2, cycles: 1 })] }),
        tube('Magenta', [0.9, 1.3, -0.85], [0, 0.25, 0], P.wave(2.5, 0.16, 1, 40, 0.14), C.magenta, 34, 0.038, [mo('breathe', { amplitude: 0.25, cycles: 3 }), mo('pendulum', { amplitude: 0.08, cycles: 2 })]),
        tube('Cyan ring', [-1.25, 1.25, -0.9], [0, 0.9, 0], P.arc(0.62, 0, 6.2832, 44), C.cyan, 30, 0.034, [mo('spin', { amplitude: 1, cycles: 1, axis: 'y' }), mo('breathe', { amplitude: 0.2, cycles: 4, phase: 0.5 })]),
        make(K.fluted, { name: 'Fluted', position: [-0.35, 0.8, 0.55], rotation: [0, 0.55, 0], size: [0.95, 1.6, 0.06], motions: [mo('pendulum', { amplitude: 0.3, cycles: 1 })] }),
        make(K.cylinder, { name: 'Plinth', position: [-1.25, 0.3, -0.9], radius: 0.22, height: 0.6, surface: surf(0x2a2a2e, 0.35) }),
        make(K.slab, { name: 'Bench', position: [1.3, 0.2, 1.0], rotation: [0, 0.35, 0], size: [1.5, 0.4, 0.5], surface: surf(0x242326, 0.4) }),
      ];
      setCam(s, [2.5, 1.35, 2.35], [-0.5, 1.1, -1.0], 26, 0.2);
      return { scene: s, frames: 280, rate: 1.4, from: { p: [2.5, 1.35, 2.35], t: [-0.5, 1.1, -1.0] }, to: { p: [1.7, 1.2, 2.45], t: [-0.3, 1.1, -1.0] } };
    },

    duet() {
      const s = base('Duet', { wall: 0x9a9795, floor: 0x222125, ceiling: 0x555352, floorRough: 0.3 });
      twilight(s, { sky: 1.2 });
      s.atmosphere.haze = 0.035;
      s.objects = [
        panelLight('Amber panel', [-2.1, 1.25, -0.9], [Math.PI / 2, 0, -1.15], [0.42, 2.3], C.amber, 9, [mo('breathe', { amplitude: 0.7, cycles: 2 })]),
        panelLight('Teal panel', [2.1, 1.25, -0.9], [Math.PI / 2, 0, 1.15], [0.42, 2.3], C.cyan, 9, [mo('breathe', { amplitude: 0.7, cycles: 2, phase: 0.5 })]),
        make(K.arch, { name: 'Arch', position: [0, 1.25, -1.75], rotation: [0, 0, 0], size: [2.4, 2.5, 0.3], span: 1.2, rise: 2.0, surface: surf(0xe9e6e0, 0.85) }),
        make(K.cylinder, { name: 'Plinth', position: [0, 0.45, -0.55], radius: 0.26, height: 0.9, surface: surf(0xdcd8d0, 0.6) }),
        make(K.sphere, { name: 'Sphere', position: [0, 1.28, -0.55], radius: 0.38, surface: surf(0xf0ede8, 0.32) }),
        make(K.sphere, { name: 'Small sphere', position: [-0.85, 0.2, 0.25], radius: 0.2, surface: surf(0xf0ede8, 0.5) }),
        make(K.slab, { name: 'Step', position: [0.95, 0.12, 0.1], rotation: [0, -0.3, 0], size: [0.9, 0.24, 0.6], surface: surf(0xdcd8d0, 0.7) }),
      ];
      setCam(s, [-0.9, 1.25, 2.4], [0, 1.1, -0.7], 30, 0.5);
      return { scene: s, frames: 280, rate: 2.2, from: { p: [-0.9, 1.25, 2.4], t: [0, 1.1, -0.7] }, to: { p: [0.9, 1.45, 2.35], t: [0, 1.05, -0.7] } };
    },

    louver_noir() {
      const s = structuredClone(K.morning);
      s.name = 'Louver noir'; s.daylight.motions = [];
      twilight(s, { az: 2.85, sky: 1.4 });
      s.room.wall = surf(0x8a8684, 0.9); s.room.floor = surf(0x1c1b1e, 0.25); s.room.ceiling = surf(0x4a4847, 0.95);
      s.finish = { ...s.finish, toneMap: 'neutral', bloom: 0.2, saturation: 1.12, vignette: 0.18, whiteBalance: 6500, contrast: 1.05 };
      s.atmosphere = { haze: 0.06, tint: [1, 1, 1], anisotropy: 0.6 };
      for (const o of s.objects) { if (o.surface && o.kind !== 'louvers') o.surface = surf(0xdedad3, 0.7); if (o.kind === 'louvers') o.surface = surf(0x18181a, 0.5); }
      s.objects.push(
        tube('Pink', [-2.86, 1.6, -0.9], [0, 0, 0], P.line(2.6), C.pink, 120, 0.05, [mo('breathe', { amplitude: 0.2, cycles: 3 })]),
        tube('Blue', [-2.86, 1.6, 0.5], [0, 0, 0], P.line(2.6), C.blue, 150, 0.05, [mo('breathe', { amplitude: 0.2, cycles: 3, phase: 0.5 })]),
      );
      s.camera.exposure = 0.4;
      const c = s.camera;
      return { scene: s, frames: 280, rate: 2.4, time: 28, from: { p: c.position, t: c.target }, to: { p: [c.position[0] - 0.5, c.position[1] - 0.15, c.position[2] - 0.35], t: c.target } };
    },

    glass_hour() {
      const s = base('Glass hour', { wall: 0x7f8286, floor: 0x18191c, ceiling: 0x45474a, floorRough: 0.2 });
      twilight(s, { sky: 1.5 });
      s.objects = [
        make(K.frosted, { name: 'Frosted', position: [-0.9, 1.1, -0.7], rotation: [0, 0.35, 0], size: [1.7, 2.2, 0.045], motions: [mo('pendulum', { amplitude: 0.18, cycles: 1 })] }),
        tube('Cyan', [-0.95, 1.2, -1.25], [0, 0.35, 0.5], P.wave(1.9, 0.3, 1.5, 44), C.cyan, 46, 0.04, [mo('breathe', { amplitude: 0.2, cycles: 3 })]),
        make(K.fluted, { name: 'Fluted', position: [1.0, 0.85, -0.2], rotation: [0, -0.45, 0], size: [1.1, 1.7, 0.06], fluteDepth: 0.012, fluteSpacing: 0.045, motions: [mo('pendulum', { amplitude: 0.35, cycles: 2 })] }),
        tube('Amber', [1.25, 0.95, -0.95], [0, -0.45, 0], P.arc(0.6, 0.4, 5.9, 40), C.amber, 46, 0.04, [mo('spin', { amplitude: 1, cycles: 1, axis: 'z' })]),
        make(K.rod, { name: 'Rod', position: [-0.1, 0.9, 0.45], motions: [] }),
        tube('Violet', [0.2, 0.06, 1.2], [0, 0.5, 0], P.hline(2.2), C.violet, 30, 0.035),
        make(K.sphere, { name: 'Sphere', position: [2.0, 0.3, 0.7], radius: 0.3, surface: surf(0xdad6cf, 0.3) }),
      ];
      setCam(s, [0.6, 1.2, 2.45], [0.05, 1.0, -0.7], 30, 0.3);
      return { scene: s, frames: 280, rate: 1.6, from: { p: [-0.5, 1.15, 2.45], t: [0.0, 1.0, -0.7] }, to: { p: [1.0, 1.3, 2.4], t: [0.1, 1.0, -0.7] } };
    },

    chromatic_field() {
      const s = base('Chromatic field', { wall: 0xf3f1ed, floor: 0xeceae5, ceiling: 0xf3f1ed, floorRough: 0.8 });
      s.finish = { ...s.finish, toneMap: 'neutral', bloom: 0.06, saturation: 1.3, vignette: 0.1, contrast: 1.04 };
      Object.assign(s.daylight, { sunElevation: 0.78, sunAzimuth: 2.0, sunBrightness: 1, skyBrightness: 0.25, skyTint: [1, 1, 1], turbidity: 2.2, cloudiness: 0 });
      // Saturated fields on the floor where the sun lands: the room is lit by what they reflect.
      const field = (name, h, z0, z1) => make(K.slab, { name, position: [-1.65, 0.02, (z0 + z1) / 2], rotation: [0, 0, 0], size: [2.7, 0.04, z1 - z0], round: 0.005, surface: surf(h, 0.85) });
      s.objects = [
        field('Vermilion', 0xf03a1a, 1.26, 2.5), field('Ultramarine', 0x1a3be0, 0.02, 1.24), field('Yellow', 0xfacc0a, -1.22, 0.0), field('Emerald', 0x0fa85c, -2.5, -1.24),
        make(K.folded, { name: 'Screen', position: [1.2, 1.0, -1.3], rotation: [0, -0.35, 0], panels: 5, panelWidth: 0.6, height: 2.0, fold: 1.1, surface: surf(0xf6f4f0, 0.9), motions: [mo('param', { param: 'fold', amplitude: 0.5, cycles: 2 })] }),
        make(K.sphere, { name: 'Sphere', position: [0.35, 0.5, 0.55], radius: 0.5, surface: surf(0xf8f6f2, 0.55) }),
        make(K.arch, { name: 'Arch', position: [1.9, 1.2, 0.9], rotation: [0, -1.1, 0], size: [1.8, 2.4, 0.24], span: 1.0, rise: 1.9, surface: surf(0xf6f4f0, 0.85), motions: [mo('pendulum', { amplitude: 0.5, cycles: 2 })] }),
        make(K.cylinder, { name: 'Column', position: [-0.2, 1.0, -1.2], radius: 0.2, height: 2.0, surface: surf(0xf8f6f2, 0.6) }),
      ];
      setCam(s, [2.6, 1.55, 2.35], [-0.6, 0.95, -0.4], 21, -2.7);
      return { scene: s, frames: 320, rate: 3.2, from: { p: [2.6, 1.7, 2.35], t: [-0.6, 0.95, -0.4] }, to: { p: [1.2, 1.15, 2.45], t: [-0.3, 1.05, -0.7] },
        each: (k) => { const w = 0.5 - 0.5 * Math.cos(k * Math.PI * 2 * 1.5); doc.scene.daylight.sunAzimuth = lerp(1.85, 3.0, w); doc.scene.daylight.sunElevation = lerp(0.82, 0.6, k); } };
    },

    sunset_glass() {
      const s = structuredClone(K.atelier);
      s.name = 'Sunset glass'; s.daylight.motions = [];
      Object.assign(s.daylight, { sunElevation: 0.17, sunAzimuth: 2.5, sunBrightness: 1, skyBrightness: 1, turbidity: 4.5, skyTint: [1, 1, 1] });
      s.atmosphere = { haze: 0.04, tint: [1, 1, 1], anisotropy: 0.65 };
      s.finish = { ...s.finish, toneMap: 'neutral', bloom: 0.16, saturation: 1.15, vignette: 0.18, contrast: 1.05 };
      s.room.floor = surf(0x3a3634, 0.28);
      s.objects = [tube('Violet', [-2.98, 1.5, 0.575], [0, 0, 0], P.line(2.6), C.violet, 160, 0.04), tube('Violet low', [-2.98, 1.5, -0.975], [0, 0, 0], P.line(2.6), C.magenta, 90, 0.04)];
      // One tall glass cylinder standing in the beam, between the camera and the sun.
      const rod = [-1.5, 0.45];
      s.objects.push(make(K.rod, { name: 'Glass column', position: [rod[0], 1.0, rod[1]], rotation: [0, 0, 0], size: [0.4, 2.0, 0.4], tint: hex(0xe8f1ee), absorption: 0.6, frost: 0, dispersion: 0, caustics: true }));
      // The camera stays on the line from the sun through the column and drifts a little around it.
      const at = (a, d, h) => [rod[0] + Math.cos(a) * d, h, rod[1] + Math.sin(a) * d];
      const a0 = Math.atan2(-0.6, 0.8);
      setCam(s, at(a0 + 0.2, 2.9, 0.8), [rod[0], 1.05, rod[1]], 26, -2.5);
      return { scene: s, frames: 300, rate: 1.0, time: 2, from: { p: at(a0 + 0.12, 3.1, 0.7), t: [rod[0] - 0.2, 1.0, rod[1] + 0.25] }, to: { p: at(a0 + 0.42, 2.2, 1.05), t: [rod[0] - 0.1, 1.1, rod[1] + 0.1] },
        each: (k) => { doc.scene.daylight.sunElevation = lerp(0.2, 0.09, k); doc.scene.daylight.sunAzimuth = lerp(2.46, 2.56, k); } };
    },

    sunset_script() {
      const s = structuredClone(K.atelier);
      s.name = 'Sunset script'; s.daylight.motions = [];
      Object.assign(s.daylight, { sunElevation: 0.12, sunAzimuth: 2.5, sunBrightness: 1, skyBrightness: 1, turbidity: 6.5, skyTint: [1.15, 0.86, 0.6] });
      s.atmosphere = { haze: 0.04, tint: [1, 1, 1], anisotropy: 0.65 };
      s.finish = { ...s.finish, toneMap: 'neutral', bloom: opts.scriptBloom ?? 0.14, saturation: 1.15, vignette: 0.16, contrast: 1.05 };
      s.room.floor = surf(0x3a3634, 0.3);
      s.objects = s.objects.filter((o) => o.name !== 'Fluted glass' && o.name !== 'Luminous ribbon');
      // A wider, still screen to write on.
      const scr = s.objects.find((o) => o.name === 'Curved screen');
      const R0 = 1.6, th = -2.85, pos = [0.8, 0.95, -0.4];
      Object.assign(scr, { position: pos, rotation: [0, th, 0], radius: R0, height: 1.9, angle: 1.5, motions: [] });
      s.objects.push(make(K.fluted, { name: 'Glass panel', position: [-0.6, 0.95, 1.3], rotation: [0, 0.45, 0], size: [1.5, 1.9, 0.05], fluteDepth: 0, tint: hex(0xf06cc4), absorption: 0.1, frost: 0, dispersion: 0, motions: [mo('pendulum', { amplitude: 0.25, cycles: 1 })] }));
      setCam(s, [2.2, 0.75, 2.2], [-0.9, 0.85, -0.6], 24, -1.9);

      // Monoline letterforms: strokes as polylines in x-height units.
      const G = {
        i: { w: 0.38, s: [[[0, 1], [0, 0.12], [0.08, 0], [0.2, 0.05]], [[0, 1.32], [0.02, 1.5]]] },
        l: { w: 0.38, s: [[[0, 1.7], [0, 0.12], [0.08, 0], [0.2, 0.05]]] },
        u: { w: 0.8, s: [[[0, 1], [0, 0.3], [0.08, 0.07], [0.25, 0], [0.42, 0.08], [0.5, 0.3], [0.5, 1], [0.5, 0.1], [0.6, 0.02]]] },
        m: { w: 1.1, s: [[[0, 0], [0, 1], [0, 0.75], [0.1, 0.95], [0.25, 1], [0.36, 0.9], [0.4, 0.7], [0.4, 0], [0.4, 0.75], [0.5, 0.95], [0.65, 1], [0.76, 0.9], [0.8, 0.7], [0.8, 0]]] },
        n: { w: 0.75, s: [[[0, 0], [0, 1], [0, 0.75], [0.1, 0.95], [0.25, 1], [0.4, 0.9], [0.45, 0.7], [0.45, 0]]] },
        a: { w: 0.82, s: [[[0.5, 0.8], [0.38, 0.97], [0.22, 1], [0.08, 0.88], [0, 0.6], [0.02, 0.3], [0.12, 0.06], [0.27, 0], [0.42, 0.12], [0.5, 0.4], [0.5, 1], [0.5, 0.1], [0.6, 0.02]]] },
        t: { w: 0.58, s: [[[0.15, 1.5], [0.15, 0.15], [0.24, 0], [0.38, 0.05]], [[0, 1], [0.36, 1]]] },
        e: { w: 0.7, s: [[[0.02, 0.52], [0.5, 0.52], [0.48, 0.8], [0.36, 0.97], [0.22, 1], [0.08, 0.9], [0, 0.6], [0.02, 0.3], [0.12, 0.08], [0.28, 0], [0.44, 0.08], [0.5, 0.2]]] },
      };
      const word = 'illuminate';
      const total = [...word].reduce((a, ch) => a + G[ch].w, 0) - 0.15;
      const unit = 1.9 / total;
      const centre = [pos[0] + R0 * Math.sin(th), 0, pos[2] + R0 * Math.cos(th)], tx = [Math.cos(th), -Math.sin(th)];
      const world = (u, v) => [centre[0] + tx[0] * u * (tx[0] > 0 ? 1 : -1), 0.95 + v, centre[2] + tx[1] * u * (tx[0] > 0 ? 1 : -1)];
      // Pen samples: every stroke densely resampled; `pen` true starts a stroke.
      const samples = [];
      let x0 = -total / 2;
      for (const ch of word) {
        for (const st of G[ch].s) {
          let first = true;
          for (let k = 1; k < st.length; k++) {
            const a = st[k - 1], b = st[k], len = Math.hypot(b[0] - a[0], b[1] - a[1]) * unit, n = Math.max(1, Math.ceil(len / 0.012));
            for (let j = first ? 0 : 1; j <= n; j++) { const t = j / n; samples.push({ u: (x0 + lerp(a[0], b[0], t)) * unit, v: lerp(a[1], b[1], t) * unit, start: first && j === 0 }); }
            first = false;
          }
          samples[samples.length - 1].end = true;
        }
        x0 += G[ch].w;
      }
      let cursor = 0, down = false;
      return { scene: s, frames: 330, rate: 1.2, time: 2, from: { p: [2.4, 0.7, 2.3], t: [-0.9, 0.85, -0.6] }, to: { p: [1.4, 0.95, 2.4], t: [-0.8, 0.9, -0.6] },
        each: (k) => { doc.scene.daylight.sunElevation = lerp(0.135, 0.05, k); doc.scene.daylight.sunAzimuth = lerp(2.42, 2.6, k); },
        async prepare() {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
          await sleep(500);
          [...document.querySelectorAll('.segmented button')].find((e) => e.textContent.trim() === 'Tube').click();
          await sleep(300);
          setSlider('Width', (0.032 - 0.01) / 0.29); setSlider('Surface offset', 0.035 / 0.6); setSlider('Taper', 0); setSlider('Pressure', 0); setSlider('Smoothing', 0.12);
          setSlider('Luminance', Math.log((window.__reelOpts && window.__reelOpts.scriptLum) || 190) / Math.log(2000)); setSlider('Fade', 0);
          const hx = document.querySelector('.inspector .colorctl .hex'); hx.value = (window.__reelOpts && window.__reelOpts.scriptColor) || '#b04cff'; hx.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(200);
        },
        act(i, frames) {
          const begin = 24, end = frames - 50;
          const target = Math.round(samples.length * Math.min(Math.max((i - begin) / (end - begin), 0), 1));
          while (cursor < target) {
            const sm = samples[cursor++], p = screenOf(world(sm.u, sm.v));
            if (sm.start) { pe('pointermove', p.x, p.y, false); pe('pointerdown', p.x, p.y); down = true; }
            else pe('pointermove', p.x, p.y);
            if (sm.end && down) { pe('pointerup', p.x, p.y, false); down = false; }
          }
        } };
    },

    arcade() {
      const s = base('Arcade', { wall: 0x77767a, floor: 0x161619, ceiling: 0x3c3b3e, floorRough: 0.18 });
      twilight(s, { sky: 1.0 });
      s.atmosphere.haze = 0.03;
      const arch = (z) => make(K.arch, { name: 'Arch', position: [0, 1.3, z], rotation: [0, 0, 0], size: [2.6, 2.6, 0.24], span: 1.25, rise: 2.05, surface: surf(0xe6e2dc, 0.8) });
      const pair = (z, color, phase) => [
        tube('L', [-0.95, 1.2, z], [0, 0, 0], P.line(2.2), color, 60, 0.04, [mo('breathe', { amplitude: 0.45, cycles: 4, phase })]),
        tube('R', [0.95, 1.2, z], [0, 0, 0], P.line(2.2), color, 60, 0.04, [mo('breathe', { amplitude: 0.45, cycles: 4, phase })]),
      ];
      s.objects = [arch(1.0), ...pair(0.55, C.magenta, 0), arch(-0.2), ...pair(-0.65, C.cyan, 0.33), arch(-1.4), ...pair(-1.85, C.amber, 0.66),
        make(K.sphere, { name: 'Sphere', position: [0, 0.3, -2.0], radius: 0.3, surface: surf(0xf0ede8, 0.25) })];
      setCam(s, [0, 1.15, 2.45], [0, 1.1, -2.0], 22, 0.15);
      return { scene: s, frames: 280, rate: 2.5, from: { p: [-0.35, 1.0, 2.45], t: [0, 1.1, -2.0] }, to: { p: [0.2, 1.25, 1.55], t: [0, 1.05, -2.0] } };
    },
  };

  (async () => {
    try {
      R.sec = 'kit';
      K.atelier = await loadPreset('Atelier');
      K.ribbon = pick(K.atelier, 'Luminous ribbon'); K.curved = pick(K.atelier, 'Curved screen'); K.fluted = pick(K.atelier, 'Fluted glass');
      K.cylinder = pick(K.atelier, 'Plinth'); K.slab = pick(K.atelier, 'Bench slab');
      K.morning = await loadPreset('Morning Aperture');
      K.arch = pick(K.morning, 'arch'); K.sphere = pick(K.morning, 'sphere');
      const frost = await loadPreset('Frost Garden');
      K.frosted = frost.objects.find((o) => o.kind === 'glass' && o.frost > 0.3); K.rod = frost.objects.find((o) => o.kind === 'glass' && o.shape === 'rod');
      const amber = await loadPreset('Amber Study');
      K.globe = pick(amber, 'emitter');
      const fold = await loadPreset('Chromatic Fold');
      K.folded = pick(fold, 'folded');
      for (const [k, v] of Object.entries(K)) if (!v) throw new Error('kit: missing ' + k);

      // A run is a clip name, or { clip, tag, ...option overrides } to render variants of one clip.
      for (const run of opts.runs || opts.clips || Object.keys(clips)) {
        const name = typeof run === 'string' ? run : run.clip;
        if (typeof run !== 'string') Object.assign(opts, run);
        R.sec = typeof run === 'string' ? name : run.tag || name;
        const c = clips[name]();
        doc.load(structuredClone(c.scene));
        rate = c.rate ?? 1; app.clock.time = c.time ?? 0;
        const frames = opts.frames || c.frames;
        const move = (k) => { const cam = doc.scene.camera; cam.position = lerp3(c.from.p, c.to.p, k); cam.target = lerp3(c.from.t, c.to.t, k); app.applyCamera(); if (c.each) c.each(k); };
        move(0);
        if (c.prepare) await c.prepare();
        const r0 = rate; rate = 0; for (let i = 0; i < 14; i++) await frame(false); rate = r0;
        R.marks.push([R.sec, R.n, frames]); forceKey = true;
        for (let i = 0; i < frames; i++) { move(i / (frames - 1)); if (c.act) c.act(i, frames); await frame(); }
      }
      if (enc) { await enc.flush(); enc.close(); }
      R.done = true;
    } catch (e) { R.err = String((e && e.stack) || e).slice(0, 700); }
  })();

  window.__reelSheet = (page = 0) => {
    let c = document.getElementById('sheet');
    if (!c) { c = document.createElement('canvas'); c.id = 'sheet'; c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:200;background:#111'; document.body.appendChild(c); }
    if (page < 0) { c.remove(); return; }
    c.width = 1920; c.height = 1080; const x = c.getContext('2d'); x.fillStyle = '#111'; x.fillRect(0, 0, 1920, 1080);
    R.thumbs.slice(page * 9, page * 9 + 9).forEach(([n, t], i) => { const px = (i % 3) * 640, py = Math.floor(i / 3) * 360; x.drawImage(t, px, py); x.fillStyle = '#fff'; x.font = '22px monospace'; x.fillText(String(n), px + 8, py + 26); });
    return R.thumbs.length;
  };
})();
