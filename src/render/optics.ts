// Glass materials for the forward optics pass.
//
// Each glass object is drawn twice. First into a small G-buffer (world normal with fluting,
// frost after etching, Fresnel F0), which the compute pass lights: cone-traced reflection and
// frost scatter. Then into the HDR image, where this material bends the view ray through the
// object's analytic shape and reads the already-lit opaque scene behind it:
//   radiance = refracted background * absorption * (1 - F) * (1 - scattered share) + reflection + scatter
// The background is the lit opaque image with a mip chain; frost selects a blurrier mip in
// proportion to the distance to what lies behind, so the view softens coherently.
import * as THREE from 'three/webgpu';
import {
  Discard, Fn, abs, clamp, dot, exp, float, length, max, mix, modelWorldMatrix, mrt, normalLocal, normalize, positionLocal,
  positionWorld, reflect, refract, screenUV, select, sin, texture, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import type { GlassObject } from '../scene/types';

// TSL graphs are assembled dynamically per shape; their node types are checked by three at build time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

export interface OpticsShared {
  /** Lit opaque image with mips. */
  background: THREE.Texture;
  opaqueDepth: THREE.DepthTexture;
  reflection: THREE.Texture;
  scatter: THREE.Texture;
  invViewProj: THREE.Matrix4;
  viewProj: THREE.Matrix4;
  cameraPosition: THREE.Vector3;
  cameraForward: THREE.Vector3;
  /** x = 1 for an orthographic camera, y = render height in pixels. */
  view: THREE.Vector2;
}

export interface GlassMaterials {
  gbuffer: THREE.NodeMaterial;
  composite: THREE.NodeMaterial;
  update(o: GlassObject): void;
  setEtch(mask: Uint8Array | null): void;
  /** Re-reads the screen-sized textures after a resize. */
  refresh(): void;
  dispose(): void;
}

const ETCH = 64;

export function createGlassMaterials(shared: OpticsShared, o: GlassObject): GlassMaterials {
  const u = {
    ior: uniform(o.ior),
    sigma: uniform(new THREE.Vector3()),
    frost: uniform(o.frost),
    flute: uniform(new THREE.Vector2(o.fluteDepth, o.fluteSpacing)),
    dispersion: uniform(o.dispersion),
    size: uniform(new THREE.Vector3(...o.size)),
    centre: uniform(new THREE.Vector3()),
    etched: uniform(0),
  };
  const sh = {
    invViewProj: uniform(shared.invViewProj),
    viewProj: uniform(shared.viewProj),
    camPos: uniform(shared.cameraPosition),
    camFwd: uniform(shared.cameraForward),
    view: uniform(shared.view),
  };
  const etchData = new Uint8Array(ETCH * ETCH * 4);
  const etchTex = new THREE.DataTexture(etchData, ETCH, ETCH, THREE.RGBAFormat);
  etchTex.magFilter = THREE.LinearFilter;
  etchTex.minFilter = THREE.LinearFilter;
  etchTex.needsUpdate = true;

  const shape = o.shape;
  const axis = (x: number, y: number, z: number) => normalize(modelWorldMatrix.mul(vec4(x, y, z, 0)).xyz);

  // Surface normal in world space. Fluting: parallel grooves along Y on a slab's +Z face.
  const normalNode = Fn(() => {
    const ph = positionLocal.x.mul(float(2 * Math.PI).div(u.flute.y));
    const fl = normalize(vec3(u.flute.x.mul(Math.PI).div(u.flute.y).mul(sin(ph)), 0, 1));
    const fluted = shape === 'slab' ? u.flute.x.greaterThan(0).and(normalLocal.z.greaterThan(0.5)) : float(0).greaterThan(1);
    const nl = select(fluted, fl, normalLocal);
    return normalize(modelWorldMatrix.mul(vec4(nl, 0)).xyz);
  });

  // Frost after etching (slab only): the mask removes frost where it was brushed.
  const frostNode = Fn(() => {
    const uv = vec2(positionLocal.x.div(u.size.x).add(0.5), float(0.5).sub(positionLocal.y.div(u.size.y)));
    const mask = texture(etchTex, uv).r.mul(u.etched);
    return u.frost.mul(float(1).sub(mask));
  });

  const gbuffer = new THREE.MeshBasicNodeMaterial();
  gbuffer.colorNode = vec4(normalNode(), frostNode());
  const f0 = u.ior.sub(1).div(u.ior.add(1)).pow(2);
  gbuffer.mrtNode = mrt({ aux: vec4(f0, 1, 0, 1) });
  gbuffer.side = THREE.FrontSide;
  // Opaque node materials force alpha to 1; the frost amount travels in alpha, so write it unblended.
  gbuffer.blending = THREE.NoBlending;

  const reflNode: Node = texture(shared.reflection, screenUV);
  const scatNode: Node = texture(shared.scatter, screenUV);
  const composite = new THREE.MeshBasicNodeMaterial();
  composite.colorNode = Fn(() => {
    const P = positionWorld;
    const fwd = sh.camFwd;
    const V = select(sh.view.x.greaterThan(0.5), fwd, normalize(P.sub(sh.camPos)));
    const N0 = normalNode();
    const N = select(dot(N0, V).greaterThan(0), N0.negate(), N0);
    const Ng0 = normalize(modelWorldMatrix.mul(vec4(normalLocal, 0)).xyz);
    const Ng = select(dot(Ng0, V).greaterThan(0), Ng0.negate(), Ng0);

    // Hidden behind the opaque scene?
    const worldAt = (uv: Node, depth: Node) => {
      const w = sh.invViewProj.mul(vec4(uv.x.mul(2).sub(1), float(1).sub(uv.y.mul(2)), depth, 1));
      return w.xyz.div(w.w);
    };
    const zf = dot(P.sub(sh.camPos), fwd);
    const zo = dot(worldAt(screenUV, texture(shared.opaqueDepth, screenUV).r).sub(sh.camPos), fwd);
    Discard(zf.greaterThan(zo.add(0.004)));

    // Refraction through the shape, per colour channel for dispersion.
    const bend = (ior: Node) => {
      const T1 = refract(V, N, float(1).div(ior));
      let T2: Node, len: Node;
      if (shape === 'slab') {
        len = u.size.z.div(max(abs(dot(T1, Ng)), 0.25));
        T2 = refract(T1, Ng, ior);
      } else if (shape === 'lens') {
        // Thin-lens deflection towards the axis; thickness falls off towards the rim.
        const az = axis(0, 0, 1);
        const rel = P.sub(u.centre);
        const r = rel.sub(az.mul(dot(rel, az)));
        const a = u.size.x.mul(0.5), s = u.size.z.mul(0.5);
        const R = a.mul(a).add(s.mul(s)).div(s.mul(2));
        const f = R.div(ior.sub(1).mul(2));
        T2 = normalize(V.sub(r.div(f)));
        len = u.size.z.mul(max(float(1).sub(dot(r, r).div(a.mul(a))), 0));
      } else if (shape === 'rod') {
        const ay = axis(0, 1, 0);
        const along = dot(T1, ay);
        const t = normalize(T1.sub(ay.mul(along)));
        const nOut = reflect(Ng, t);
        T2 = refract(T1, nOut.negate(), ior);
        len = u.size.x.mul(abs(dot(Ng, t))).div(max(float(1).sub(along.mul(along)).sqrt(), 0.3));
      } else {
        // Prism: leave through whichever of the other two side faces the ray heads for.
        const ax = axis(1, 0, 0), az = axis(0, 0, 1);
        const k = Math.sqrt(3) / 2;
        const faces = [az.negate(), ax.mul(k).add(az.mul(0.5)), ax.mul(-k).add(az.mul(0.5))];
        let best: Node = faces[0], bestDot: Node = float(-2);
        for (const fc of faces) {
          const d = select(dot(fc, Ng0).greaterThan(0.9), float(-2), dot(T1, fc));
          best = select(d.greaterThan(bestDot), fc, best);
          bestDot = max(d, bestDot);
        }
        T2 = refract(T1, best.negate(), ior);
        len = u.size.x.mul(0.5);
      }
      // Total internal reflection: carry straight on.
      T2 = select(dot(T2, T2).lessThan(0.5), T1, T2);
      const behind = max(zo.sub(zf), 0.02);
      const Pb = P.add(T1.mul(len)).add(T2.mul(behind.div(max(dot(T2, fwd), 0.3))));
      const clip = sh.viewProj.mul(vec4(Pb, 1));
      const uv = clip.xy.div(clip.w).mul(vec2(0.5, -0.5)).add(0.5);
      // Do not read something that stands in front of the glass.
      const zb = dot(worldAt(uv, texture(shared.opaqueDepth, uv).r).sub(sh.camPos), fwd);
      const ok = zb.greaterThan(zf.sub(0.01)).and(uv.x.greaterThan(0)).and(uv.x.lessThan(1)).and(uv.y.greaterThan(0)).and(uv.y.lessThan(1));
      return { uv: select(ok, uv, screenUV), len, behind };
    };
    const g = bend(u.ior);
    const spread = u.dispersion.mul(0.03);
    const r = bend(u.ior.sub(spread));
    const b = bend(u.ior.add(spread));

    // Frost blur: a higher mip of the background, four taps to hide its texels.
    const frost = shape === 'slab' ? frostNode() : u.frost;
    const lod = frost.mul(float(1.5).add(clamp(g.behind, 0, 2).mul(3))).add(frost.mul(sh.view.y.div(720).log2()));
    const texel = float(2).pow(lod).div(sh.view.y).mul(0.6);
    const tap = (uv: Node) => {
      const a = texture(shared.background, uv.add(vec2(texel, texel.mul(0.4))), lod).rgb;
      const c = texture(shared.background, uv.add(vec2(texel.mul(-0.4), texel)), lod).rgb;
      const d = texture(shared.background, uv.add(vec2(texel.negate(), texel.mul(-0.4))), lod).rgb;
      const e = texture(shared.background, uv.add(vec2(texel.mul(0.4), texel.negate())), lod).rgb;
      return a.add(c).add(d).add(e).mul(0.25);
    };
    const bg = vec3(tap(r.uv).r, tap(g.uv).g, tap(b.uv).b);
    const absorb = exp(u.sigma.negate().mul(g.len));
    const refl = reflNode;
    const scat = scatNode.rgb;
    const through = float(1).sub(refl.a).mul(float(1).sub(frost.mul(0.75)));
    return vec4(mix(vec3(0), bg.mul(absorb), through).add(refl.rgb).add(scat), 1);
  })();
  composite.side = THREE.FrontSide;

  const update = (g: GlassObject) => {
    u.ior.value = g.ior;
    u.frost.value = g.frost;
    u.dispersion.value = g.dispersion;
    (u.flute.value as THREE.Vector2).set(g.shape === 'slab' ? g.fluteDepth : 0, Math.max(g.fluteSpacing, 0.005));
    (u.size.value as THREE.Vector3).set(g.size[0], g.size[1], g.size[2]);
    (u.centre.value as THREE.Vector3).set(g.position[0], g.position[1], g.position[2]);
    const k = 1 / Math.max(g.absorption, 1e-3);
    (u.sigma.value as THREE.Vector3).set(-Math.log(Math.max(g.tint[0], 1e-3)) * k, -Math.log(Math.max(g.tint[1], 1e-3)) * k, -Math.log(Math.max(g.tint[2], 1e-3)) * k);
  };
  update(o);

  return {
    gbuffer, composite, update,
    setEtch(mask) {
      u.etched.value = mask ? 1 : 0;
      if (mask) {
        for (let i = 0; i < ETCH * ETCH; i++) { etchData[i * 4] = mask[i]; etchData[i * 4 + 3] = 255; }
        etchTex.needsUpdate = true;
      }
    },
    refresh() { reflNode.value = shared.reflection; scatNode.value = shared.scatter; },
    dispose() { gbuffer.dispose(); composite.dispose(); etchTex.dispose(); },
  };
}
