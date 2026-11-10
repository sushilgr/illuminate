// The interface shell: tool rail, top bar, contextual inspector, timeline, and the few
// floating pieces (menus, light meter, comparison divider). The viewport stays full-bleed
// underneath; nothing here runs inside the frame loop except small throttled readouts.
import { TIERS, type App } from '../app/App';
import { Tools, type Mode, type Transform } from '../edit/Tools';
import { luminanceOf } from '../scene/color';
import { LIBRARY, aperture as makeAperture, motion as makeMotion, type LibraryEntry } from '../scene/library';
import { PRESETS, createAtelier, withFreshIds } from '../scene/presets';
import type { Easing, Motion, MotionKind, Quality, SceneDescription, SceneObject, WallId } from '../scene/types';
import { ICONS, type IconName } from './icons';
import { buildInspector, type InspectorContext } from './inspector';
import { button, h, numberControl, popover, row, section, segmented, selectControl, svgIcon, toggleControl, type NumberSpec } from './kit';
import { hintSeen, markHintSeen, migrate, saveQuality, saveScene } from './storage';

const DEG = 180 / Math.PI;
const icon = (n: IconName, size = 18) => svgIcon(ICONS[n], size);
const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, a), b);

const KIND_LABEL: Record<SceneObject['kind'], string> = {
  slab: 'Slab', cylinder: 'Cylinder', sphere: 'Sphere', arch: 'Arch', curved: 'Curved wall', folded: 'Folded screen',
  perforated: 'Perforated panel', louvers: 'Louvers', emitter: 'Area light', stroke: 'Painted light', decal: 'Light patch',
  spot: 'Light aperture', glass: 'Glass',
};
const KIND_ICON: Record<SceneObject['kind'], IconName> = {
  slab: 'form', cylinder: 'form', sphere: 'form', arch: 'form', curved: 'screen', folded: 'screen', perforated: 'screen', louvers: 'screen',
  emitter: 'light', stroke: 'stroke', decal: 'light', spot: 'spot', glass: 'glass',
};

/** Numeric properties a `param` motion can drive, per target. */
const PARAMS: Record<string, [string, string][]> = {
  louvers: [['tilt', 'Tilt']],
  glass: [['frost', 'Frost'], ['fluteDepth', 'Flute depth'], ['ior', 'IOR']],
  spot: [['spread', 'Spread'], ['softness', 'Edge'], ['flux', 'Output']],
  stroke: [['width', 'Width']],
  folded: [['fold', 'Fold']],
  curved: [['angle', 'Arc']],
  aperture: [['shutter', 'Shutter'], ['u', 'Position'], ['width', 'Width']],
  daylight: [['sunElevation', 'Sun height'], ['sunAzimuth', 'Sun bearing'], ['cloudiness', 'Cloud'], ['skyBrightness', 'Sky'], ['sunBrightness', 'Sun']],
};
const ANGLES = new Set(['tilt', 'fold', 'angle', 'sunElevation', 'sunAzimuth', 'spread']);
const MOTION_LABEL: Record<MotionKind, string> = { orbit: 'Orbit', pendulum: 'Pendulum', slide: 'Slide', spin: 'Spin', breathe: 'Breathe', path: 'Path', param: 'Modulate' };

const VIEWS: [string, string][] = [
  ['0', 'Final image'], ['1', 'Lighting only'], ['8', 'Direct light'], ['9', 'Indirect light'], ['7', 'Radiance cache'],
  ['6', 'Cascade 0 probes'], ['4', 'Near-field visibility'], ['5', 'Distance field'], ['2', 'Albedo'], ['3', 'Normals'], ['10', 'Reflections'],
];

const SHORTCUTS: [string, string][] = [
  ['V', 'Select and move'], ['N', 'Navigate (or right-drag in any tool)'], ['B', 'Paint light'], ['E', 'Erase'], ['F', 'Etch frost'], ['M', 'Light meter'],
  ['G  R  S', 'Move, rotate, scale'], ['Shift', 'Lift while moving · tilt while rotating'], ['Ctrl', 'Snap to steps'], ['Alt-drag', 'Duplicate and move'], ['[  ]', 'Brush width'], ['A', 'Add an object'],
  ['U', 'Understand the light'], ['Space', 'Play / pause'], ['T', 'Timeline'], ['I', 'Inspector'], ['P', 'Presentation'],
  ['⌘Z  ⇧⌘Z', 'Undo, redo'], ['⌘D', 'Duplicate'], ['Delete', 'Remove selection'], ['Esc', 'Deselect / leave mode'],
];

export function mountInterface(app: App, opts: { persist: boolean }) {
  const ui = document.getElementById('ui')!;
  const doc = app.doc;
  const tools = new Tools(app);
  const state = { inspector: innerWidth > 900, timeline: false, understand: false, presenting: false };
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) app.clock.playing = false;

  // --- small helpers ----------------------------------------------------------------------------

  let closeMenu: (() => void) | null = null;
  let menuAnchor: HTMLElement | null = null;
  const menu = (anchor: HTMLElement, content: HTMLElement, align: 'right' | 'below' | 'above' = 'right') => {
    const same = menuAnchor === anchor;
    closeMenu?.();
    closeMenu = null; menuAnchor = null;
    if (same) return;
    const close = popover(anchor, content, align);
    menuAnchor = anchor;
    closeMenu = () => { close(); if (menuAnchor === anchor) { menuAnchor = null; closeMenu = null; } };
    // The popover closes itself on an outside press; forget it then.
    new MutationObserver((_, obs) => { if (!content.isConnected) { obs.disconnect(); if (menuAnchor === anchor) { menuAnchor = null; closeMenu = null; } } })
      .observe(ui, { childList: true });
  };
  const entry = (label: string, note: string, run: () => void, keys = '') => h('button', {
    class: 'entry', role: 'menuitem', onclick: () => { closeMenu?.(); run(); },
  }, h('span', null, label), keys ? h('span', { class: 'keys' }, keys) : note ? h('small', null, note) : null);

  let toastEl: HTMLElement | null = null;
  let toastTimer = 0;
  const toast = (text: string, sticky = false, onCancel?: () => void) => {
    toastEl?.remove();
    clearTimeout(toastTimer);
    const label = h('span', null, text);
    const el = toastEl = h('div', { class: 'toast', role: 'status' }, label, onCancel ? h('button', { class: 'btn quiet', style: 'color:inherit;margin-left:10px', onclick: onCancel }, 'Cancel') : null);
    ui.append(el);
    const close = () => { el.remove(); if (toastEl === el) toastEl = null; };
    if (!sticky) toastTimer = window.setTimeout(close, 2400);
    return { text: (t: string) => { label.textContent = t; }, close };
  };
  const download = (blob: Blob, name: string) => {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  const slug = () => doc.scene.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'illuminate';

  // --- rail --------------------------------------------------------------------------------------

  const toolButton = (n: IconName, title: string, run: (el: HTMLButtonElement) => void) => {
    const el = h('button', { class: 'tool', title, 'aria-label': title }, icon(n));
    el.addEventListener('click', () => run(el));
    return el;
  };
  const modes: [Mode, IconName, string][] = [
    ['select', 'select', 'Select and move  (V)'], ['navigate', 'navigate', 'Navigate  (N)'], ['paint', 'paint', 'Paint light  (B)'],
    ['erase', 'erase', 'Erase  (E)'], ['etch', 'etch', 'Etch frost  (F)'], ['meter', 'meter', 'Light meter  (M)'],
  ];
  const modeButtons = new Map<Mode, HTMLButtonElement>(modes.map(([m, i, t]) => [m, toolButton(i, t, () => setMode(m))]));
  const addButton = toolButton('add', 'Add  (A)', (el) => menu(el, libraryMenu()));
  const understandButton = toolButton('compare', 'Understand the light  (U)', () => setUnderstand(!state.understand));
  const playButton = toolButton('pause', 'Play / pause  (Space)', () => togglePlay());
  const timelineButton = toolButton('timeline', 'Timeline and motion  (T)', () => setTimeline(!state.timeline));
  const presetsButton = toolButton('presets', 'Scenes', (el) => menu(el, presetsMenu()));
  const captureButton = toolButton('capture', 'Capture and files', (el) => menu(el, captureMenu()));
  const qualityButton = toolButton('settings', 'Quality and diagnostics', (el) => menu(el, qualityDrawer()));
  const presentButton = toolButton('present', 'Presentation  (P)', () => setPresenting(true));
  const helpButton = toolButton('help', 'Shortcuts  (?)', (el) => menu(el, helpMenu()));
  const rail = h('nav', { class: 'rail', 'aria-label': 'Tools' },
    ...modeButtons.values(), h('hr'), addButton, understandButton,
    h('div', { class: 'gap' }),
    playButton, timelineButton, h('hr'), presetsButton, captureButton, qualityButton, presentButton, helpButton);

  // --- top bar -----------------------------------------------------------------------------------

  const title = h('button', { class: 'title', title: 'Scenes', onclick: () => menu(title, presetsMenu(), 'below') });
  const transforms: [Transform, IconName, string][] = [['move', 'move', 'Move  (G)'], ['rotate', 'rotate', 'Rotate  (R)'], ['scale', 'scale', 'Scale  (S)']];
  const transformButtons = new Map<Transform, HTMLButtonElement>(transforms.map(([t, i, tip]) => [t, toolButton(i, tip, () => tools.setTransform(t))]));
  const strip = h('div', { class: 'strip', role: 'toolbar', 'aria-label': 'Transform' }, ...transformButtons.values());
  const undoButton = toolButton('undo', 'Undo  (⌘Z)', () => doc.undo());
  const redoButton = toolButton('redo', 'Redo  (⇧⌘Z)', () => doc.redo());
  const history = h('div', { class: 'strip' }, undoButton, redoButton);
  const status = h('div', { class: 'status', title: 'Frame rate · lighting tier · render resolution' });
  const panelButton = toolButton('panel', 'Inspector  (I)', () => setInspector(!state.inspector));
  const top = h('div', { class: 'top' }, title, strip, h('div', { class: 'grow' }), history, status, h('div', { class: 'strip' }, panelButton));

  // --- inspector ---------------------------------------------------------------------------------

  const nameBox = h('input', { class: 'name', spellcheck: false, 'aria-label': 'Name' });
  const kindTag = h('span', { class: 'kind' });
  const headActions = h('div', { style: 'display:flex;gap:2px' });
  const scroll = h('div', { class: 'scroll' });
  const inspector = h('aside', { class: 'inspector', 'aria-label': 'Inspector' }, h('header', null, nameBox, kindTag, headActions), scroll);
  const ctx: InspectorContext = { app, tools, editing: { active: false }, refresh: () => renderInspector() };

  nameBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameBox.blur(); e.stopPropagation(); });
  nameBox.addEventListener('change', () => {
    const v = nameBox.value.trim() || 'Untitled';
    const sel = doc.selection;
    doc.edit((s) => {
      if (sel.type === 'object') { const o = s.objects.find((x) => x.id === sel.id); if (o) o.name = v; }
      else if (sel.type === 'aperture') { const a = s.room.apertures.find((x) => x.id === sel.id); if (a) a.name = v; }
      else s.name = v;
    }, 'structure');
  });

  const iconButton = (n: IconName, tip: string, run: () => void, on = false) => {
    const el = h('button', { class: `icon-btn${on ? ' on' : ''}`, title: tip, 'aria-label': tip }, icon(n, 16));
    el.addEventListener('click', (e) => { e.stopPropagation(); run(); });
    return el;
  };

  const outline = () => {
    const sel = doc.selection;
    const item = (ic: IconName, name: string, on: boolean, pick: () => void, extra?: Node, hidden = false) => {
      const el = h('div', { class: `item${on ? ' on' : ''}${hidden ? ' hidden' : ''}`, role: 'button', tabIndex: 0 }, icon(ic, 14), h('span', { class: 'nm' }, name), extra ?? h('span'));
      el.addEventListener('click', pick);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      return el;
    };
    const fixed: [IconName, string, 'room' | 'daylight' | 'atmosphere' | 'camera' | 'finish'][] = [
      ['room', 'Room', 'room'], ['sun', 'Daylight', 'daylight'], ['haze', 'Atmosphere', 'atmosphere'], ['camera', 'Camera', 'camera'], ['finish', 'Finish', 'finish'],
    ];
    const s = doc.scene;
    return h('div', { class: 'outline' },
      ...fixed.map(([ic, name, type]) => item(ic, name, sel.type === type, () => doc.select({ type }))),
      s.room.apertures.length ? h('div', { class: 'rule' }) : null,
      ...s.room.apertures.map((a) => item('window', a.name, sel.type === 'aperture' && sel.id === a.id, () => doc.select({ type: 'aperture', id: a.id }))),
      s.objects.length ? h('div', { class: 'rule' }) : null,
      ...s.objects.map((o) => item(KIND_ICON[o.kind], o.name, sel.type === 'object' && sel.id === o.id, () => doc.select({ type: 'object', id: o.id }),
        (() => { const b = iconButton(o.visible ? 'eye' : 'eyeOff', o.visible ? 'Hide' : 'Show', () => doc.edit((sc) => { const x = sc.objects.find((y) => y.id === o.id); if (x) x.visible = !x.visible; }, 'structure')); b.classList.add('vis'); return b; })(),
        !o.visible)));
  };

  function renderInspector() {
    const focusables = [...scroll.querySelectorAll<HTMLElement>('input,select,button')];
    const fi = focusables.indexOf(document.activeElement as HTMLElement);
    const at = scroll.scrollTop;
    const o = doc.selectedObject, a = doc.selectedAperture, sel = doc.selection;
    const name = o?.name ?? a?.name ?? (sel.type === 'none' ? doc.scene.name : sel.type[0].toUpperCase() + sel.type.slice(1));
    if (document.activeElement !== nameBox) nameBox.value = name;
    nameBox.readOnly = !(o || a || sel.type === 'none');
    kindTag.textContent = o ? KIND_LABEL[o.kind] : a ? 'Opening' : sel.type === 'none' ? 'Scene' : '';
    headActions.replaceChildren(...(o ? [
      iconButton('duplicate', 'Duplicate  (⌘D)', () => tools.duplicate(o.id)),
      iconButton('trash', 'Remove  (Delete)', () => tools.remove(o.id)),
    ] : a ? [iconButton('trash', 'Remove opening', () => removeAperture(a.id))] : sel.type !== 'none' ? [iconButton('close', 'Back to the scene', () => doc.select({ type: 'none' }))] : []));
    scroll.replaceChildren(section('Outline', [outline()], true), ...buildInspector(ctx));
    scroll.scrollTop = at;
    if (fi >= 0) scroll.querySelectorAll<HTMLElement>('input,select,button')[fi]?.focus();
    title.replaceChildren(doc.scene.name, h('small', null, 'Scenes'));
    undoButton.disabled = !doc.canUndo;
    redoButton.disabled = !doc.canRedo;
    strip.style.display = o && tools.mode === 'select' ? '' : 'none';
  }

  // Rebuilds are deferred while a slider is held, so a control is never replaced under the pointer.
  let dragging = false, wanted = false, timer = 0;
  const schedule = (delay = 0) => {
    if (timer) return;
    timer = window.setTimeout(() => {
      timer = 0;
      if (dragging) { wanted = true; return; }
      renderInspector();
      renderMotions();
    }, delay);
  };
  ui.addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).classList?.contains('range')) dragging = true; }, true);
  addEventListener('pointerup', () => { if (dragging) { dragging = false; if (wanted) { wanted = false; schedule(); } } }, true);

  function removeAperture(id: string) {
    doc.edit((s) => { s.room.apertures = s.room.apertures.filter((x) => x.id !== id); }, 'structure');
    doc.select({ type: 'none' });
  }

  // --- timeline ----------------------------------------------------------------------------------

  const tlPlay = h('button', { class: 'icon-btn', title: 'Play / pause  (Space)', onclick: () => togglePlay() });
  const timeText = h('span', { class: 'time' });
  const scrub = h('input', { type: 'range', class: 'range scrub', min: '0', max: '1', step: '0.0005', 'aria-label': 'Scrub the loop' });
  let scrubbing = false, resume = false;
  scrub.addEventListener('pointerdown', () => { scrubbing = true; resume = app.clock.playing; app.clock.playing = false; });
  scrub.addEventListener('input', () => { app.clock.time = Number(scrub.value) * doc.scene.loop; });
  const endScrub = () => { if (scrubbing) { scrubbing = false; app.clock.playing = resume; syncPlay(); } };
  scrub.addEventListener('change', endScrub);
  scrub.addEventListener('pointerup', endScrub);
  const loopSlot = h('div', { class: 'loop' });
  const motionsEl = h('div', { class: 'motions' });
  const timeline = h('div', { class: 'timeline' }, h('div', { class: 'transport' }, tlPlay, timeText, scrub, loopSlot), motionsEl);

  interface Target { motions: Motion[]; label: string; kind: string; emissive: boolean; movable: boolean }
  const motionTarget = (s: SceneDescription): Target | null => {
    const sel = doc.selection;
    if (sel.type === 'object') {
      const o = s.objects.find((x) => x.id === sel.id);
      if (!o) return null;
      const emissive = o.kind === 'emitter' || o.kind === 'stroke' || o.kind === 'decal' || o.kind === 'spot' || ('emission' in o && !!o.emission);
      return { motions: o.motions, label: o.name, kind: o.kind, emissive, movable: true };
    }
    if (sel.type === 'aperture') { const a = s.room.apertures.find((x) => x.id === sel.id); return a ? { motions: a.motions, label: a.name, kind: 'aperture', emissive: false, movable: false } : null; }
    if (sel.type === 'daylight') return { motions: s.daylight.motions, label: 'Daylight', kind: 'daylight', emissive: false, movable: false };
    return null;
  };

  function renderMotions() {
    loopSlot.replaceChildren(h('span', null, 'Loop'), numberControl(doc.scene.loop, { min: 4, max: 120, step: 1, digits: 0, unit: 's' },
      (v) => doc.edit((s) => { s.loop = clamp(v, 2, 600); app.clock.time %= s.loop; }, 'values', 'loop'), () => doc.commit()).el);
    const t = motionTarget(doc.scene);
    if (!t) {
      motionsEl.replaceChildren(h('p', { class: 'note' }, 'Select an object, an opening or the daylight to give it motion. Every motion runs on this one clock and repeats a whole number of times per loop, so the loop closes without a seam.'));
      return;
    }
    const params = PARAMS[t.kind] ?? [];
    const kinds: MotionKind[] = [...(t.movable ? ['orbit', 'pendulum', 'slide', 'spin'] as MotionKind[] : []), ...(t.emissive ? ['breathe'] as MotionKind[] : []), ...(params.length ? ['param'] as MotionKind[] : [])];
    const mutate = (id: string, fn: (m: Motion) => void, key: string, structure = false) => {
      doc.edit((s) => { const m = motionTarget(s)?.motions.find((x) => x.id === id); if (m) fn(m); }, 'values', structure ? '' : `motion:${id}:${key}`);
      if (structure) renderMotions();
    };
    const add = selectControl<string>('', [['', 'Add motion…'], ...kinds.map((k) => [k, MOTION_LABEL[k]] as [string, string])], (k) => {
      if (!k) return;
      const m = makeMotion(k as MotionKind);
      if (k === 'param') { m.param = params[0][0]; m.amplitude = ANGLES.has(m.param) ? 0.4 : m.param === 'fluteDepth' ? 0.006 : 0.3; }
      doc.edit((s) => { motionTarget(s)?.motions.push(m); }, 'structure');
      if (!app.clock.playing) togglePlay();
    });
    const head = h('div', { class: 'head' }, h('span', null, `Motion · ${t.label}`), h('span', { class: 'grow' }),
      t.motions.length > 1 ? button('Sync phases', () => { doc.edit((s) => { for (const m of motionTarget(s)?.motions ?? []) m.phase = 0; }, 'structure'); }, 'quiet') : null, add);
    const cell = (label: string, control: Node) => h('div', { class: 'cell' }, h('span', null, label), control);
    const rows = t.motions.map((m) => {
      const num = (value: number, spec: NumberSpec, set: (m: Motion, v: number) => void, key: string, after?: (v: number) => void) =>
        numberControl(value, spec, (v) => { mutate(m.id, (x) => set(x, v), key); after?.(v); }, () => doc.commit()).el;
      const angle = m.kind === 'pendulum' || (m.kind === 'param' && ANGLES.has(m.param ?? ''));
      const amp: NumberSpec = m.kind === 'orbit' || m.kind === 'slide' ? { min: 0, max: 2, digits: 2, unit: 'm' }
        : angle ? { min: 0, max: Math.PI, digits: 0, scale: DEG, unit: '°' }
        : m.kind === 'path' ? { min: 0, max: 2, digits: 2, unit: '×' }
        : m.kind === 'param' && m.param === 'fluteDepth' ? { min: 0, max: 0.02, digits: 3, unit: 'm' }
        : m.kind === 'param' && ['u', 'width', 'flux', 'skyBrightness', 'sunBrightness'].includes(m.param ?? '') ? { min: 0, max: 2, digits: 2 }
        : { min: 0, max: 1, digits: 2 };
      const period = h('span', null, `${(doc.scene.loop / Math.max(Math.round(m.cycles), 1)).toFixed(1)} s`);
      return h('div', { class: 'motion' },
        h('span', { class: 'k' }, MOTION_LABEL[m.kind]),
        toggleControl(m.enabled, (v) => mutate(m.id, (x) => { x.enabled = v; }, 'on', true)),
        m.kind === 'spin'
          ? cell('Turn', segmented(m.amplitude < 0 ? 'b' : 'a', [['a', 'Forward'], ['b', 'Reverse']], (v) => mutate(m.id, (x) => { x.amplitude = v === 'a' ? 1 : -1; }, 'dir', true)))
          : cell(m.kind === 'breathe' ? 'Depth' : 'Amount', num(m.amplitude, amp, (x, v) => { x.amplitude = v; }, 'amp')),
        h('div', { class: 'cell' }, period, num(m.cycles, { min: 1, max: 12, step: 1, digits: 0, unit: '×' }, (x, v) => { x.cycles = Math.max(Math.round(v), 1); }, 'cycles',
          (v) => { period.textContent = `${(doc.scene.loop / Math.max(Math.round(v), 1)).toFixed(1)} s`; })),
        cell('Phase', num(m.phase, { min: 0, max: 1, digits: 2 }, (x, v) => { x.phase = v; }, 'phase')),
        selectControl<Easing>(m.easing, [['sine', 'Sine'], ['ease', 'Ease'], ['linear', 'Linear'], ['hold', 'Hold']], (v) => mutate(m.id, (x) => { x.easing = v; }, 'ease', true)),
        m.kind === 'param'
          ? selectControl(m.param ?? params[0]?.[0] ?? '', params, (v) => mutate(m.id, (x) => { x.param = v; }, 'param', true))
          : m.kind === 'breathe' || m.kind === 'path' ? h('span')
          : selectControl(m.axis, [['x', 'X'], ['y', 'Y'], ['z', 'Z']], (v) => mutate(m.id, (x) => { x.axis = v; }, 'axis', true)),
        iconButton('close', 'Remove motion', () => { doc.edit((s) => { const tt = motionTarget(s); if (tt) tt.motions.splice(tt.motions.findIndex((x) => x.id === m.id), 1); }, 'structure'); }));
    });
    motionsEl.replaceChildren(head, ...rows, t.motions.length === 0 ? h('p', { class: 'note' },
      t.movable ? 'No motion yet. Add one above, or switch Paint to “As motion” and draw a path for this object to follow.' : 'No motion yet. Add one above to modulate this over the loop.') : '');
  }

  // --- menus -------------------------------------------------------------------------------------

  function addObject(e: LibraryEntry) {
    const t = app.controls.target, r = doc.scene.room.size;
    const o = e.make([clamp(t.x, -r[0] / 2 + 0.7, r[0] / 2 - 0.7), 0, clamp(t.z, -r[2] / 2 + 0.7, r[2] / 2 - 0.7)]);
    doc.edit((s) => { s.objects.push(o); }, 'structure');
    doc.select({ type: 'object', id: o.id });
    setMode('select');
  }

  function addAperture(kind: 'window' | 'tall' | 'skylight') {
    const room = doc.scene.room;
    let wall: WallId = 'ceiling';
    if (kind !== 'skylight') {
      // The wall the camera is facing.
      const f = app.controls.target.clone().sub(app.camera.position);
      wall = Math.abs(f.x) > Math.abs(f.z) ? (f.x < 0 ? 'x-' : 'x+') : (f.z < 0 ? 'z-' : 'z+');
    }
    const a = makeAperture(wall, 0, kind === 'tall', room.size[1]);
    const span = wall === 'ceiling' || wall.startsWith('z') ? room.size[0] : room.size[2];
    const taken = room.apertures.filter((x) => x.wall === wall);
    const free = (u: number) => taken.every((x) => Math.abs(x.u - u) > (x.width + a.width) / 2 + 0.2);
    const limit = span / 2 - a.width / 2 - 0.2;
    for (let i = 0; i <= 60; i++) {
      const u = Math.ceil(i / 2) * 0.1 * (i % 2 ? 1 : -1);
      if (Math.abs(u) <= limit && free(u)) { a.u = u; break; }
    }
    doc.edit((s) => { s.room.apertures.push(a); }, 'structure');
    doc.select({ type: 'aperture', id: a.id });
    setMode('select');
  }

  function libraryMenu() {
    const groups = ['Light', 'Form', 'Screen', 'Glass'] as const;
    return h('div', { class: 'menu', style: 'display:grid;grid-template-columns:1fr 1fr;column-gap:6px;width:340px' },
      ...groups.map((g) => h('div', { class: 'menu' }, h('div', { class: 'group' }, g), ...LIBRARY.filter((e) => e.group === g).map((e) => entry(e.label, '', () => addObject(e))))),
      h('div', { class: 'menu', style: 'grid-column:1 / -1;border-top:1px solid var(--rule-soft);margin-top:4px' }, h('div', { class: 'group' }, 'Opening'),
        entry('Floor-to-ceiling window', 'in the wall you face', () => addAperture('tall')),
        entry('Window', 'in the wall you face', () => addAperture('window')),
        entry('Skylight', 'in the ceiling', () => addAperture('skylight'))));
  }

  function presetsMenu() {
    return h('div', { class: 'menu', style: 'width:270px' }, h('div', { class: 'group' }, 'Scenes'),
      ...PRESETS.map((p) => entry(p.name, p.note, () => { doc.load(withFreshIds(p.make())); app.clock.time = 0; })),
      h('div', { class: 'group' }, 'Start from'),
      entry('Empty loft', 'windows and daylight only', () => { const s = createAtelier(); s.objects = []; s.name = 'Untitled'; doc.load(s); }),
      entry('Sealed room', 'no openings, no objects', () => { const s = createAtelier(); s.objects = []; s.room.apertures = []; s.name = 'Untitled'; s.camera.exposure = 0; doc.load(s); }));
  }

  async function captureStill(scale: number) {
    const note = toast('Rendering still…', true);
    try {
      const img = await app.still(scale, 10);
      const c = h('canvas', { width: img.width, height: img.height });
      c.getContext('2d')!.putImageData(img, 0, 0);
      c.toBlob((b) => { if (b) download(b, `${slug()}-${img.width}x${img.height}.png`); }, 'image/png');
    } finally { note.close(); }
  }

  async function captureLoop() {
    const fps = 30;
    const mime = typeof MediaRecorder === 'undefined' ? undefined
      : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    if (!mime) { toast('This browser cannot record video'); return; }
    const c = h('canvas', { width: app.renderer.width, height: app.renderer.height });
    const g = c.getContext('2d')!;
    const stream = c.captureStream(0);
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 18e6 });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise<void>((r) => { rec.onstop = () => r(); });
    let cancelled = false;
    const note = toast('Recording loop 0 %', true, () => { cancelled = true; });
    rec.start();
    let t0 = 0;
    // Frames are rendered at fixed loop phases; the recorder timestamps them as they arrive, so they are paced to real time.
    await app.loopFrames(fps, async (img, i, n) => {
      if (i === 0) t0 = performance.now();
      g.putImageData(img, 0, 0);
      track.requestFrame?.();
      note.text(`Recording loop ${Math.round(((i + 1) / n) * 100)} %`);
      const wait = t0 + ((i + 1) * 1000) / fps - performance.now();
      await new Promise((r) => setTimeout(r, Math.max(wait, 0)));
    }, () => cancelled);
    rec.stop();
    await stopped;
    note.close();
    syncPlay();
    if (!cancelled) download(new Blob(chunks, { type: mime.split(';')[0] }), `${slug()}-loop.${mime.includes('mp4') ? 'mp4' : 'webm'}`);
  }

  function importScene() {
    const input = h('input', { type: 'file', accept: '.json,application/json' });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const scene = migrate(JSON.parse(await file.text()));
        if (!scene) throw new Error('unsupported');
        doc.load(scene);
        toast(`Opened ${scene.name}`);
      } catch { toast('That file is not an Illuminate scene this version can read'); }
    });
    input.click();
  }

  function captureMenu() {
    const w = app.renderer.width, ht = app.renderer.height;
    return h('div', { class: 'menu', style: 'width:270px' }, h('div', { class: 'group' }, 'Capture'),
      entry('Still image', `${w} × ${ht}`, () => captureStill(1)),
      entry('Still image, high resolution', `${w * 2} × ${ht * 2}`, () => captureStill(2)),
      entry('Loop video', `${doc.scene.loop.toFixed(0)} s at 30 fps`, () => captureLoop()),
      h('div', { class: 'group' }, 'Scene file'),
      entry('Export scene', '.json', () => download(new Blob([app.serialize()], { type: 'application/json' }), `${slug()}.illuminate.json`)),
      entry('Import scene', '', () => importScene()));
  }

  function setQuality(patch: Partial<Quality>) {
    const q = { ...app.quality, ...patch };
    app.setQuality(q);
    if (q.tier === 'auto' && patch.tier) app.setTier('medium');
    if (opts.persist) saveQuality(q);
  }

  function qualityDrawer() {
    const q = app.quality;
    const timings = h('div', { class: 'timings' });
    const numbers = h('div', { class: 'timings' });
    const refresh = () => {
      if (!timings.isConnected) { clearInterval(iv); return; }
      const s = app.stats;
      const cfg = TIERS[app.tier];
      numbers.replaceChildren(...[
        ['Frame', `${s.frameMs.toFixed(1)} ms · ${s.fps.toFixed(0)} fps`], ['CPU in frame', `${s.cpuMs.toFixed(1)} ms`], ['GPU compute', s.gpuMs ? `${s.gpuMs.toFixed(1)} ms` : 'not reported'],
        ['Render size', `${s.width} × ${s.height}`], ['Lighting grid', `${cfg.grid.join(' × ')} at ${(cfg.voxel * 100).toFixed(1)} cm`],
        ['Cascades', `${cfg.cascades} · ${(s.rays / 1e6).toFixed(1)} M rays`], ['GPU memory', `${s.memoryMB} MB`],
      ].flatMap(([a, b]) => [h('span', null, a), h('span', null, b)]));
      const rows = [...app.gi.timer.results].sort((a, b) => b[1] - a[1]).slice(0, 9);
      timings.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', null, `${v.toFixed(2)} ms`)]));
    };
    const iv = window.setInterval(refresh, 500);
    setTimeout(refresh);
    const num = (label: string, value: number, spec: NumberSpec, set: (v: number) => void, hint?: string) => {
      let v = value;
      return row(label, numberControl(value, spec, (x) => { v = x; }, () => set(v)).el, hint);
    };
    return h('div', { class: 'drawer' },
      section('Quality', [
        row('Lighting', selectControl(q.tier, [['auto', 'Adaptive'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], (v) => setQuality({ tier: v })), 'Adaptive lowers resolution, then the lighting grid, when frames run slow'),
        num('Pixels', q.pixels, { min: 0.5, max: 8.3, digits: 1, unit: 'MP' }, (v) => setQuality({ pixels: v }), 'Upper bound on the render resolution (2.1 MP is 1080p)'),
        num('Bounces', q.iterations, { min: 1, max: 3, step: 1, digits: 0 }, (v) => setQuality({ iterations: Math.round(v) }), 'Solver iterations per frame; each adds one bounce that responds within the frame'),
        row('Reflections', toggleControl(q.reflections, (v) => setQuality({ reflections: v }))),
        row('Caustics', selectControl(q.caustics, [['off', 'Off'], ['low', 'Low'], ['high', 'High']], (v) => setQuality({ caustics: v }))),
      ]),
      section('Diagnostics', [
        row('View', selectControl(String(app.view), VIEWS, (v) => { app.view = Number(v); })),
        numbers,
      ]),
      section('GPU passes', [timings], false));
  }

  function helpMenu() {
    return h('div', { class: 'menu', style: 'width:300px' }, h('div', { class: 'group' }, 'Shortcuts'),
      ...SHORTCUTS.map(([k, label]) => h('div', { class: 'entry', style: 'display:flex;justify-content:space-between;gap:16px;padding:3px 8px' }, h('span', null, label), h('span', { class: 'keys' }, k))),
      h('div', { class: 'group' }, 'Pointer'),
      h('p', { class: 'note', style: 'padding:0 8px 6px' }, 'Right-drag orbits, middle-drag or two fingers pan, wheel or pinch zooms. In Select, drag an object across the floor; Shift lifts it. Pen pressure sets the width of a painted stroke.'));
  }

  // --- understand the light ----------------------------------------------------------------------

  const divider = h('div', { class: 'divider', role: 'slider', tabIndex: 0, 'aria-label': 'Direct light against the full result' },
    h('span', { class: 'tag l' }, 'Direct only'), h('span', { class: 'tag r' }, 'With bounces'), h('div', { class: 'grip' }));
  const explain = h('div', { class: 'explain' });
  const placeDivider = () => { divider.style.left = `${app.renderer.split.value * 100}%`; };
  divider.addEventListener('pointerdown', (e) => { divider.setPointerCapture(e.pointerId); e.preventDefault(); });
  divider.addEventListener('pointermove', (e) => {
    if (!divider.hasPointerCapture(e.pointerId)) return;
    app.renderer.split.value = clamp(e.clientX / innerWidth, 0.02, 0.98);
    placeDivider();
  });
  divider.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    app.renderer.split.value = clamp(app.renderer.split.value + (e.key === 'ArrowLeft' ? -0.02 : 0.02), 0.02, 0.98);
    placeDivider();
    e.stopPropagation();
  });

  function setUnderstand(on: boolean) {
    state.understand = on;
    app.renderer.compare = on;
    understandButton.classList.toggle('on', on);
    if (!on) {
      divider.remove(); explain.remove();
      app.view = 0; app.bounce = 1;
      return;
    }
    // Start the divider in the middle of the visible viewport.
    const left = rail.offsetWidth, right = state.inspector && !narrow() ? inspector.offsetWidth : 0;
    app.renderer.split.value = (left + (innerWidth - left - right) / 2) / innerWidth;
    placeDivider();
    explain.replaceChildren(
      h('h2', null, 'Where the light comes from'),
      h('p', null, 'Left of the line is direct light only: what reaches a surface straight from a lamp, a painted stroke, the sun or the sky through an opening. Right of it, the same instant with every further bounce. The difference is the light and colour that surfaces hand to each other.'),
      row('Lighting only', toggleControl(app.view === 1, (v) => { app.view = v ? 1 : 0; }), 'Shows the light arriving at each surface without the surface colour'),
      row('Bounced light', numberControl(app.bounce, { min: 0, max: 1.5, digits: 2, unit: '×', reset: 1 }, (v) => { app.bounce = v; }, () => 0).el, 'Scales the light that surfaces re-emit; 1 is physical'),
      h('p', { style: 'margin:8px 0 0' }, 'Try it: move a coloured panel towards a white wall, close a window, or switch a light off and watch the right side follow.'));
    ui.append(divider, explain);
  }

  // --- meter, hint, presentation -----------------------------------------------------------------

  const meterEl = h('div', { class: 'meter' });
  const showMeter = () => {
    const m = tools.meter;
    if (!m || tools.mode !== 'meter') { meterEl.remove(); return; }
    const lux = luminanceOf(m.illuminance) * 1000;
    const peak = Math.max(...m.illuminance, 1e-6);
    const sw = m.illuminance.map((v) => Math.round(255 * (v / peak) ** (1 / 2.2)));
    meterEl.replaceChildren(h('i', { style: `background:rgb(${sw.join(',')})` }), `${lux >= 100 ? Math.round(lux).toLocaleString('en-US') : lux.toFixed(1)} lx`);
    meterEl.style.left = `${m.x}px`;
    meterEl.style.top = `${m.y}px`;
    if (!meterEl.isConnected) ui.append(meterEl);
  };

  const presentNote = h('div', { class: 'present-note' }, 'Esc returns to the studio');
  function setPresenting(on: boolean) {
    state.presenting = on;
    closeMenu?.();
    ui.classList.toggle('presenting', on);
    app.overlay.visible = !on;
    syncInsets();
    if (on) { setMode('navigate'); (document.activeElement as HTMLElement | null)?.blur(); }
    else setMode('select');
  }

  function showHint() {
    const el = h('div', { class: 'hint', role: 'note' },
      h('span', null, 'Press ', h('kbd', null, 'B'), ' and draw on any surface to paint light. Right-drag looks around. ', h('kbd', null, 'U'), ' shows what the bounces add.'),
      iconButton('close', 'Dismiss', () => { el.remove(); markHintSeen(); }));
    ui.append(el);
  }

  // --- state -------------------------------------------------------------------------------------

  function setMode(m: Mode) {
    if (m === 'etch') {
      // Etching needs a frosted slab; pick the selected one or the first in the scene.
      const sel = doc.selectedObject;
      const ok = (o?: SceneObject) => !!o && o.kind === 'glass' && o.shape === 'slab' && o.frost > 0.05;
      if (!ok(sel)) {
        const first = doc.scene.objects.find(ok);
        if (first) doc.select({ type: 'object', id: first.id });
        else toast('Etching works on frosted glass: add a Frosted panel, or raise Frost on a glass slab');
      }
    }
    tools.setMode(m);
  }
  function syncTools() {
    for (const [m, el] of modeButtons) { el.classList.toggle('on', tools.mode === m); el.setAttribute('aria-pressed', String(tools.mode === m)); }
    for (const [t, el] of transformButtons) el.classList.toggle('on', tools.transform === t);
    strip.style.display = doc.selectedObject && tools.mode === 'select' ? '' : 'none';
    showMeter();
  }
  function syncPlay() {
    const p = app.clock.playing;
    playButton.replaceChildren(icon(p ? 'pause' : 'play'));
    tlPlay.replaceChildren(icon(p ? 'pause' : 'play', 16));
  }
  function togglePlay() { app.clock.playing = !app.clock.playing; syncPlay(); }
  // The picture is centred in the part of the viewport the panels leave free.
  const narrow = () => innerWidth <= 760;
  function syncInsets() {
    app.setInsets(state.presenting ? { left: 0, right: 0, top: 0, bottom: 0 }
      : { left: rail.offsetWidth, right: state.inspector && !narrow() ? inspector.offsetWidth : 0, top: 0, bottom: state.timeline ? timeline.offsetHeight : 0 });
  }
  function setInspector(on: boolean) { state.inspector = on; ui.classList.toggle('with-inspector', on); panelButton.classList.toggle('on', on); syncInsets(); }
  function setTimeline(on: boolean) { state.timeline = on; ui.classList.toggle('with-timeline', on); timelineButton.classList.toggle('on', on); if (on) renderMotions(); syncInsets(); }

  let lastMode: Mode = tools.mode;
  tools.onChange.add(() => {
    syncTools();
    if (tools.mode !== lastMode) { lastMode = tools.mode; schedule(); if (tools.mode === 'paint' || tools.mode === 'etch') setInspector(true); }
  });

  let saveTimer = 0;
  const persist = () => {
    if (!opts.persist) return;
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => saveScene(app.serialize()), 700);
  };
  app.controls.addEventListener('end', persist);

  doc.on((kind) => {
    persist();
    if (kind === 'values') {
      if (ctx.editing.active) {
        // The control being used already shows its value; refresh derived readouts once the gesture ends.
        if (dragging) wanted = true;
        else if ((document.activeElement as HTMLElement | null)?.classList.contains('num')) schedule();
      } else if (!dragging) schedule(160);
      undoButton.disabled = false;
      return;
    }
    if (kind === 'selection' && doc.selection.type !== 'none') setInspector(true);
    // Painting and dragging edit the structure at pointer rate; the panels follow at a calmer pace.
    schedule(kind === 'structure' && !ctx.editing.active ? 120 : 0);
    syncTools();
  });

  // Throttled readouts.
  let tick = 0;
  app.onFrame.add(() => {
    tick++;
    if (state.timeline && !scrubbing) {
      const p = app.clock.time / doc.scene.loop;
      scrub.value = String(p);
      scrub.style.setProperty('--p', `${p * 100}%`);
    }
    if (tick % 6 === 0 && state.timeline) timeText.textContent = `${app.clock.time.toFixed(1)} / ${doc.scene.loop.toFixed(0)} s`;
    if (tick % 20 === 0) {
      const s = app.stats;
      status.replaceChildren(h('b', null, `${Math.round(s.fps)}`), ` fps · ${s.tier} · ${s.width}×${s.height}`);
    }
  });

  // --- keyboard ----------------------------------------------------------------------------------

  addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.matches?.('input:not([type=range]):not([type=checkbox]), select, textarea')) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = e.key.toLowerCase();
    if (state.presenting) { if (k === 'escape' || k === 'p') { setPresenting(false); e.preventDefault(); } else if (k === ' ') { togglePlay(); e.preventDefault(); } return; }
    const sel = doc.selectedObject;
    let handled = true;
    if (mod && k === 'z') { if (e.shiftKey) doc.redo(); else doc.undo(); }
    else if (mod && k === 'y') doc.redo();
    else if (mod && k === 'd') { if (sel) tools.duplicate(sel.id); }
    else if (mod) handled = false;
    else if (k === 'v') setMode('select');
    else if (k === 'n') setMode('navigate');
    else if (k === 'b') setMode('paint');
    else if (k === 'e') setMode('erase');
    else if (k === 'f') setMode('etch');
    else if (k === 'm') setMode('meter');
    else if (k === 'g') { setMode('select'); tools.setTransform('move'); }
    else if (k === 'r') { setMode('select'); tools.setTransform('rotate'); }
    else if (k === 's') { setMode('select'); tools.setTransform('scale'); }
    else if (k === 'a') menu(addButton, libraryMenu());
    else if (k === 'u') setUnderstand(!state.understand);
    else if (k === ' ') togglePlay();
    else if (k === 't') setTimeline(!state.timeline);
    else if (k === 'i') setInspector(!state.inspector);
    else if (k === 'p') setPresenting(true);
    else if (k === '?' || (k === '/' && e.shiftKey)) menu(helpButton, helpMenu());
    else if (k === '[' || k === ']') { tools.brush.width = clamp(tools.brush.width * (k === ']' ? 1.2 : 1 / 1.2), 0.01, 0.3); if (tools.mode === 'paint') schedule(); }
    else if (k === 'delete' || k === 'backspace') { if (sel) tools.remove(sel.id); else if (doc.selectedAperture) removeAperture(doc.selectedAperture.id); }
    else if (k === 'escape') {
      if (closeMenu) closeMenu();
      else if (tools.mode !== 'select') setMode('select');
      else if (state.understand) setUnderstand(false);
      else doc.select({ type: 'none' });
    } else handled = false;
    if (handled) e.preventDefault();
  });

  // --- mount -------------------------------------------------------------------------------------

  status.textContent = `${app.stats.tier} · ${app.stats.width}×${app.stats.height}`;
  ui.append(rail, top, inspector, timeline, presentNote);
  setInspector(state.inspector);
  addEventListener('resize', syncInsets);
  renderInspector();
  renderMotions();
  syncTools();
  syncPlay();
  if (opts.persist && !hintSeen()) showHint();
}
