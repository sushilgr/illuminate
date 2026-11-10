// A small DOM kit for the interface: element builder and the precise controls the inspector
// is made of. Controls write through callbacks; nothing here re-renders on a frame.
import { hexString, parseHex } from '../scene/color';
import type { Vec3 } from '../scene/types';

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: string; title?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in el && k !== 'style' && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

export function svgIcon(path: string, size = 18): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = path;
  return svg;
}

export interface NumberSpec {
  min: number;
  max: number;
  step?: number;
  /** Display precision. */
  digits?: number;
  unit?: string;
  /** Slider travel is logarithmic (for ranges spanning orders of magnitude). */
  log?: boolean;
  /** Value shown = stored value * scale (e.g. radians stored, degrees shown). */
  scale?: number;
  /** Double-click resets to this. */
  reset?: number;
}

export interface NumberControl {
  el: HTMLElement;
  set(v: number): void;
}

/**
 * A slider with an exact numeric entry beside it. `onInput` fires while dragging,
 * `onCommit` when the gesture ends (one undo step per gesture).
 */
export function numberControl(value: number, spec: NumberSpec, onInput: (v: number) => void, onCommit: () => void): NumberControl {
  const scale = spec.scale ?? 1;
  const digits = spec.digits ?? 2;
  const toPos = (v: number) => spec.log ? Math.log(Math.max(v, spec.min) / spec.min) / Math.log(spec.max / spec.min) : (v - spec.min) / (spec.max - spec.min);
  const fromPos = (p: number) => spec.log ? spec.min * (spec.max / spec.min) ** p : spec.min + p * (spec.max - spec.min);
  const range = h('input', { type: 'range', min: '0', max: '1', step: '0.001', class: 'range' });
  const box = h('input', { type: 'text', class: 'num', inputMode: 'decimal', spellcheck: false });
  let current = value;
  const show = (v: number) => {
    current = v;
    range.value = String(Math.min(Math.max(toPos(v), 0), 1));
    range.style.setProperty('--p', `${Math.min(Math.max(toPos(v), 0), 1) * 100}%`);
    if (document.activeElement !== box) box.value = (v * scale).toFixed(digits);
  };
  const snap = (v: number) => {
    const s = spec.step;
    return Math.min(Math.max(s ? Math.round(v / s) * s : v, spec.min), spec.max);
  };
  range.addEventListener('input', () => { const v = snap(fromPos(Number(range.value))); show(v); onInput(v); });
  range.addEventListener('change', onCommit);
  range.addEventListener('dblclick', () => { if (spec.reset !== undefined) { show(spec.reset); onInput(spec.reset); onCommit(); } });
  const commitBox = () => {
    const parsed = Number(box.value.replace(',', '.'));
    if (Number.isFinite(parsed)) {
      // Typed values may exceed the slider's travel, within reason.
      const v = Math.min(Math.max(parsed / scale, spec.min - (spec.max - spec.min)), spec.max + 4 * (spec.max - spec.min));
      show(v); onInput(v); onCommit();
    }
    box.value = (current * scale).toFixed(digits);
  };
  box.addEventListener('change', commitBox);
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') box.blur();
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const st = (spec.step ?? (spec.max - spec.min) / 100) * (e.shiftKey ? 10 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
      const v = snap(current + st);
      show(v); onInput(v); onCommit();
      box.value = (v * scale).toFixed(digits);
    }
    e.stopPropagation();
  });
  show(value);
  const el = h('div', { class: 'numctl' }, range, h('span', { class: 'numbox' }, box, spec.unit ? h('span', { class: 'unit' }, spec.unit) : null));
  return { el, set: show };
}

export function colorControl(value: Vec3, onInput: (c: Vec3) => void, onCommit: () => void, swatches: Vec3[] = []): { el: HTMLElement; set(c: Vec3): void } {
  const input = h('input', { type: 'color', class: 'color', value: hexString(value) });
  const hexBox = h('input', { type: 'text', class: 'num hex', spellcheck: false, value: hexString(value) });
  input.addEventListener('input', () => { hexBox.value = input.value; onInput(parseHex(input.value)); });
  input.addEventListener('change', onCommit);
  hexBox.addEventListener('change', () => {
    if (/^#?[0-9a-fA-F]{6}$/.test(hexBox.value)) { const v = hexBox.value.startsWith('#') ? hexBox.value : `#${hexBox.value}`; input.value = v; onInput(parseHex(v)); onCommit(); }
    hexBox.value = input.value;
  });
  hexBox.addEventListener('keydown', (e) => { if (e.key === 'Enter') hexBox.blur(); e.stopPropagation(); });
  const sw = swatches.map((c) => h('button', {
    class: 'swatch', style: `background:${hexString(c)}`, title: hexString(c),
    onclick: () => { input.value = hexString(c); hexBox.value = input.value; onInput(c); onCommit(); },
  }));
  const el = h('div', { class: 'colorctl' }, h('div', { class: 'colorrow' }, input, hexBox), sw.length ? h('div', { class: 'swatches' }, ...sw) : null);
  return { el, set(c) { if (document.activeElement !== input) { input.value = hexString(c); hexBox.value = input.value; } } };
}

export function selectControl<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLSelectElement {
  const el = h('select', { class: 'select' }, ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  el.addEventListener('change', () => onChange(el.value as T));
  return el;
}

export function toggleControl(value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const input = h('input', { type: 'checkbox', checked: value });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'toggle' }, input, h('span', { class: 'track' }));
}

export function segmented<T extends string>(value: T, options: [T, string][], onChange: (v: T) => void): HTMLElement {
  const el = h('div', { class: 'segmented', role: 'radiogroup' });
  const render = (cur: T) => {
    el.replaceChildren(...options.map(([v, label]) => h('button', {
      class: v === cur ? 'on' : '', role: 'radio', 'aria-checked': String(v === cur), onclick: () => { render(v); onChange(v); },
    }, label)));
  };
  render(value);
  return el;
}

/** A labelled row. */
export function row(label: string, control: Node, hint?: string): HTMLElement {
  return h('div', { class: 'row', title: hint }, h('span', { class: 'label' }, label), control);
}

/** A collapsible group of rows. Open state is remembered per title for the session. */
const openState = new Map<string, boolean>();
export function section(title: string, rows: (Node | null | false)[], open = true, action?: Node): HTMLElement {
  const isOpen = openState.get(title) ?? open;
  const body = h('div', { class: 'section-body' }, ...rows.filter(Boolean) as Node[]);
  const head = h('button', { class: 'section-head', 'aria-expanded': String(isOpen) }, h('span', { class: 'chev' }), h('span', null, title));
  const el = h('section', { class: `section${isOpen ? '' : ' closed'}` }, h('div', { class: 'section-top' }, head, action ?? null), body);
  head.addEventListener('click', () => {
    const now = el.classList.toggle('closed');
    openState.set(title, !now);
    head.setAttribute('aria-expanded', String(!now));
  });
  return el;
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `btn ${cls}`, onclick: onClick }, label);
}

/** A small anchored menu; closes on outside press or Escape. */
export function popover(anchor: HTMLElement, content: HTMLElement, align: 'right' | 'below' | 'above' = 'right'): () => void {
  const el = h('div', { class: 'popover', role: 'menu' }, content);
  document.getElementById('ui')!.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth, ht = el.offsetHeight;
  let x = align === 'right' ? r.right + 8 : r.left;
  let y = align === 'below' ? r.bottom + 6 : align === 'above' ? r.top - ht - 6 : r.top;
  x = Math.min(Math.max(x, 8), innerWidth - w - 8);
  y = Math.min(Math.max(y, 8), innerHeight - ht - 8);
  el.style.left = `${x}px`;
  el.style.top = `${y}px`;
  const close = () => { el.remove(); removeEventListener('pointerdown', onDown, true); removeEventListener('keydown', onKey, true); };
  const onDown = (e: Event) => { if (!el.contains(e.target as Node) && !anchor.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); anchor.focus(); } };
  addEventListener('pointerdown', onDown, true);
  addEventListener('keydown', onKey, true);
  return close;
}
