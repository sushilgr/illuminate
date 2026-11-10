// Numerical validation of the solver against reference values.
// Run with ?scene=<name> and call __illuminate.validate(); see docs/ARCHITECTURE.md for results.
import { ROOM_SIZE } from '../scene/presets';
import { TEST_EMITTER, TEST_RIBBON } from '../scene/tests';
import type { Vec3 } from '../scene/types';
import type { GISystem } from './GISystem';

interface Pt { p: Vec3; n: Vec3 }
export interface ValidationRow { label: string; measured: number; reference: number; error: number }
export interface ValidationResult { scene: string; rows: ValidationRow[]; note: string }

/** Irradiance at pt from a Lambertian rectangle (centre c, half-axes u and v, normal nf), unoccluded. */
function rectIrradiance(pt: Pt, c: Vec3, u: Vec3, v: Vec3, nf: Vec3, L: number, res = 96): number {
  const area = 4 * Math.hypot(...u) * Math.hypot(...v);
  let sum = 0;
  for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) {
    const a = ((i + 0.5) / res) * 2 - 1, b = ((j + 0.5) / res) * 2 - 1;
    const q: Vec3 = [c[0] + a * u[0] + b * v[0], c[1] + a * u[1] + b * v[1], c[2] + a * u[2] + b * v[2]];
    const d: Vec3 = [q[0] - pt.p[0], q[1] - pt.p[1], q[2] - pt.p[2]];
    const r2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    const r = Math.sqrt(r2);
    const cr = (d[0] * pt.n[0] + d[1] * pt.n[1] + d[2] * pt.n[2]) / r;
    const ce = -(d[0] * nf[0] + d[1] * nf[1] + d[2] * nf[2]) / r;
    if (cr > 0 && ce > 0) sum += (cr * ce) / r2;
  }
  return (L * sum * area) / (res * res);
}

function boxIrradiance(pt: Pt): number {
  const { centre: c, size: s, radiance: L } = TEST_EMITTER;
  const h: Vec3 = [s[0] / 2, s[1] / 2, s[2] / 2];
  let E = 0;
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const nf: Vec3 = [0, 0, 0]; nf[axis] = sign;
    const fc: Vec3 = [c[0], c[1], c[2]]; fc[axis] += sign * h[axis];
    const a1 = (axis + 1) % 3, a2 = (axis + 2) % 3;
    const u: Vec3 = [0, 0, 0], v: Vec3 = [0, 0, 0];
    u[a1] = h[a1]; v[a2] = h[a2];
    E += rectIrradiance(pt, fc, u, v, nf, L);
  }
  return E;
}

function ribbonIrradiance(pt: Pt): number {
  const { a, b, width, radiance: L } = TEST_RIBBON;
  const c: Vec3 = [(a[0] + b[0]) / 2, a[1], (a[2] + b[2]) / 2];
  const u: Vec3 = [(b[0] - a[0]) / 2, 0, 0], v: Vec3 = [0, 0, width / 2];
  return rectIrradiance(pt, c, u, v, [0, -1, 0], L, 256) + rectIrradiance(pt, c, u, v, [0, 1, 0], L, 256);
}

async function meter(gi: GISystem, pts: Pt[]): Promise<number[]> {
  const data = new Float32Array(pts.length * 8);
  pts.forEach((q, i) => { data.set(q.p, i * 8); data.set(q.n, i * 8 + 4); });
  const out = await gi.measure(data);
  return pts.map((_, i) => out[i * 4]);
}

const row = (label: string, measured: number, reference: number): ValidationRow => ({
  label, measured: +measured.toFixed(4), reference: +reference.toFixed(4),
  error: reference > 1e-6 ? +(((measured - reference) / reference) * 100).toFixed(1) : +measured.toFixed(4),
});

export async function validate(scene: string, gi: GISystem, step: (n: number) => Promise<void>): Promise<ValidationResult> {
  const [W, H, D] = ROOM_SIZE;
  const floor = (x: number, z = 0): Pt => ({ p: [x, 0, z], n: [0, 1, 0] });
  const wall: Pt = { p: [-W / 2, 1.0, 0], n: [1, 0, 0] };
  if (scene === 'area' || scene === 'umbra') {
    await step(3);
    const pts = [floor(0), floor(0.5), floor(1.0), floor(1.5), floor(2.2), floor(0, 1.2), wall];
    const labels = ['floor x=0', 'floor x=0.5', 'floor x=1.0', 'floor x=1.5', 'floor x=2.2', 'floor z=1.2', 'wall y=1.0'];
    const m = await meter(gi, pts);
    const rows = pts.map((q, i) => row(labels[i], m[i], boxIrradiance(q)));
    return {
      scene, rows,
      note: scene === 'umbra'
        ? 'Reference is the unoccluded value. x=0 and x=0.5 lie in full umbra (expected 0), x=1.0 in the penumbra, the rest are unoccluded.'
        : 'Direct irradiance from a 0.8 m square emitter at 2 m, black room. Error in percent.',
    };
  }
  if (scene === 'ribbon') {
    await step(3);
    const ceil: Pt = { p: [0, H, 0], n: [0, -1, 0] };
    const pts = [floor(0), floor(0.75), floor(1.5), floor(2.25), floor(0, 1.0), floor(1.5, 1.0), wall, ceil];
    const labels = ['floor x=0', 'floor x=0.75', 'floor x=1.5', 'floor x=2.25', 'floor z=1.0', 'floor x=1.5 z=1.0', 'wall y=1.0', 'ceiling'];
    const m = await meter(gi, pts);
    return { scene, rows: pts.map((q, i) => row(labels[i], m[i], ribbonIrradiance(q))), note: 'Direct irradiance from a 2 m x 6 cm two-sided ribbon at 1.8 m, black room. Error in percent.' };
  }
  if (scene === 'enclosure') {
    const rho = 0.5;
    const s = TEST_EMITTER.size;
    const boxArea = 2 * (s[0] * s[1] + s[1] * s[2] + s[0] * s[2]);
    const roomArea = 2 * (W * H + W * D + H * D);
    const flux = Math.PI * TEST_EMITTER.radiance * boxArea;
    const expected = flux / ((roomArea + boxArea) * (1 - rho));
    const faces: { o: Vec3; u: Vec3; v: Vec3; n: Vec3; area: number }[] = [
      { o: [0, 0, 0], u: [W / 2, 0, 0], v: [0, 0, D / 2], n: [0, 1, 0], area: W * D },
      { o: [0, H, 0], u: [W / 2, 0, 0], v: [0, 0, D / 2], n: [0, -1, 0], area: W * D },
      { o: [-W / 2, H / 2, 0], u: [0, H / 2, 0], v: [0, 0, D / 2], n: [1, 0, 0], area: H * D },
      { o: [W / 2, H / 2, 0], u: [0, H / 2, 0], v: [0, 0, D / 2], n: [-1, 0, 0], area: H * D },
      { o: [0, H / 2, -D / 2], u: [W / 2, 0, 0], v: [0, H / 2, 0], n: [0, 0, 1], area: W * H },
      { o: [0, H / 2, D / 2], u: [W / 2, 0, 0], v: [0, H / 2, 0], n: [0, 0, -1], area: W * H },
    ];
    const res = 14;
    const pts: Pt[] = [];
    for (const f of faces) for (let i = 0; i < res; i++) for (let j = 0; j < res; j++) {
      const a = ((i + 0.5) / res) * 2 - 1, b = ((j + 0.5) / res) * 2 - 1;
      pts.push({ p: [f.o[0] + a * f.u[0] + b * f.v[0], f.o[1] + a * f.u[1] + b * f.v[1], f.o[2] + a * f.u[2] + b * f.v[2]], n: f.n });
    }
    const mean = async () => {
      const m = await meter(gi, pts);
      let sum = 0;
      faces.forEach((f, k) => { let fs = 0; for (let i = 0; i < res * res; i++) fs += m[k * res * res + i]; sum += (fs / (res * res)) * f.area; });
      return sum / roomArea;
    };
    const rows: ValidationRow[] = [];
    let done = 0;
    for (const frames of [1, 2, 4, 8, 16, 32]) {
      await step(frames - done); done = frames;
      // After k solver iterations the solution holds bounces 0..k-1: the partial geometric series.
      rows.push(row(`mean E after ${frames} iterations`, await mean(), expected * (1 - rho ** frames)));
    }
    return { scene, rows, note: `Grey enclosure, albedo ${rho}. Converged mean irradiance must equal flux / (area (1 - albedo)) = ${expected.toFixed(4)}; the reference column is the partial sum expected after k bounces.` };
  }
  return { scene, rows: [], note: 'No validation defined for this scene.' };
}
