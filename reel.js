// Demo-reel director: drives the real application frame by frame and encodes what it draws.
// Every picture is rendered by the app itself; the interface is the app's own DOM, rasterised
// through an SVG foreignObject and laid over the render. Options in window.__reelOpts:
//   dry: true        no encoding (layout checks)        sections: [...]  subset to run
//   sheetEvery: N    keep every Nth frame as a thumbnail for a contact sheet
(() => {
  const S = window.__illuminate, app = S.app, doc = app.doc;
  const opts = window.__reelOpts || {};
  const FPS = 30, W = app.renderer.width, H = app.renderer.height, K = W / innerWidth;
  const R = window.__reel = { n: 0, done: false, err: null, chunks: [], bytes: 0, marks: [], thumbs: [], sec: '', abort: false };
  const cv = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = cv.getContext('2d');
  const el = app.three.domElement;
  el.setPointerCapture = () => {}; el.releasePointerCapture = () => {}; el.hasPointerCapture = () => false;
  app.renderer.captureOverlay = true;

  const ease = (t) => t * t * (3 - 2 * t);
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const st = {
    ui: 0, inset: 0, insetsUI: { left: 45, right: 277, top: 0, bottom: 0 }, uiImg: null, uiDirty: true,
    cur: { x: 640, y: 420, a: 0, down: false }, cap: { text: '', next: '', a: 0 }, title: { a: 0, text: '', sub: '' }, black: 0, rate: 1,
  };
  // The shell reports its panel insets; the director decides how much of them the camera honours.
  app.setInsets.bind(app);
  const realInsets = app.setInsets.bind(app);
  app.setInsets = (i) => { if (i.left || i.right) st.insetsUI = i; };

  // --- interface snapshot ---------------------------------------------------------------------
  const css = window.__css.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  async function snapUI() {
    const ui = document.getElementById('ui');
    const clone = ui.cloneNode(true);
    const src = ui.querySelectorAll('input,select'), dst = clone.querySelectorAll('input,select');
    src.forEach((s, i) => {
      const d = dst[i];
      if (s.tagName === 'SELECT') [...d.options].forEach((o, j) => (j === s.selectedIndex ? o.setAttribute('selected', '') : o.removeAttribute('selected')));
      else if (s.type === 'checkbox') (s.checked ? d.setAttribute('checked', '') : d.removeAttribute('checked'));
      else d.setAttribute('value', s.value);
    });
    const ss = ui.querySelectorAll('.scroll'), ds = clone.querySelectorAll('.scroll');
    ss.forEach((s, i) => {
      if (!s.scrollTop) return;
      const w = document.createElement('div');
      w.style.marginTop = -s.scrollTop + 'px';
      while (ds[i].firstChild) w.appendChild(ds[i].firstChild);
      ds[i].appendChild(w); ds[i].style.overflow = 'hidden';
    });
    clone.querySelector('.status')?.remove();
    clone.querySelector('.present-note')?.remove();
    const xml = new XMLSerializer().serializeToString(clone);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${innerWidth} ${innerHeight}"><foreignObject width="${innerWidth}" height="${innerHeight}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:${innerWidth}px;height:${innerHeight}px;position:relative;font:12px/1.4 var(--sans);color:var(--ink);-webkit-font-smoothing:antialiased"><style>${css}</style>${xml}</div></foreignObject></svg>`;
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    await img.decode();
    st.uiImg = img;
  }

  // --- drawing ---------------------------------------------------------------------------------
  const SANS = '-apple-system, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif';
  function drawCursor() {
    const c = st.cur;
    if (c.a <= 0.01) return;
    g.save(); g.globalAlpha = c.a; g.translate(c.x * K, c.y * K); g.scale(K * (c.down ? 0.9 : 1), K * (c.down ? 0.9 : 1));
    if (c.down) { g.beginPath(); g.arc(0, 0, 11, 0, 6.283); g.strokeStyle = 'rgba(184,106,28,0.9)'; g.lineWidth = 1.5; g.stroke(); }
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 16.5); g.lineTo(4.4, 12.6); g.lineTo(7.4, 19.2); g.lineTo(10, 18); g.lineTo(7, 11.6); g.lineTo(12.4, 11.6); g.closePath();
    g.shadowColor = 'rgba(0,0,0,0.35)'; g.shadowBlur = 4 * K; g.shadowOffsetY = 1 * K;
    g.fillStyle = '#fff'; g.fill(); g.shadowColor = 'transparent'; g.strokeStyle = '#1d1a18'; g.lineWidth = 1.1; g.lineJoin = 'round'; g.stroke();
    g.restore();
  }
  function drawCaption() {
    const c = st.cap;
    if (c.next !== c.text) { c.a -= 0.14; if (c.a <= 0) { c.a = 0; c.text = c.next; } }
    else if (c.text) c.a = Math.min(1, c.a + 0.1);
    if (!c.text || c.a <= 0.01) return;
    const u = st.inset;
    const cx = lerp(innerWidth / 2, st.insetsUI.left + (innerWidth - st.insetsUI.left - st.insetsUI.right) / 2, u) * K;
    const y = (innerHeight - 54) * K + (1 - ease(c.a)) * 8 * K;
    g.save(); g.globalAlpha = ease(c.a);
    g.font = `500 ${15.5 * K}px ${SANS}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const w = g.measureText(c.text).width + 30 * K, h = 33 * K;
    g.beginPath(); g.roundRect(cx - w / 2, y - h / 2, w, h, 5 * K); g.fillStyle = '#1d1a18'; g.fill();
    g.fillStyle = '#f2efe9'; g.fillText(c.text, cx, y + 0.5 * K);
    g.restore();
  }
  function drawTitle() {
    const t = st.title;
    if (t.a <= 0.01) return;
    g.save(); g.globalAlpha = ease(Math.min(t.a, 1)); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#f2efe9';
    g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 18 * K;
    g.font = `300 ${62 * K}px ${SANS}`; try { g.letterSpacing = `${1.5 * K}px`; } catch {}
    g.fillText(t.text, W / 2, H * 0.24);
    g.font = `500 ${12.5 * K}px ${SANS}`; try { g.letterSpacing = `${3.2 * K}px`; } catch {}
    g.fillStyle = '#e9b47c'; g.fillText(t.sub.toUpperCase(), W / 2, H * 0.24 + 50 * K);
    try { g.letterSpacing = '0px'; } catch {}
    g.restore();
  }

  // --- encoder ---------------------------------------------------------------------------------
  let enc = null;
  if (!opts.dry) {
    enc = new VideoEncoder({
      output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); R.chunks.push(b); R.bytes += b.length; },
      error: (e) => { R.err = 'encoder: ' + e; },
    });
    enc.configure({ codec: 'avc1.640033', width: W, height: H, bitrate: opts.bitrate || 45e6, framerate: FPS, avc: { format: 'annexb' }, latencyMode: 'quality' });
  }

  async function frame() {
    if (R.abort) throw new Error('aborted');
    if (R.err) throw new Error(R.err);
    const loop = Math.max(doc.scene.loop, 0.1);
    app.clock.time = (app.clock.time + st.rate / FPS + loop) % loop;
    app.clock.elapsed += 1 / FPS;
    const u = st.inset, i = st.insetsUI;
    realInsets({ left: i.left * u, right: i.right * u, top: 0, bottom: 0 });
    await app.step(1);
    const img = await app.renderer.readCapture();
    g.globalAlpha = 1; g.putImageData(img, 0, 0);
    if (st.ui > 0.004) {
      if (!st.uiImg || st.uiDirty || R.n % 2 === 0) { await snapUI(); st.uiDirty = false; }
      g.globalAlpha = st.ui; g.drawImage(st.uiImg, 0, 0, W, H); g.globalAlpha = 1;
    }
    drawCursor(); drawCaption();
    if (st.black > 0.003) { g.globalAlpha = Math.min(st.black, 1); g.fillStyle = '#0b0a09'; g.fillRect(0, 0, W, H); g.globalAlpha = 1; }
    drawTitle();
    if (opts.sheetEvery && R.n % opts.sheetEvery === 0) {
      const t = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
      t.getContext('2d').drawImage(cv, 0, 0, 640, 360); R.thumbs.push([R.n, t]);
    }
    if (enc) {
      const vf = new VideoFrame(cv, { timestamp: Math.round((R.n * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
      enc.encode(vf, { keyFrame: R.n % 30 === 0 }); vf.close();
      if (enc.encodeQueueSize > 3) await new Promise((r) => enc.addEventListener('dequeue', r, { once: true }));
    }
    R.n++;
  }
  const shot = async (frames, fn) => { for (let i = 0; i < frames; i++) { if (fn) await fn(frames > 1 ? i / (frames - 1) : 1, i); await frame(); } };
  const hold = (frames) => shot(frames);
  const say = (text) => { st.cap.next = text; };
  const mark = (name) => { R.sec = name; R.marks.push([name, R.n]); };

  // --- acting ----------------------------------------------------------------------------------
  const V = app.camera.position.clone();
  const screenOf = (p) => { V.set(p[0], p[1], p[2]).project(app.camera); return { x: (V.x * 0.5 + 0.5) * innerWidth, y: (0.5 - V.y * 0.5) * innerHeight }; };
  const pe = (type, x, y, target = el, down = true) => target.dispatchEvent(new PointerEvent(type, {
    clientX: x, clientY: y, button: 0, buttons: down ? 1 : 0, pointerId: 1, pointerType: 'mouse', pressure: down ? 0.5 : 0, bubbles: true, cancelable: true, isPrimary: true }));
  const key = (k) => { window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); st.uiDirty = true; };
  const cam = (p, t, focal) => { const c = doc.scene.camera; c.position = p; c.target = t; if (focal) c.focal = focal; app.applyCamera(); };

  async function moveTo(x, y, frames = 14, onCanvas = false) {
    const x0 = st.cur.x, y0 = st.cur.y;
    await shot(frames, (t) => { const k = ease(t); st.cur.x = lerp(x0, x, k); st.cur.y = lerp(y0, y, k); st.cur.a = Math.min(1, st.cur.a + 0.15); if (onCanvas) pe('pointermove', st.cur.x, st.cur.y, el, false); });
  }
  async function clickEl(node, frames = 13, after = 5) {
    const r = node.getBoundingClientRect();
    await moveTo(r.left + r.width / 2, r.top + r.height / 2, frames);
    st.cur.down = true; await hold(2);
    node.click(); st.uiDirty = true; st.cur.down = false;
    await hold(after);
  }
  /** Drags on the viewport along a path given as a function of 0..1 returning client coordinates. */
  async function drag(path, frames, approach = 12) {
    const a = path(0);
    await moveTo(a.x, a.y, approach, true);
    st.cur.down = true; pe('pointerdown', a.x, a.y); await hold(1);
    await shot(frames, (t) => { const p = path(t); st.cur.x = p.x; st.cur.y = p.y; pe('pointermove', p.x, p.y); });
    pe('pointerup', st.cur.x, st.cur.y, el, false); st.cur.down = false; st.uiDirty = true;
    await hold(3);
  }
  const line = (a, b) => (t) => { const k = ease(t); return { x: lerp(a.x, b.x, k), y: lerp(a.y, b.y, k) }; };
  const row = (label) => [...document.querySelectorAll('.inspector .row')].find((r) => r.querySelector('.label')?.textContent.trim() === label);
  async function slide(label, to, frames = 30) {
    const find = () => row(label)?.querySelector('input[type=range]');
    let range = find();
    if (!range) throw new Error('no slider ' + label);
    range.scrollIntoView({ block: 'center' }); st.uiDirty = true;
    let r = range.getBoundingClientRect();
    const from = Number(range.value);
    await moveTo(r.left + from * r.width, r.top + r.height / 2, 12);
    st.cur.down = true;
    await shot(frames, (t) => {
      range = find() || range; r = range.getBoundingClientRect();
      const v = lerp(from, to, ease(t));
      range.value = String(v); range.dispatchEvent(new Event('input', { bubbles: true }));
      st.cur.x = r.left + v * r.width; st.cur.y = r.top + r.height / 2;
    });
    range.dispatchEvent(new Event('change', { bubbles: true })); st.cur.down = false; st.uiDirty = true;
    await hold(3);
  }
  const outline = (name) => [...document.querySelectorAll('.outline .item')].find((i) => i.textContent.trim() === name);
  const entry = (name) => [...document.querySelectorAll('.menu .entry')].find((e) => e.querySelector('span')?.textContent.trim() === name);
  const byText = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text);

  async function loadScene(name) {
    document.querySelector('.top .title').click();
    if (!entry(name)) document.querySelector('.top .title').click();
    const e = entry(name);
    if (!e) throw new Error('no scene ' + name);
    e.click(); st.uiDirty = true;
    await app.step(1);
  }
  const shutters = (v) => { for (const a of doc.scene.room.apertures) a.shutter = v; };
  /** Night falls: shutters close, then the exposure follows them down. */
  async function dim(frames = 34) {
    const s0 = doc.scene.room.apertures.map((a) => a.shutter), e0 = doc.scene.camera.exposure;
    await shot(frames, (t) => { const k = ease(t); doc.scene.room.apertures.forEach((a, i) => { a.shutter = lerp(s0[i], 1, k); }); doc.scene.camera.exposure = e0 - 6 * k * k; st.black = Math.max(0, (t - 0.55) / 0.45); });
    st.black = 1;
  }
  /** The reverse: from black, the shutters open onto the scene. Returns the scene's own exposure. */
  async function reveal(frames = 44, each) {
    const e0 = doc.scene.camera.exposure;
    shutters(1); doc.scene.camera.exposure = e0 - 5;
    await app.step(8);
    await shot(frames, async (t, i) => { const k = ease(t); shutters(1 - k); doc.scene.camera.exposure = e0 - 5 * (1 - k) * (1 - k); st.black = Math.max(0, 1 - t / 0.4); if (each) await each(t, i); });
    st.black = 0; shutters(0); doc.scene.camera.exposure = e0;
  }

  // --- the film --------------------------------------------------------------------------------
  const HERO = { p: [2.35, 1.45, 2.3], t: [-0.7, 1.1, -1.1], f: 26 };
  const sections = {
    async open() {
      mark('open');
      await loadScene('Atelier');
      app.clock.time = 22; st.rate = 1; st.ui = 0; st.inset = 0; st.black = 1;
      const rib = () => doc.scene.objects.find((o) => o.name === 'Luminous ribbon');
      const L = rib().emission.luminance;
      rib().emission.luminance = 0.01; shutters(1);
      const A = { p: [1.55, 1.34, 1.15], t: [0.75, 1.27, -1.0], f: 34 };
      const move = (k) => cam(lerp3(A.p, HERO.p, k), lerp3(A.t, HERO.t, k), lerp(A.f, HERO.f, k));
      move(0); await app.step(10);
      st.title.text = 'Illuminate'; st.title.sub = 'a playground for light and matter';
      const total = 330;
      let n = 0;
      const tick = () => { move(ease(Math.min(n / total, 1)) * 1); n++; };
      await shot(40, (t) => { tick(); st.title.a = t * 1.4; });
      await shot(70, (t) => { tick(); st.black = 1 - ease(t); rib().emission.luminance = Math.max(0.01, L * ease(t)); if (t > 0.6) st.title.a = Math.max(0, 1 - (t - 0.6) / 0.4); });
      st.title.a = 0; st.black = 0;
      await hold(1); say('One room, one ribbon of light');
      await shot(34, tick);
      say('Open the windows');
      await shot(80, (t) => { tick(); shutters(1 - ease(t)); });
      shutters(0);
      say('Sunlight, sky and every bounce are computed live, in the browser');
      st.rate = 2.6;
      await shot(total - n, tick);
      move(1);
    },

    async ui() {
      mark('ui');
      if (doc.scene.name !== 'Atelier') { await loadScene('Atelier'); cam(HERO.p, HERO.t, HERO.f); }
      app.clock.time = 2; st.rate = 0.4; st.black = 0;
      key('v'); doc.select({ type: 'none' });
      say('Everything here is editable');
      await shot(26, (t) => { st.ui = ease(t); st.inset = ease(t); });
      st.cur.x = 700; st.cur.y = 470;

      // Move things.
      say('Drag anything: the light follows in the same frame');
      const plinth = doc.scene.objects.find((o) => o.name === 'Plinth');
      await drag(line(screenOf(plinth.position), screenOf([-0.55, 0.36, 0.25])), 46);
      await hold(8);
      const glass = doc.scene.objects.find((o) => o.name === 'Fluted glass');
      await drag(line(screenOf(glass.position), screenOf([-1.95, 0.8, -0.85])), 40);
      say('Glass refracts, and focuses the sun into caustics');
      await slide('Flute depth', 0.75, 34);
      await slide('Flute depth', 0.2, 26);

      // Paint.
      key('b'); doc.select({ type: 'none' });
      say('Paint with light, straight onto a surface');
      await hold(10);
      await drag((t) => ({ x: 525 + 320 * t, y: 222 - 46 * t - 26 * Math.sin(t * 5.4) }), 62);
      await hold(10);
      say('…or into the air, as a glowing tube');
      const sw = document.querySelectorAll('.inspector .swatches .swatch');
      await clickEl(sw[8] || sw[sw.length - 1]);
      await clickEl(byText('.segmented button', 'Tube'), 10, 3);
      await clickEl(byText('.segmented button', 'Level plane'), 10, 4);
      await drag((t) => ({ x: 470 + 360 * t, y: 470 + 46 * Math.sin(t * 6.283) - 30 * t }), 64);
      await hold(12);

      // Add from the library.
      key('v');
      say('A library of lights, forms, screens and glass');
      key('a'); await moveTo(150, 250, 12); await hold(34);
      await clickEl(entry('Globe light'), 14, 8);
      const globe = doc.selectedObject;
      if (globe) await drag(line(screenOf(globe.position), screenOf([-0.2, globe.position[1], 0.9])), 50);
      await slide('Luminance', 0.86, 36);
      await hold(8);

      // Daylight.
      say('Real daylight: turn the sun, change the sky');
      await clickEl(outline('Daylight'), 14, 8);
      await slide('Sun height', (0.24 + 0.25) / 1.8, 56);
      await slide('Sun bearing', (2.72 + Math.PI) / (2 * Math.PI), 46);
      await slide('Cloud', 0.85, 34);
      await slide('Cloud', 0.0, 28);

      // A new window.
      say('Cut a floor-to-ceiling window into any wall');
      key('a'); await hold(8);
      await clickEl(entry('Floor-to-ceiling window'), 16, 16);
      await slide('Along wall', (-1.35 + 3.08) / 6.16, 44);
      await hold(10);

      // Understand the light.
      say('See exactly what the bounces add');
      doc.select({ type: 'none' });
      key('u'); await hold(6);
      const div = document.querySelector('.divider');
      div.setPointerCapture = () => {}; div.hasPointerCapture = () => true;
      const dx = div.getBoundingClientRect().left + 8, dy = 330;
      await moveTo(dx, dy, 12);
      st.cur.down = true; pe('pointerdown', dx, dy, div);
      const path = (t) => (t < 0.4 ? lerp(dx, 800, ease(t / 0.4)) : lerp(800, 250, ease((t - 0.4) / 0.6)));
      await shot(96, (t) => { st.cur.x = path(t); pe('pointermove', st.cur.x, dy, div); st.uiDirty = true; });
      st.cur.down = false; await hold(16);
      key('u');

      // Scenes.
      say('Five scenes to start from');
      await clickEl(document.querySelector('.top .title'), 16, 30);
      const target = entry('Morning Aperture').getBoundingClientRect();
      await moveTo(target.left + 60, target.top + target.height / 2, 16);
      await hold(10);
      say('');
      const s0 = doc.scene.room.apertures.map((a) => a.shutter), e0 = doc.scene.camera.exposure;
      await shot(34, (t) => { const k = ease(t); doc.scene.room.apertures.forEach((a, i) => { a.shutter = lerp(s0[i], 1, k); }); doc.scene.camera.exposure = e0 - 6 * k * k; st.black = Math.max(0, (t - 0.55) / 0.45); st.ui = 1 - ease(Math.min(t * 1.6, 1)); st.cur.a = st.ui; st.inset = 1 - k; });
      st.ui = 0; st.inset = 0; st.cur.a = 0; st.black = 1;
      document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    },

    async morning() {
      mark('morning');
      await loadScene('Morning Aperture');
      st.ui = 0; st.inset = 0; st.cur.a = 0; key('n');
      app.clock.time = 27; st.rate = 2.3;
      const c0 = structuredClone(doc.scene.camera);
      const fwd = [c0.target[0] - c0.position[0], c0.target[1] - c0.position[1], c0.target[2] - c0.position[2]];
      let n = 0; const total = 250;
      const tick = () => { const k = ease(n / total) * 0.14; cam([c0.position[0] + fwd[0] * k, c0.position[1] + fwd[1] * k, c0.position[2] + fwd[2] * k], c0.target, c0.focal); n++; };
      tick();
      say('Morning Aperture');
      await reveal(46, tick);
      say('Louvers turn, and comb the sun across the room');
      await shot(170, tick);
      say('');
      await dim(34);
    },

    async frost() {
      mark('frost');
      await loadScene('Frost Garden');
      st.ui = 0; st.inset = 0; st.cur.a = 0; app.clock.time = 3; st.rate = 0.5;
      say('Frost Garden');
      await reveal(44);
      key('f');
      say('Rub the frost away and the sun writes on the floor');
      const id = doc.selectedObject?.id ?? doc.scene.objects.find((o) => o.kind === 'glass').id;
      const mesh = app.runtime.entries.get(id).mesh;
      const c = () => { const p = mesh.getWorldPosition(V.clone()); return screenOf([p.x, p.y, p.z]); };
      const c0 = c();
      st.cur.x = c0.x + 160; st.cur.y = c0.y + 120;
      await drag((t) => { const a = t * 7.2 + 0.6, r = 18 + 78 * t; return { x: c0.x - 6 + Math.cos(a) * r * 0.82, y: c0.y - 8 + Math.sin(a) * r }; }, 120, 16);
      await drag((t) => ({ x: c0.x - 88 + 176 * t, y: c0.y + 118 - 26 * Math.sin(t * 3.1416) }), 40, 10);
      key('v'); doc.select({ type: 'none' });
      await shot(40, (t) => { st.cur.a = 1 - t; });
      say('');
      await dim(34);
    },

    async amber() {
      mark('amber');
      await loadScene('Amber Study');
      st.ui = 0; st.inset = 0; st.cur.a = 0; key('n'); app.clock.time = 34; st.rate = 1.6;
      const c0 = structuredClone(doc.scene.camera);
      let n = 0; const total = 230;
      const tick = () => { const k = ease(n / total); cam([c0.position[0] - 0.75 * k, c0.position[1] + 0.05 * k, c0.position[2] - 0.1 * k], c0.target, c0.focal); n++; };
      tick();
      say('Amber Study');
      await reveal(46, tick);
      say('Dusk outside, a warm ribbon behind tinted glass');
      await shot(150, tick);
      say('');
      await dim(34);
    },

    async fold() {
      mark('fold');
      await loadScene('Chromatic Fold');
      st.ui = 0; st.inset = 0; st.cur.a = 0; app.clock.time = 0; st.rate = 1;
      const d = doc.scene.daylight; d.motions = [];
      const az0 = 0.2, az1 = 1.35;
      let n = 0; const total = 236;
      const c0 = structuredClone(doc.scene.camera);
      const tick = () => { const k = n / total; doc.scene.daylight.sunAzimuth = lerp(az0, az1, ease(k)); cam([c0.position[0] + 0.5 * ease(k), c0.position[1], c0.position[2]], c0.target, c0.focal); n++; };
      tick();
      say('Chromatic Fold');
      await reveal(46, tick);
      say('Colour is handed from surface to surface');
      await shot(156, tick);
      say('');
      await dim(34);
    },

    async finale() {
      mark('finale');
      await loadScene('Atelier');
      st.ui = 0; st.inset = 0; st.cur.a = 0; key('n'); app.clock.time = 2; st.rate = 1;
      doc.scene.daylight.motions = [];
      const rib = () => doc.scene.objects.find((o) => o.name === 'Luminous ribbon');
      const L = rib().emission.luminance;
      const B = { p: [2.6, 1.55, 2.42], t: [-0.6, 1.05, -1.1], f: 24 };
      let n = 0; const total = 400;
      const tick = () => { const k = ease(Math.min(n / total, 1)); cam(lerp3(HERO.p, B.p, k), lerp3(HERO.t, B.t, k), lerp(HERO.f, B.f, k)); n++; };
      tick();
      await reveal(44, tick);
      say('Now make your own light');
      const d = () => doc.scene.daylight;
      const el0 = d().sunElevation, az0 = d().sunAzimuth, e0 = doc.scene.camera.exposure;
      await shot(170, (t) => { tick(); const k = ease(t); d().sunElevation = lerp(el0, 0.085, k); d().sunAzimuth = lerp(az0, 2.5, k); doc.scene.camera.exposure = e0 + 0.9 * k; });
      say('');
      await shot(70, (t) => { tick(); shutters(ease(t)); doc.scene.camera.exposure = e0 + 0.9 - 0.9 * ease(t); });
      st.title.text = 'Illuminate'; st.title.sub = 'sushilgr.github.io/illuminate';
      await shot(36, (t) => { tick(); st.title.a = t * 1.3; });
      await shot(50, tick);
      await shot(40, (t) => { tick(); rib().emission.luminance = Math.max(0.01, L * (1 - ease(t))); st.black = ease(t) * 0.85; });
      await shot(24, (t) => { st.black = 0.85 + 0.15 * t; st.title.a = 1 - t; });
    },
  };

  (async () => {
    try {
      for (const name of opts.sections || Object.keys(sections)) await sections[name]();
      if (enc) { await enc.flush(); enc.close(); }
      R.done = true;
    } catch (e) { R.err = String((e && e.stack) || e).slice(0, 600); }
  })();

  // Contact sheet of kept thumbnails, page by page (5 x 3 per page).
  window.__reelSheet = (page = 0) => {
    let c = document.getElementById('sheet');
    if (!c) { c = document.createElement('canvas'); c.id = 'sheet'; c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:200;background:#111'; document.body.appendChild(c); }
    if (page < 0) { c.remove(); return; }
    c.width = 1920; c.height = 1080; const x = c.getContext('2d'); x.fillStyle = '#111'; x.fillRect(0, 0, 1920, 1080);
    R.thumbs.slice(page * 9, page * 9 + 9).forEach(([n, t], i) => { const px = (i % 3) * 640, py = Math.floor(i / 3) * 360; x.drawImage(t, px, py); x.fillStyle = '#fff'; x.font = '22px monospace'; x.fillText(String(n), px + 8, py + 26); });
    return R.thumbs.length;
  };
  window.__reelShow = (index) => {
    let c = document.getElementById('sheet');
    if (!c) { c = document.createElement('canvas'); c.id = 'sheet'; c.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:200;background:#111'; document.body.appendChild(c); }
    c.width = W; c.height = H; c.getContext('2d').drawImage(cv, 0, 0);
  };
})();
