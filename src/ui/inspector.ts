// The contextual inspector: controls for the current selection and the active tool.
// Every control writes through the scene document, one undo step per gesture.
import type { App } from '../app/App';
import { hex, kelvin, luminanceOf, oklch } from '../scene/color';
import { emission as makeEmission } from '../scene/library';
import type { Tools } from '../edit/Tools';
import type { Aperture, Emission, SceneDescription, SceneObject, Surface, Vec3 } from '../scene/types';
import { button, colorControl, h, numberControl, row, section, segmented, selectControl, toggleControl, type NumberSpec } from './kit';

const DEG = 180 / Math.PI;
const SURFACE_SWATCHES: Vec3[] = [0xe9e5dd, 0xcfc9be, 0x9a958e, 0x4a4440, 0x1d1a18, 0xb04a2c, 0xd9a032, 0x8fb4a0, 0x6f9983, 0x2a4bc0].map(hex);
const LIGHT_SWATCHES: Vec3[] = [kelvin(2200), kelvin(2700), kelvin(3200), kelvin(4000), kelvin(5600), kelvin(7500), oklch(0.72, 0.19, 30), oklch(0.75, 0.15, 150), oklch(0.7, 0.16, 260)];

export interface InspectorContext {
  app: App;
  tools: Tools;
  /** Marks edits that come from the inspector, so it does not rebuild itself under the pointer. */
  editing: { active: boolean };
  /** Rebuilds the inspector (after a tool option that changes which controls apply). */
  refresh: () => void;
}

type Mut = (s: SceneDescription) => void;

export function buildInspector(ctx: InspectorContext): Node[] {
  const { app, tools } = ctx;
  const doc = app.doc;
  const edit = (m: Mut, key: string, kind: 'values' | 'structure' = 'values') => {
    ctx.editing.active = true;
    doc.edit(m, kind, `inspector:${key}`);
    ctx.editing.active = false;
  };
  const commit = () => doc.commit();

  const num = (label: string, value: number, spec: NumberSpec, set: (s: SceneDescription, v: number) => void, hint?: string) =>
    row(label, numberControl(value, spec, (v) => edit((s) => set(s, v), label), commit).el, hint);
  const vec = (label: string, value: Vec3, spec: NumberSpec, set: (s: SceneDescription, i: number, v: number) => void) => {
    const boxes = value.map((v, i) => {
      const c = numberControl(v, spec, (x) => edit((s) => set(s, i, x), `${label}${i}`), commit);
      c.el.querySelector('.range')!.remove();
      const box = c.el.querySelector('.numbox')!;
      box.prepend(h('span', { class: 'axis' }, 'xyz'[i]));
      return box;
    });
    return row(label, h('div', { class: 'vec' }, ...boxes));
  };
  const color = (label: string, value: Vec3, set: (s: SceneDescription, c: Vec3) => void, swatches: Vec3[]) =>
    row(label, colorControl(value, (c) => edit((s) => set(s, c), label), commit, swatches).el);
  const toggle = (label: string, value: boolean, set: (s: SceneDescription, v: boolean) => void, hint?: string) =>
    row(label, toggleControl(value, (v) => { edit((s) => set(s, v), label, 'structure'); commit(); }), hint);
  const choice = <T extends string>(label: string, value: T, options: [T, string][], set: (s: SceneDescription, v: T) => void) =>
    row(label, selectControl(value, options, (v) => { edit((s) => set(s, v), label, 'structure'); commit(); }));
  const readout = (label: string, text: string) => row(label, h('span', { class: 'readout' }, text));

  // --- shared groups --------------------------------------------------------------------------

  const surfaceRows = (get: (s: SceneDescription) => Surface, cur: Surface) => [
    color('Colour', cur.color, (s, c) => { get(s).color = c; }, SURFACE_SWATCHES),
    num('Roughness', cur.roughness, { min: 0.05, max: 1, digits: 2, reset: 0.9 }, (s, v) => { get(s).roughness = v; }, 'Below 0.6 the surface shows reflections'),
    num('Metal', cur.metal, { min: 0, max: 1, digits: 2, reset: 0 }, (s, v) => { get(s).metal = v; }),
  ];

  /** Emitting area in m2, for the total-output readout and the output lock. */
  const areaOf = (o: SceneObject): number => {
    switch (o.kind) {
      case 'emitter': return o.shape === 'rect' ? 2 * o.size[0] * o.size[1] : o.shape === 'disk' ? 2 * Math.PI * (o.size[0] / 2) ** 2 : 4 * Math.PI * (o.size[0] / 2) ** 2;
      case 'decal': return o.size[0] * o.size[1];
      case 'stroke': {
        let len = 0;
        for (let i = 1; i < o.points.length; i++) len += Math.hypot(o.points[i][0] - o.points[i - 1][0], o.points[i][1] - o.points[i - 1][1], o.points[i][2] - o.points[i - 1][2]);
        return len * o.width * (o.profile === 'tube' ? Math.PI : o.onSurface ? 1 : 2);
      }
      case 'slab': return 2 * (o.size[0] * o.size[1] + o.size[1] * o.size[2] + o.size[0] * o.size[2]);
      case 'sphere': return 4 * Math.PI * o.radius ** 2;
      case 'cylinder': return 2 * Math.PI * o.radius * (o.radius + o.height);
      default: return 1;
    }
  };

  const emissionRows = (id: string, o: SceneObject, e: Emission) => {
    const get = (s: SceneDescription) => (s.objects.find((x) => x.id === id) as SceneObject & { emission: Emission }).emission;
    // Lambertian: output (klm) = pi * luminance (kcd/m2) * area.
    const flux = Math.PI * e.luminance * areaOf(o);
    return [
      color('Colour', e.color, (s, c) => { const m = Math.max(c[0], c[1], c[2], 1e-3); get(s).color = [c[0] / m, c[1] / m, c[2] / m]; }, LIGHT_SWATCHES),
      num('Luminance', e.luminance, { min: 0.2, max: 2000, log: true, digits: 1, unit: 'kcd/m²', reset: 100 }, (s, v) => { get(s).luminance = v; }, 'Emission per unit area'),
      num('Exposure', Math.log2(Math.max(e.luminance, 1e-3) / 100), { min: -9, max: 5, digits: 2, unit: 'EV', step: 0.05 }, (s, v) => { get(s).luminance = 100 * 2 ** v; }, 'Luminance in stops relative to 100 kcd/m²'),
      readout('Total output', `${flux >= 10 ? flux.toFixed(0) : flux.toFixed(2)} klm`),
      toggle('Lock output', e.lockOutput, (s, v) => { get(s).lockOutput = v; }, 'Resizing keeps the total output and changes the luminance instead'),
    ];
  };

  /** Applies a size change; with the output lock on, luminance moves inversely with area. */
  const resize = (id: string, apply: (o: SceneObject) => void) => (s: SceneDescription) => {
    const o = s.objects.find((x) => x.id === id);
    if (!o) return;
    const before = areaOf(o);
    apply(o);
    const e = (o as { emission?: Emission }).emission;
    if (e?.lockOutput) e.luminance *= before / Math.max(areaOf(o), 1e-6);
  };
  const dim = (id: string, label: string, value: number, spec: NumberSpec, apply: (o: SceneObject, v: number) => void) =>
    row(label, numberControl(value, { unit: 'm', digits: 2, ...spec }, (v) => edit(resize(id, (o) => apply(o, v)), label, 'structure'), commit).el);

  // --- object ---------------------------------------------------------------------------------

  const objectSections = (o: SceneObject): Node[] => {
    const id = o.id;
    const self = <T extends SceneObject>(s: SceneDescription) => s.objects.find((x) => x.id === id) as T;
    const out: Node[] = [];
    out.push(section('Placement', [
      vec('Position', o.position, { min: -4, max: 4, digits: 2 }, (s, i, v) => { self(s).position[i] = v; }),
      vec('Rotation', o.rotation, { min: -Math.PI, max: Math.PI, digits: 0, scale: DEG }, (s, i, v) => { self(s).rotation[i] = v; }),
    ]));
    const D = { min: 0.05, max: 4 };
    type K<T extends SceneObject['kind']> = Extract<SceneObject, { kind: T }>;
    switch (o.kind) {
      case 'slab': out.push(section('Shape', [
        dim(id, 'Width', o.size[0], D, (x, v) => { (x as K<'slab'>).size[0] = v; }),
        dim(id, 'Height', o.size[1], D, (x, v) => { (x as K<'slab'>).size[1] = v; }),
        dim(id, 'Depth', o.size[2], D, (x, v) => { (x as K<'slab'>).size[2] = v; }),
        dim(id, 'Edge radius', o.round, { min: 0, max: 0.2, digits: 3 }, (x, v) => { (x as K<'slab'>).round = v; }),
      ])); break;
      case 'cylinder': out.push(section('Shape', [
        dim(id, 'Radius', o.radius, { min: 0.03, max: 1.5 }, (x, v) => { (x as K<'cylinder'>).radius = v; }),
        dim(id, 'Height', o.height, D, (x, v) => { (x as K<'cylinder'>).height = v; }),
        dim(id, 'Edge radius', o.round, { min: 0, max: 0.2, digits: 3 }, (x, v) => { (x as K<'cylinder'>).round = v; }),
      ])); break;
      case 'sphere': out.push(section('Shape', [dim(id, 'Radius', o.radius, { min: 0.03, max: 1.5 }, (x, v) => { (x as K<'sphere'>).radius = v; })])); break;
      case 'arch': out.push(section('Shape', [
        dim(id, 'Width', o.size[0], D, (x, v) => { (x as K<'arch'>).size[0] = v; }),
        dim(id, 'Height', o.size[1], D, (x, v) => { (x as K<'arch'>).size[1] = v; }),
        dim(id, 'Depth', o.size[2], { min: 0.06, max: 1 }, (x, v) => { (x as K<'arch'>).size[2] = v; }),
        dim(id, 'Span', o.span, { min: 0.2, max: 3 }, (x, v) => { (x as K<'arch'>).span = v; }),
        dim(id, 'Rise', o.rise, { min: 0.2, max: 3 }, (x, v) => { (x as K<'arch'>).rise = v; }),
      ])); break;
      case 'curved': out.push(section('Shape', [
        dim(id, 'Radius', o.radius, { min: 0.2, max: 3 }, (x, v) => { (x as K<'curved'>).radius = v; }),
        dim(id, 'Height', o.height, D, (x, v) => { (x as K<'curved'>).height = v; }),
        dim(id, 'Thickness', o.thickness, { min: 0.05, max: 0.4 }, (x, v) => { (x as K<'curved'>).thickness = v; }),
        dim(id, 'Arc', o.angle, { min: 0.2, max: 5.8, digits: 0, scale: DEG, unit: '°' }, (x, v) => { (x as K<'curved'>).angle = v; }),
      ])); break;
      case 'folded': out.push(section('Shape', [
        dim(id, 'Panels', o.panels, { min: 2, max: 8, step: 1, digits: 0, unit: '' }, (x, v) => { (x as K<'folded'>).panels = v; }),
        dim(id, 'Panel width', o.panelWidth, { min: 0.15, max: 1.5 }, (x, v) => { (x as K<'folded'>).panelWidth = v; }),
        dim(id, 'Height', o.height, D, (x, v) => { (x as K<'folded'>).height = v; }),
        dim(id, 'Thickness', o.thickness, { min: 0.05, max: 0.3 }, (x, v) => { (x as K<'folded'>).thickness = v; }),
        dim(id, 'Fold', o.fold, { min: 0, max: 2.6, digits: 0, scale: DEG, unit: '°' }, (x, v) => { (x as K<'folded'>).fold = v; }),
      ])); break;
      case 'perforated': out.push(section('Shape', [
        dim(id, 'Width', o.size[0], D, (x, v) => { (x as K<'perforated'>).size[0] = v; }),
        dim(id, 'Height', o.size[1], D, (x, v) => { (x as K<'perforated'>).size[1] = v; }),
        dim(id, 'Thickness', o.size[2], { min: 0.05, max: 0.3 }, (x, v) => { (x as K<'perforated'>).size[2] = v; }),
        dim(id, 'Hole radius', o.hole, { min: 0.03, max: 0.4, digits: 3 }, (x, v) => { const p = x as K<'perforated'>; p.hole = Math.min(v, p.pitch * 0.45); }),
        dim(id, 'Spacing', o.pitch, { min: 0.1, max: 0.8 }, (x, v) => { const p = x as K<'perforated'>; p.pitch = v; p.hole = Math.min(p.hole, v * 0.45); }),
      ])); break;
      case 'louvers': out.push(section('Louvers', [
        dim(id, 'Width', o.size[0], D, (x, v) => { (x as K<'louvers'>).size[0] = v; }),
        dim(id, 'Height', o.size[1], D, (x, v) => { (x as K<'louvers'>).size[1] = v; }),
        dim(id, 'Slat depth', o.size[2], { min: 0.05, max: 0.5 }, (x, v) => { (x as K<'louvers'>).size[2] = v; }),
        dim(id, 'Spacing', o.pitch, { min: 0.1, max: 0.6 }, (x, v) => { (x as K<'louvers'>).pitch = v; }),
        dim(id, 'Slat thickness', o.slat, { min: 0.03, max: 0.2, digits: 3 }, (x, v) => { (x as K<'louvers'>).slat = v; }),
        dim(id, 'Tilt', o.tilt, { min: -1.5, max: 1.5, digits: 0, scale: DEG, unit: '°', reset: 0 }, (x, v) => { (x as K<'louvers'>).tilt = v; }),
      ])); break;
      case 'emitter': out.push(section('Source', [
        choice('Shape', o.shape, [['rect', 'Rectangle'], ['disk', 'Disk'], ['sphere', 'Sphere']], (s, v) => { self<K<'emitter'>>(s).shape = v; }),
        dim(id, o.shape === 'rect' ? 'Width' : 'Diameter', o.size[0], { min: 0.05, max: 3 }, (x, v) => { (x as K<'emitter'>).size[0] = v; }),
        o.shape === 'rect' && dim(id, 'Depth', o.size[1], { min: 0.05, max: 3 }, (x, v) => { (x as K<'emitter'>).size[1] = v; }),
        h('p', { class: 'note' }, 'Penumbra softness follows the source size and its distance to the blocker.'),
      ])); break;
      case 'decal': out.push(section('Patch', [
        dim(id, 'Width', o.size[0], { min: 0.05, max: 3 }, (x, v) => { (x as K<'decal'>).size[0] = v; }),
        dim(id, 'Height', o.size[1], { min: 0.05, max: 3 }, (x, v) => { (x as K<'decal'>).size[1] = v; }),
      ])); break;
      case 'stroke': out.push(section('Stroke', [
        choice('Profile', o.profile, [['ribbon', 'Ribbon'], ['tube', 'Tube']], (s, v) => { self<K<'stroke'>>(s).profile = v; }),
        dim(id, 'Width', o.width, { min: 0.01, max: 0.4, digits: 3 }, (x, v) => { (x as K<'stroke'>).width = v; }),
        num('Taper', o.taper, { min: 0, max: 1, digits: 2 }, (s, v) => { self<K<'stroke'>>(s).taper = v; }),
        num('Fade', o.fade, { min: 0, max: 60, digits: 1, unit: 's', reset: 0 }, (s, v) => { const k = self<K<'stroke'>>(s); k.fade = v; k.born = app.clock.elapsed; }, '0 keeps the stroke; otherwise its emission fades out over this time'),
        readout('Points', String(o.points.length)),
      ])); break;
      case 'spot': out.push(section('Beam', [
        color('Colour', o.color, (s, c) => { const m = Math.max(c[0], c[1], c[2], 1e-3); self<K<'spot'>>(s).color = [c[0] / m, c[1] / m, c[2] / m]; }, LIGHT_SWATCHES),
        num('Output', o.flux, { min: 0.05, max: 60, log: true, digits: 2, unit: 'klm' }, (s, v) => { self<K<'spot'>>(s).flux = v; }),
        num('Spread', o.spread, { min: 0.1, max: 2.4, digits: 0, scale: DEG, unit: '°' }, (s, v) => { self<K<'spot'>>(s).spread = v; }),
        num('Edge', o.softness, { min: 0, max: 1, digits: 2 }, (s, v) => { self<K<'spot'>>(s).softness = v; }, 'Emission profile: 0 hard-edged, 1 fully feathered'),
      ]), section('Shutters', (['Left', 'Right', 'Top', 'Bottom'] as const).map((n, i) =>
        num(n, o.shutters[i], { min: 0, max: 1, digits: 2, reset: 0 }, (s, v) => { self<K<'spot'>>(s).shutters[i] = v; })))); break;
      case 'glass': out.push(section('Glass', [
        choice('Form', o.shape, [['slab', 'Slab'], ['lens', 'Lens'], ['prism', 'Prism'], ['rod', 'Rod']], (s, v) => { self<K<'glass'>>(s).shape = v; }),
        dim(id, o.shape === 'slab' ? 'Width' : o.shape === 'prism' ? 'Side' : 'Diameter', o.size[0], { min: 0.05, max: 3 }, (x, v) => { (x as K<'glass'>).size[0] = v; }),
        o.shape !== 'lens' && dim(id, o.shape === 'slab' ? 'Height' : 'Length', o.size[1], { min: 0.05, max: 3 }, (x, v) => { (x as K<'glass'>).size[1] = v; }),
        (o.shape === 'slab' || o.shape === 'lens') && dim(id, 'Thickness', o.size[2], { min: 0.03, max: 0.5, digits: 3 }, (x, v) => { (x as K<'glass'>).size[2] = v; }),
        num('IOR', o.ior, { min: 1, max: 1.8, digits: 2, reset: 1.5 }, (s, v) => { self<K<'glass'>>(s).ior = v; }),
        color('Tint', o.tint, (s, c) => { self<K<'glass'>>(s).tint = c; }, [0xffffff, 0xd6ebe2, 0xcfe6dc, 0xe6d9c4, 0x8a6a4c, 0x9db6d6, 0x555049].map(hex)),
        num('Tint depth', o.absorption, { min: 0.01, max: 2, log: true, digits: 2, unit: 'm' }, (s, v) => { self<K<'glass'>>(s).absorption = v; }, 'Travel distance at which the tint is reached'),
        num('Frost', o.frost, { min: 0, max: 1, digits: 2, reset: 0 }, (s, v) => { self<K<'glass'>>(s).frost = v; }, 'Transmission roughness'),
        o.shape === 'slab' && num('Flute depth', o.fluteDepth, { min: 0, max: 0.03, digits: 3, unit: 'm', reset: 0 }, (s, v) => { self<K<'glass'>>(s).fluteDepth = v; }),
        o.shape === 'slab' && num('Flute pitch', o.fluteSpacing, { min: 0.01, max: 0.2, digits: 3, unit: 'm' }, (s, v) => { self<K<'glass'>>(s).fluteSpacing = v; }),
        num('Dispersion', o.dispersion, { min: 0, max: 1, digits: 2, reset: 0 }, (s, v) => { self<K<'glass'>>(s).dispersion = v; }),
        toggle('Caustics', o.caustics, (s, v) => { self<K<'glass'>>(s).caustics = v; }, 'Refract direct sun into caustics'),
        o.shape === 'slab' && h('div', { class: 'btn-row' },
          button(o.etch ? 'Etch frost (F)' : 'Start etching (F)', () => { if (o.frost < 0.3) { edit((s) => { self<K<'glass'>>(s).frost = 0.85; }, 'frost'); commit(); } tools.setMode('etch'); }),
          o.etch ? button('Clear etching', () => { edit((s) => { delete self<K<'glass'>>(s).etch; }, 'etch'); commit(); }, 'quiet') : null),
      ])); break;
    }
    if ('surface' in o) {
      out.push(section('Surface', surfaceRows((s) => self<K<'slab'>>(s).surface, o.surface)));
      out.push(section('Glow', o.emission
        ? [toggle('Emits light', true, (s) => { delete self<K<'slab'>>(s).emission; }), ...emissionRows(id, o, o.emission)]
        : [toggle('Emits light', false, (s) => { self<K<'slab'>>(s).emission = makeEmission(kelvin(3000), 8); })], !!o.emission));
    } else if ('emission' in o) {
      out.push(section('Light', emissionRows(id, o, o.emission)));
    }
    return out;
  };

  // --- opening --------------------------------------------------------------------------------

  const apertureSections = (a: Aperture): Node[] => {
    const id = a.id;
    const self = (s: SceneDescription) => s.room.apertures.find((x) => x.id === id)!;
    const room = doc.scene.room;
    const span = a.wall === 'ceiling' || a.wall.startsWith('z') ? room.size[0] : room.size[2];
    const tall = a.wall === 'ceiling' ? room.size[2] : room.size[1];
    return [section('Opening', [
      choice('Wall', a.wall, [['x-', 'Left'], ['x+', 'Right'], ['z-', 'Back'], ['z+', 'Front'], ['ceiling', 'Ceiling']], (s, v) => {
        const k = self(s); k.wall = v; k.u = 0;
        if (v === 'ceiling') { k.v = 0; k.height = Math.min(k.height, 1.6); } else k.v = Math.max(k.height / 2, Math.min(k.v, s.room.size[1] - k.height / 2));
      }),
      num('Along wall', a.u, { min: -span / 2, max: span / 2, digits: 2, unit: 'm', reset: 0 }, (s, v) => { self(s).u = v; }),
      num(a.wall === 'ceiling' ? 'Across' : 'Centre height', a.v, { min: a.wall === 'ceiling' ? -tall / 2 : 0, max: a.wall === 'ceiling' ? tall / 2 : tall, digits: 2, unit: 'm' }, (s, v) => { self(s).v = v; }),
      num('Width', a.width, { min: 0.2, max: span, digits: 2, unit: 'm' }, (s, v) => { self(s).width = v; }),
      num(a.wall === 'ceiling' ? 'Length' : 'Height', a.height, { min: 0.2, max: tall, digits: 2, unit: 'm' }, (s, v) => { const k = self(s); k.height = v; if (k.wall !== 'ceiling') k.v = Math.max(k.v, v / 2); }),
      a.wall !== 'ceiling' && h('div', { class: 'btn-row' }, button('Floor to ceiling', () => {
        edit((s) => { const k = self(s); k.height = s.room.size[1] - 0.22; k.v = k.height / 2; k.cols = Math.max(k.cols, 2); k.rows = Math.max(k.rows, 3); if (k.frame <= 0) k.frame = 0.045; }, 'ftc', 'structure');
        commit();
      })),
      num('Shutter', a.shutter, { min: 0, max: 1, digits: 2, reset: 0 }, (s, v) => { self(s).shutter = v; }, '0 open, 1 closed'),
      readout('Reveal depth', `${room.thickness.toFixed(2)} m`),
    ]), section('Glazing bars', [
      num('Panes across', a.cols, { min: 1, max: 8, step: 1, digits: 0 }, (s, v) => { self(s).cols = v; }),
      num('Panes up', a.rows, { min: 1, max: 8, step: 1, digits: 0 }, (s, v) => { self(s).rows = v; }),
      num('Bar width', a.frame, { min: 0, max: 0.15, digits: 3, unit: 'm' }, (s, v) => { self(s).frame = v; }),
    ])];
  };

  // --- scene-wide groups ----------------------------------------------------------------------

  const s0 = doc.scene;
  const dl = s0.daylight;
  const daylight = (open: boolean) => section('Daylight', [
    num('Sun height', dl.sunElevation, { min: -0.25, max: 1.55, digits: 0, scale: DEG, unit: '°' }, (s, v) => { s.daylight.sunElevation = v; }),
    num('Sun bearing', dl.sunAzimuth, { min: -Math.PI, max: Math.PI, digits: 0, scale: DEG, unit: '°' }, (s, v) => { s.daylight.sunAzimuth = v; }, 'Direction towards the sun'),
    num('Sun', dl.sunBrightness, { min: 0, max: 2, digits: 2, unit: '×', reset: 1 }, (s, v) => { s.daylight.sunBrightness = v; }, 'Direct sun; 1 is physical (about 100 klx)'),
    num('Sky', dl.skyBrightness, { min: 0, max: 4, digits: 2, unit: '×', reset: 1 }, (s, v) => { s.daylight.skyBrightness = v; }, 'Diffuse sky; 1 is physical'),
    num('Cloud', dl.cloudiness, { min: 0, max: 1, digits: 2, reset: 0 }, (s, v) => { s.daylight.cloudiness = v; }),
    num('Haze', dl.turbidity, { min: 1.8, max: 7, digits: 1, reset: 2.6 }, (s, v) => { s.daylight.turbidity = v; }, 'Atmospheric turbidity'),
    color('Sky tint', dl.skyTint, (s, c) => { s.daylight.skyTint = c; }, [0xffffff, 0xcfe0ff, 0xffe6cf].map(hex)),
  ], open);

  const rm = s0.room;
  const room = (open: boolean) => [
    section('Room', [
      num('Width', rm.size[0], { min: 3, max: 6.16, digits: 2, unit: 'm' }, (s, v) => { s.room.size[0] = v; }),
      num('Height', rm.size[1], { min: 2.2, max: 3.3, digits: 2, unit: 'm' }, (s, v) => { s.room.size[1] = v; }),
      num('Depth', rm.size[2], { min: 3, max: 5.04, digits: 2, unit: 'm' }, (s, v) => { s.room.size[2] = v; }),
      h('p', { class: 'note' }, 'The camera can look in from outside; walls stay in place for the light. Openings are real holes in the enclosure.'),
    ], open),
    section('Walls', surfaceRows((s) => s.room.wall, rm.wall), open),
    section('Floor', surfaceRows((s) => s.room.floor, rm.floor), open),
    section('Ceiling', surfaceRows((s) => s.room.ceiling, rm.ceiling), false),
  ];

  const at = s0.atmosphere;
  const atmosphere = (open: boolean) => section('Atmosphere', [
    num('Haze', at.haze, { min: 0, max: 0.25, digits: 3, unit: '/m', reset: 0 }, (s, v) => { s.atmosphere.haze = v; }, 'Extinction per metre; reveals sun shafts'),
    color('Scatter tint', at.tint, (s, c) => { s.atmosphere.tint = c; }, [0xffffff, 0xf2e6d4, 0xdbe6f5].map(hex)),
    num('Anisotropy', at.anisotropy, { min: -0.5, max: 0.9, digits: 2, reset: 0.55 }, (s, v) => { s.atmosphere.anisotropy = v; }, 'Forward scattering makes shafts glow towards the sun'),
  ], open);

  const cm = s0.camera;
  const camera = (open: boolean) => section('Camera', [
    num('Exposure', cm.exposure, { min: -8, max: 4, digits: 2, unit: 'EV', step: 0.05, reset: 0 }, (s, v) => { s.camera.exposure = v; }),
    num('Focal length', cm.focal, { min: 14, max: 120, digits: 0, unit: 'mm' }, (s, v) => { s.camera.focal = v; app.applyCamera(); }, '35 mm equivalent'),
    row('Projection', segmented(cm.projection, [['perspective', 'Perspective'], ['orthographic', 'Parallel']], (v) => { edit((s) => { s.camera.projection = v; }, 'proj'); commit(); app.applyCamera(); })),
    h('div', { class: 'btn-row' },
      button('Front', () => frame(app, [0, 1.5, 6.6], [0, 1.4, 0])),
      button('Corner', () => frame(app, [4.6, 2.3, 5.2], [0, 1.2, 0])),
      button('Plan', () => frame(app, [0, 9, 0.01], [0, 0, 0])),
      button('Inside', () => frame(app, [1.25, 1.42, 2.4], [-0.75, 1.2, -1.3]))),
  ], open);

  const fn = s0.finish;
  const finish = (open: boolean) => section('Finish', [
    row('Tone curve', selectControl(fn.toneMap, [['agx', 'AgX'], ['neutral', 'Neutral'], ['aces', 'Filmic'], ['linear', 'Linear']], (v) => { edit((s) => { s.finish.toneMap = v; }, 'tone'); commit(); })),
    num('White point', fn.whiteBalance, { min: 2500, max: 10000, digits: 0, unit: 'K', step: 50, reset: 6500 }, (s, v) => { s.finish.whiteBalance = v; }),
    num('Tint', fn.tint, { min: -1, max: 1, digits: 2, reset: 0 }, (s, v) => { s.finish.tint = v; }),
    num('Rolloff', fn.rolloff, { min: 0, max: 1, digits: 2, reset: 1 }, (s, v) => { s.finish.rolloff = v; }, 'Highlight shoulder: 0 clips, 1 rolls off fully'),
    num('Contrast', fn.contrast, { min: 0.7, max: 1.4, digits: 2, reset: 1 }, (s, v) => { s.finish.contrast = v; }),
    num('Saturation', fn.saturation, { min: 0, max: 1.6, digits: 2, reset: 1 }, (s, v) => { s.finish.saturation = v; }),
    num('Bloom', fn.bloom, { min: 0, max: 0.6, digits: 2, reset: 0.06 }, (s, v) => { s.finish.bloom = v; }),
    num('Grain', fn.grain, { min: 0, max: 0.08, digits: 3, reset: 0.012 }, (s, v) => { s.finish.grain = v; }),
    num('Vignette', fn.vignette, { min: 0, max: 0.6, digits: 2, reset: 0.05 }, (s, v) => { s.finish.vignette = v; }),
  ], open);

  // --- brush ----------------------------------------------------------------------------------

  const b = tools.brush;
  const brushNum = (label: string, value: number, spec: NumberSpec, set: (v: number) => void, hint?: string) =>
    row(label, numberControl(value, spec, set, () => 0).el, hint);
  const brush = () => section('Brush', [
    row('Profile', segmented(b.profile, [['ribbon', 'Ribbon'], ['tube', 'Tube']], (v) => { b.profile = v; })),
    row('Paint on', segmented(b.target, [['surface', 'Surfaces'], ['level', 'Level plane']], (v) => { b.target = v; ctx.refresh(); })),
    b.target === 'level'
      ? brushNum('Elevation', b.elevation, { min: 0, max: 3.2, digits: 2, unit: 'm' }, (v) => { b.elevation = v; }, 'Height of the construction plane')
      : brushNum('Surface offset', b.offset, { min: 0, max: 0.6, digits: 3, unit: 'm' }, (v) => { b.offset = v; }, 'Distance kept from the surface; small values adhere to it'),
    brushNum('Width', b.width, { min: 0.01, max: 0.3, digits: 3, unit: 'm' }, (v) => { b.width = v; }),
    row('Colour', colorControl(b.color, (c) => { const m = Math.max(c[0], c[1], c[2], 1e-3); b.color = [c[0] / m, c[1] / m, c[2] / m]; }, () => 0, LIGHT_SWATCHES).el),
    brushNum('Luminance', b.luminance, { min: 1, max: 2000, log: true, digits: 0, unit: 'kcd/m²' }, (v) => { b.luminance = v; }),
    brushNum('Taper', b.taper, { min: 0, max: 1, digits: 2 }, (v) => { b.taper = v; }),
    brushNum('Pressure', b.pressure, { min: 0, max: 1, digits: 2 }, (v) => { b.pressure = v; }, 'How much pen pressure narrows the stroke'),
    brushNum('Smoothing', b.smoothing, { min: 0, max: 1, digits: 2 }, (v) => { b.smoothing = v; }),
    brushNum('Fade', b.fade, { min: 0, max: 60, digits: 1, unit: 's', reset: 0 }, (v) => { b.fade = v; }, 'New strokes fade out over this time; 0 keeps them'),
    row('As motion', toggleControl(b.record, (v) => { b.record = v; }), 'Record the gesture as a motion path for the selected object'),
    h('p', { class: 'note' }, `Luminous colour ${luminanceOf(b.color).toFixed(2)} · strokes are resampled and simplified when you lift the pen.`),
  ]);

  // --- assemble -------------------------------------------------------------------------------

  const sel = doc.selection;
  const out: Node[] = [];
  if (tools.mode === 'paint') out.push(brush());
  if (tools.mode === 'etch') out.push(section('Etching', [
    brushNum('Brush', b.etchRadius, { min: 0.02, max: 0.3, digits: 2, unit: 'm' }, (v) => { b.etchRadius = v; }),
    h('p', { class: 'note' }, 'Drag across a frosted slab to clear the frost. Hold Alt to bring it back.'),
  ]));
  const o = doc.selectedObject;
  const a = doc.selectedAperture;
  if (o) out.push(...objectSections(o));
  else if (a) out.push(...apertureSections(a));
  else if (sel.type === 'room') out.push(...room(true));
  else if (sel.type === 'daylight') out.push(daylight(true));
  else if (sel.type === 'atmosphere') out.push(atmosphere(true));
  else if (sel.type === 'camera') out.push(camera(true));
  else if (sel.type === 'finish') out.push(finish(true));
  else out.push(daylight(true), camera(true), atmosphere(false), finish(false));
  return out;
}

/** Moves the camera to a named view. The enclosure stays intact; only the viewpoint leaves the room. */
function frame(app: App, position: Vec3, target: Vec3) {
  const c = app.doc.scene.camera;
  c.position = position;
  c.target = target;
  app.applyCamera();
}
