// Evaluates motions. Everything is a pure function of the loop phase, so a loop repeats exactly.
import type { Aperture, Daylight, Motion, SceneObject, Vec3 } from './types';

const AXIS = { x: 0, y: 1, z: 2 } as const;

/** Maps cycle position u (0..1) to -1..1 according to the easing. */
function wave(u: number, easing: Motion['easing']): number {
  switch (easing) {
    case 'sine': return Math.sin(u * Math.PI * 2);
    case 'linear': return u < 0.25 ? u * 4 : u < 0.75 ? 2 - u * 4 : u * 4 - 4;
    case 'ease': { const t = u < 0.5 ? u * 2 : 2 - u * 2; return (t * t * (3 - 2 * t)) * 2 - 1; }
    case 'hold': { const t = Math.sin(u * Math.PI * 2); return Math.tanh(t * 4) / Math.tanh(4); }
  }
}

function samplePath(path: Vec3[], t: number): Vec3 {
  if (path.length === 0) return [0, 0, 0];
  const f = Math.min(Math.max(t, 0), 1) * (path.length - 1);
  const i = Math.min(Math.floor(f), path.length - 2 < 0 ? 0 : path.length - 2), k = f - i;
  const a = path[i], b = path[Math.min(i + 1, path.length - 1)];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export interface Evaluated<T> { value: T; level: number }

/** Applies `motions` to a shallow copy of `target`. `phase` is the loop phase 0..1. */
export function applyMotions<T extends { motions: Motion[] }>(target: T, phase: number): Evaluated<T> {
  const active = target.motions.filter((m) => m.enabled);
  if (active.length === 0) return { value: target, level: 1 };
  const o = { ...target } as T & { position?: Vec3; rotation?: Vec3 } & Record<string, unknown>;
  if (o.position) o.position = [...o.position] as Vec3;
  if (o.rotation) o.rotation = [...o.rotation] as Vec3;
  let level = 1;
  for (const m of active) {
    const u = (((phase * Math.max(Math.round(m.cycles), 1) + m.phase) % 1) + 1) % 1;
    const s = wave(u, m.easing);
    const ax = AXIS[m.axis];
    switch (m.kind) {
      case 'orbit': if (o.position) {
        const a = (ax + 1) % 3, b = (ax + 2) % 3;
        o.position[a] += m.amplitude * Math.cos(u * Math.PI * 2);
        o.position[b] += m.amplitude * Math.sin(u * Math.PI * 2);
      } break;
      case 'slide': if (o.position) o.position[ax] += m.amplitude * s; break;
      case 'pendulum': if (o.rotation) o.rotation[ax] += m.amplitude * s; break;
      case 'spin': if (o.rotation) o.rotation[ax] += Math.sign(m.amplitude || 1) * u * Math.PI * 2; break;
      case 'breathe': level *= 1 - Math.min(Math.max(m.amplitude, 0), 1) * (0.5 - 0.5 * s); break;
      case 'path': if (o.position && m.path) {
        const q = samplePath(m.path, 0.5 - 0.5 * Math.cos(u * Math.PI * 2));
        o.position[0] += q[0] * m.amplitude; o.position[1] += q[1] * m.amplitude; o.position[2] += q[2] * m.amplitude;
      } break;
      case 'param': if (m.param && typeof o[m.param] === 'number') (o as Record<string, unknown>)[m.param] = (o[m.param] as number) + m.amplitude * s; break;
    }
  }
  return { value: o, level };
}

export function evaluateObject(o: SceneObject, phase: number, elapsed: number): Evaluated<SceneObject> {
  const e = applyMotions(o, phase);
  if (o.kind === 'stroke' && o.fade > 0) e.level *= Math.min(Math.max(1 - (elapsed - o.born) / o.fade, 0), 1);
  return e;
}

export const evaluateDaylight = (d: Daylight, phase: number): Daylight => applyMotions(d, phase).value;
export const evaluateAperture = (a: Aperture, phase: number): Aperture => {
  const v = applyMotions(a, phase).value;
  return v === a ? a : { ...v, shutter: Math.min(Math.max(v.shutter, 0), 1) };
};
