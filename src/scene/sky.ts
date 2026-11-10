// Daylight model.
// Units: radiance in kcd/m2 and irradiance in klx (photometric, per RGB channel), the same
// scale emitters use. A clear sky is a Preetham-style analytic distribution; cloud cover
// blends it towards a CIE overcast sky and dims and widens the sun.
import type { Daylight, Vec3 } from './types';

export const SKY_W = 128;
export const SKY_H = 64;

export interface SkyState {
  /** Equirectangular sky radiance, SKY_W x SKY_H x 4 floats. Row 0 is the zenith. The sun disc is not included. */
  texels: Float32Array;
  sunDir: Vec3;
  /** Irradiance on a surface facing the sun. */
  sunIrradiance: Vec3;
  /** Tangent of the sun's apparent angular radius (widened by cloud). */
  sunTan: number;
  sunEnabled: boolean;
}

function perez(cosTheta: number, gamma: number, cosGamma: number, c: number[]): number {
  return (1 + c[0] * Math.exp(c[1] / Math.max(cosTheta, 0.01))) * (1 + c[2] * Math.exp(c[3] * gamma) + c[4] * cosGamma * cosGamma);
}

function xyYToRgb(x: number, y: number, Y: number): Vec3 {
  const X = (x / y) * Y, Z = ((1 - x - y) / y) * Y;
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.204 * Y + 1.057 * Z,
  ];
}

export function sunDirection(d: Daylight): Vec3 {
  const ce = Math.cos(d.sunElevation), se = Math.sin(d.sunElevation);
  return [ce * Math.cos(d.sunAzimuth), se, ce * Math.sin(d.sunAzimuth)];
}

export function computeSky(d: Daylight, out?: Float32Array): SkyState {
  const texels = out ?? new Float32Array(SKY_W * SKY_H * 4);
  const T = Math.min(Math.max(d.turbidity, 1.7), 8);
  const sun = sunDirection(d);
  const up = d.sunElevation > -0.05;
  const thetaS = Math.PI / 2 - Math.max(d.sunElevation, 0);
  const cY = [0.1787 * T - 1.463, -0.3554 * T + 0.4275, -0.0227 * T + 5.3251, 0.1206 * T - 2.5771, -0.067 * T + 0.3703];
  const cx = [-0.0193 * T - 0.2592, -0.0665 * T + 0.0008, -0.0004 * T + 0.2125, -0.0641 * T - 0.8989, -0.0033 * T + 0.0452];
  const cy = [-0.0167 * T - 0.2608, -0.095 * T + 0.0092, -0.0079 * T + 0.2102, -0.0441 * T - 1.6537, -0.0109 * T + 0.0529];
  const chi = (4 / 9 - T / 120) * (Math.PI - 2 * thetaS);
  const Yz = Math.max((4.0453 * T - 4.971) * Math.tan(chi) - 0.2155 * T + 2.4192, 0.05);
  const t2 = thetaS * thetaS, t3 = t2 * thetaS;
  const xz = (0.00166 * t3 - 0.00375 * t2 + 0.00209 * thetaS) * T * T + (-0.02903 * t3 + 0.06377 * t2 - 0.03202 * thetaS + 0.00394) * T + (0.11693 * t3 - 0.21196 * t2 + 0.06052 * thetaS + 0.25886);
  const yz = (0.00275 * t3 - 0.0061 * t2 + 0.00317 * thetaS) * T * T + (-0.04214 * t3 + 0.0897 * t2 - 0.04153 * thetaS + 0.00516) * T + (0.15346 * t3 - 0.26756 * t2 + 0.0667 * thetaS + 0.26688);
  const cosS = Math.cos(thetaS);
  const nY = perez(1, thetaS, cosS, cY), nx = perez(1, thetaS, cosS, cx), ny = perez(1, thetaS, cosS, cy);

  const cloud = Math.min(Math.max(d.cloudiness, 0), 1);
  // Twilight: fade the clear sky as the sun sinks below the horizon.
  const dusk = Math.min(Math.max((d.sunElevation + 0.1) / 0.2, 0), 1);
  // Direct sun: 100 klx above the atmosphere, attenuated per channel along the air mass.
  const elDeg = (Math.max(d.sunElevation, 0) * 180) / Math.PI;
  const airMass = 1 / (Math.sin(Math.max(d.sunElevation, 0)) + 0.15 * (elDeg + 3.885) ** -1.253);
  const k = 0.6 + 0.2 * T;
  const direct = (1 - cloud) ** 2 * d.sunBrightness * 100 * Math.min(Math.max(d.sunElevation / 0.03, 0), 1);
  const sunIrradiance: Vec3 = [
    direct * Math.exp(-0.117 * k * airMass), direct * Math.exp(-0.163 * k * airMass), direct * Math.exp(-0.288 * k * airMass),
  ];
  // Overcast: 13 klx on the horizontal at full cover, scaled with the sun's height.
  const overcastZenith = ((9 * 13) / (7 * Math.PI)) * (0.25 + 0.75 * Math.sin(Math.max(d.sunElevation, 0.05)));
  const horizE = sunIrradiance[1] * Math.sin(Math.max(d.sunElevation, 0)) + (1 - cloud) * Yz * 2.2 * dusk + cloud * 13;
  const ground: Vec3 = [(d.groundAlbedo * horizE) / Math.PI * 1.02, (d.groundAlbedo * horizE) / Math.PI, (d.groundAlbedo * horizE) / Math.PI * 0.94];

  const skyAt = (dir: Vec3): Vec3 => {
    const cosT = Math.max(dir[1], 0);
    const cg = Math.min(Math.max(dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2], -1), 1);
    const g = Math.acos(cg);
    let rgb: Vec3 = [0, 0, 0];
    if (up && cloud < 1) {
      const Y = (Yz * perez(cosT, g, cg, cY)) / nY;
      const x = (xz * perez(cosT, g, cg, cx)) / nx;
      const y = (yz * perez(cosT, g, cg, cy)) / ny;
      rgb = xyYToRgb(x, y, Math.min(Y, 60));
      rgb = [Math.max(rgb[0], 0) * dusk, Math.max(rgb[1], 0) * dusk, Math.max(rgb[2], 0) * dusk];
    }
    const oc = (overcastZenith * (1 + 2 * cosT)) / 3;
    return [
      (rgb[0] * (1 - cloud) + oc * 0.96 * cloud) * d.skyTint[0] * d.skyBrightness,
      (rgb[1] * (1 - cloud) + oc * 0.985 * cloud) * d.skyTint[1] * d.skyBrightness,
      (rgb[2] * (1 - cloud) + oc * 1.0 * cloud) * d.skyTint[2] * d.skyBrightness,
    ];
  };

  for (let j = 0; j < SKY_H; j++) {
    const theta = ((j + 0.5) / SKY_H) * Math.PI;
    const st = Math.sin(theta), ct = Math.cos(theta);
    for (let i = 0; i < SKY_W; i++) {
      const phi = ((i + 0.5) / SKY_W - 0.5) * 2 * Math.PI;
      const dir: Vec3 = [st * Math.cos(phi), ct, st * Math.sin(phi)];
      let c: Vec3;
      if (ct >= 0) {
        c = skyAt(dir);
      } else {
        // Below the horizon: haze just under it, the lit ground further down.
        const hz = skyAt([dir[0], 0.02, dir[2]]);
        const m = Math.min(-ct / 0.12, 1);
        const s = m * m * (3 - 2 * m);
        c = [hz[0] * (1 - s) + ground[0] * s * d.skyBrightness, hz[1] * (1 - s) + ground[1] * s * d.skyBrightness, hz[2] * (1 - s) + ground[2] * s * d.skyBrightness];
      }
      texels.set([c[0], c[1], c[2], 1], (j * SKY_W + i) * 4);
    }
  }
  return {
    texels, sunDir: sun, sunIrradiance,
    sunTan: Math.tan(((0.27 + 4 * cloud) * Math.PI) / 180),
    sunEnabled: direct > 1e-3,
  };
}
