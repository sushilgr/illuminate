// Colour helpers. Scene colours are linear RGB; the interface shows sRGB hex.
import type { Vec3 } from './types';

const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

/** sRGB hex number -> linear RGB. */
export function hex(c: number): Vec3 {
  return [toLinear(((c >> 16) & 255) / 255), toLinear(((c >> 8) & 255) / 255), toLinear((c & 255) / 255)];
}

export function hexString(c: Vec3): string {
  const h = (v: number) => Math.round(Math.min(Math.max(toSrgb(Math.min(Math.max(v, 0), 1)), 0), 1) * 255).toString(16).padStart(2, '0');
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}

export function parseHex(s: string): Vec3 {
  return hex(parseInt(s.replace('#', ''), 16));
}

/** Chromaticity of a black body at `kelvin`, linear RGB with a maximum component of 1. */
export function kelvin(k: number): Vec3 {
  // Krystek's approximation of the Planckian locus in CIE 1960 UCS, then xy -> XYZ -> sRGB.
  const t = Math.min(Math.max(k, 1000), 15000);
  const u = (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) / (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t);
  const v = (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) / (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t);
  const x = (3 * u) / (2 * u - 8 * v + 4), y = (2 * v) / (2 * u - 8 * v + 4);
  const X = x / y, Z = (1 - x - y) / y;
  const rgb: Vec3 = [3.2406 * X - 1.5372 - 0.4986 * Z, -0.9689 * X + 1.8758 + 0.0415 * Z, 0.0557 * X - 0.204 + 1.057 * Z];
  const m = Math.max(rgb[0], rgb[1], rgb[2]);
  return [Math.max(rgb[0], 0) / m, Math.max(rgb[1], 0) / m, Math.max(rgb[2], 0) / m];
}

export const luminanceOf = (c: Vec3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/** OKLCH -> linear sRGB, used by the palette swatches so they are perceptually even. */
export function oklch(L: number, C: number, hDeg: number): Vec3 {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    Math.max(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, 0),
    Math.max(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, 0),
    Math.max(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s, 0),
  ];
}
