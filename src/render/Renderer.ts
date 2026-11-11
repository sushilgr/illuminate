// Frame graph around the GI system:
//   1  G-buffer            three.js raster, opaque meshes: base colour, normal + roughness, emission + metalness, depth
//   2  solve + lighting    WGSL compute (GISystem): cascades, caustics, deferred final gather -> lit HDR image
//   3  glass layer         raster of glass normals, then compute: reflection + frost scatter
//   4  optics              raster: lit image copied (with mips) and glass drawn over it, refracting it
//   5  finish              one display transform: exposure, white balance, bloom, tone map, grade, grain, vignette, FXAA
//   6  overlays            editor gizmos, straight to the canvas (never in captures)
// Everything up to the finish is linear HDR.
import * as THREE from 'three/webgpu';
import {
  float, hash, mix, mrt, normalWorld, output, renderOutput, saturation, screenCoordinate, screenUV, smoothstep, step,
  texture, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import type { GBuffer, GISystem, ViewState } from '../gi/GISystem';
import { kelvin } from '../scene/color';
import type { Atmosphere, Finish } from '../scene/types';
import type { OpticsShared } from './optics';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any;

const TONE: Record<Finish['toneMap'], THREE.ToneMapping> = {
  agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, aces: THREE.ACESFilmicToneMapping, linear: THREE.LinearToneMapping,
};

interface Backend { device: GPUDevice; get(o: unknown): { texture?: GPUTexture }; isWebGPUBackend?: boolean }

export class Renderer {
  readonly device: GPUDevice;
  readonly shared: OpticsShared;
  width = 4;
  height = 4;
  /** 0 full result, 1 direct / full comparison. */
  compare = false;
  /** Screen x of the comparison divider, 0..1. */
  readonly split = uniform(0.5);
  frameIndex = 0;
  /** Include editor overlays in offscreen captures (used when recording the interface). */
  captureOverlay = false;

  private readonly backend: Backend;
  private readonly gbuffer: THREE.RenderTarget;
  private readonly gbufferMRT: Node;
  private readonly glassTarget: THREE.RenderTarget;
  private readonly glassMRT: Node;
  private readonly background: THREE.RenderTarget;
  private readonly hdr: THREE.RenderTarget;
  /** Editor overlays (selection frame, brush cursor), composited in the display transform. */
  private readonly overlayTarget: THREE.RenderTarget;
  private readonly clearColor = new THREE.Color();
  private lit: THREE.StorageTexture;
  private litDirect: THREE.StorageTexture;
  private reflection: THREE.StorageTexture;
  private scatter: THREE.StorageTexture;
  private readonly copyQuad: THREE.QuadMesh;
  private readonly copyMaterial: THREE.MeshBasicNodeMaterial;
  private readonly litNode: Node;
  private readonly litDirectNode: Node;
  private readonly pipeline: THREE.RenderPipeline;
  private captureTarget: THREE.RenderTarget | null = null;
  private readonly u = {
    exposure: uniform(1), white: uniform(new THREE.Vector3(1, 1, 1)), bloom: uniform(0.1), rolloff: uniform(1),
    contrast: uniform(1), saturation: uniform(1), grain: uniform(0.02), vignette: uniform(0.05), frame: uniform(0),
    compare: uniform(0), overlay: uniform(0),
  };
  private toneMap: Finish['toneMap'] = 'agx';
  private readonly invViewProj = new THREE.Matrix4();
  private readonly viewProj = new THREE.Matrix4();
  private readonly forward = new THREE.Vector3();

  constructor(readonly three: THREE.WebGPURenderer, readonly gi: GISystem) {
    this.backend = three.backend as unknown as Backend;
    this.device = this.backend.device;
    three.toneMapping = THREE.NoToneMapping;

    this.gbuffer = new THREE.RenderTarget(4, 4, { count: 3, type: THREE.HalfFloatType, depthBuffer: true });
    this.gbuffer.textures[0].name = 'output';
    this.gbuffer.textures[1].name = 'normal';
    this.gbuffer.textures[2].name = 'emissive';
    for (const t of this.gbuffer.textures) { t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; }
    this.gbuffer.depthTexture = new THREE.DepthTexture(4, 4);
    this.gbuffer.depthTexture.type = THREE.FloatType;
    this.gbufferMRT = mrt({ output, normal: vec4(normalWorld, 1), emissive: vec4(0, 0, 0, 0) });

    this.glassTarget = new THREE.RenderTarget(4, 4, { count: 2, type: THREE.HalfFloatType, depthBuffer: true });
    this.glassTarget.textures[0].name = 'output';
    this.glassTarget.textures[1].name = 'aux';
    for (const t of this.glassTarget.textures) { t.minFilter = THREE.NearestFilter; t.magFilter = THREE.NearestFilter; t.generateMipmaps = false; }
    this.glassTarget.depthTexture = new THREE.DepthTexture(4, 4);
    this.glassTarget.depthTexture.type = THREE.FloatType;
    this.glassMRT = mrt({ output, aux: vec4(0, 0, 0, 0) });

    this.background = new THREE.RenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    this.background.texture.generateMipmaps = true;
    this.background.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.background.texture.magFilter = THREE.LinearFilter;
    this.hdr = new THREE.RenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true });
    this.hdr.texture.generateMipmaps = false;
    this.overlayTarget = new THREE.RenderTarget(4, 4, { type: THREE.UnsignedByteType, depthBuffer: false, samples: 4 });
    this.overlayTarget.texture.generateMipmaps = false;

    this.lit = this.storage(4, 4);
    this.litDirect = this.storage(4, 4);
    this.reflection = this.storage(4, 4);
    this.scatter = this.storage(4, 4);

    this.shared = {
      background: this.background.texture, opaqueDepth: this.gbuffer.depthTexture, reflection: this.reflection, scatter: this.scatter,
      invViewProj: this.invViewProj, viewProj: this.viewProj, cameraPosition: new THREE.Vector3(), cameraForward: this.forward,
      view: new THREE.Vector2(0, 720),
    };

    // The lit image, optionally split against the direct-only image for the comparison view.
    this.litNode = texture(this.lit, screenUV);
    this.litDirectNode = texture(this.litDirect, screenUV);
    this.copyMaterial = new THREE.MeshBasicNodeMaterial();
    this.copyMaterial.colorNode = vec4(mix(this.litNode.rgb, this.litDirectNode.rgb, step(screenUV.x, this.split).mul(this.u.compare)), this.litNode.a);
    // Alpha marks the cutaway surround; NoBlending keeps it instead of forcing it to 1.
    this.copyMaterial.blending = THREE.NoBlending;
    this.copyMaterial.depthTest = false;
    this.copyMaterial.depthWrite = false;
    this.copyQuad = new THREE.QuadMesh(this.copyMaterial);

    this.pipeline = new THREE.RenderPipeline(three);
    this.pipeline.outputColorTransform = false;
    this.buildFinish();
  }

  private storage(w: number, h: number): THREE.StorageTexture {
    const t = new THREE.StorageTexture(w, h);
    t.type = THREE.HalfFloatType;
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    this.three.initTexture(t);
    return t;
  }

  /** The display transform. Rebuilt only when the tone-mapping operator changes. */
  private buildFinish() {
    const u = this.u;
    const hdr = texture(this.hdr.texture, screenUV);
    let c: Node = hdr.rgb.mul(u.white).mul(u.exposure);
    // Bloom sees a compressed copy of the image: a source a thousand times brighter than white glows,
    // but cannot flood the frame.
    const glow = c.div(c.dot(vec3(0.2126, 0.7152, 0.0722)).div(12).add(1));
    c = c.add(bloom(vec4(glow, 1), 1, 0.6, 1.1).rgb.mul(u.bloom));
    // Tone map, then blend back towards a plain clip for a shorter highlight shoulder.
    const mapped = renderOutput(vec4(c, 1), TONE[this.toneMap], THREE.SRGBColorSpace).rgb;
    const clipped = renderOutput(vec4(c.min(1), 1), THREE.NoToneMapping, THREE.SRGBColorSpace).rgb;
    let d: Node = mix(clipped, mapped, u.rolloff);
    d = saturation(d, u.saturation);
    d = d.sub(0.5).mul(u.contrast).add(0.5).clamp(0, 1);
    let out: Node = (fxaa(vec4(d, 1)) as Node).rgb;
    const r = screenUV.sub(0.5).mul(vec2(1.25, 1)).length();
    out = out.mul(float(1).sub(u.vignette.mul(smoothstep(0.35, 0.95, r))));
    const n = hash(screenCoordinate.x.add(screenCoordinate.y.mul(1973)).add(u.frame.mul(9277))).sub(0.5);
    out = out.add(n.mul(u.grain).mul(float(1).sub(out.dot(vec3(0.3, 0.6, 0.1)).mul(0.6))));
    // The cutaway surround (alpha 0 in the lit image) shows the page colour.
    const paper = vec3(0.937, 0.922, 0.894);
    const framed = mix(paper, out, hdr.a);
    // Overlays are drawn into their own target (premultiplied, linear) and laid over the finished image.
    const ov = texture(this.overlayTarget.texture, screenUV);
    const oa = ov.a.mul(u.overlay);
    const lines = ov.rgb.div(ov.a.max(1e-4)).pow(1 / 2.2);
    this.pipeline.outputNode = vec4(mix(framed, lines, oa), 1);
    this.pipeline.needsUpdate = true;
  }

  setFinish(f: Finish, exposureStops: number) {
    const u = this.u;
    u.exposure.value = 2 ** exposureStops;
    // White balance: divide by the colour of the chosen white point, then a green-magenta shift.
    const w = kelvin(f.whiteBalance);
    const g = 1 + 0.25 * f.tint;
    const m = Math.max(1 / w[0], g / w[1], 1 / w[2]);
    (u.white.value as THREE.Vector3).set(1 / w[0] / m, g / w[1] / m, 1 / w[2] / m);
    u.bloom.value = f.bloom;
    u.rolloff.value = f.rolloff;
    u.contrast.value = f.contrast;
    u.saturation.value = f.saturation;
    u.grain.value = f.grain;
    u.vignette.value = f.vignette;
    if (f.toneMap !== this.toneMap) { this.toneMap = f.toneMap; this.buildFinish(); }
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.gbuffer.setSize(width, height);
    this.glassTarget.setSize(width, height);
    this.background.setSize(width, height);
    this.hdr.setSize(width, height);
    this.overlayTarget.setSize(width, height);
    this.captureTarget?.setSize(width, height);
    for (const t of [this.lit, this.litDirect, this.reflection, this.scatter]) t.dispose();
    this.lit = this.storage(width, height);
    this.litDirect = this.storage(width, height);
    this.reflection = this.storage(width, height);
    this.scatter = this.storage(width, height);
    this.litNode.value = this.lit;
    this.litDirectNode.value = this.litDirect;
    this.shared.reflection = this.reflection;
    this.shared.scatter = this.scatter;
    this.onResize?.();
  }
  /** Glass materials hold references to the screen-sized textures and re-read them here. */
  onResize?: () => void;

  private gpu(t: THREE.Texture): GPUTexture { return this.backend.get(t).texture!; }

  /** Renders one frame. `overlay` is drawn on top of the finished image, on screen only. */
  render(
    opaque: THREE.Object3D, glassLayer: THREE.Object3D, glass: THREE.Object3D, hasGlass: boolean,
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, atmosphere: Atmosphere,
    overlay: THREE.Scene | null, toCapture = false,
  ) {
    const three = this.three;
    const { width, height } = this;
    this.frameIndex++;
    this.u.frame.value = this.frameIndex % 1024;
    this.u.compare.value = this.compare ? 1 : 0;

    // 1. G-buffer.
    three.setMRT(this.gbufferMRT);
    three.setRenderTarget(this.gbuffer);
    three.render(opaque as THREE.Scene, camera);

    // Camera state shared by compute and the glass materials.
    camera.updateMatrixWorld();
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.invViewProj.copy(this.viewProj).invert();
    camera.getWorldDirection(this.forward);
    this.shared.cameraPosition.copy(camera.position);
    const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera === true;
    this.shared.view.set(ortho ? 1 : 0, height);
    let pixelMeasure: number;
    if (ortho) {
      const o = camera as THREE.OrthographicCamera;
      pixelMeasure = ((o.right - o.left) / o.zoom / width) * ((o.top - o.bottom) / o.zoom / height);
    } else {
      const p = camera as THREE.PerspectiveCamera;
      const tanV = Math.tan((p.fov * Math.PI) / 360);
      pixelMeasure = ((2 * tanV) / height) ** 2;
    }
    const view: ViewState = {
      viewProj: this.viewProj.elements, invViewProj: this.invViewProj.elements,
      position: [camera.position.x, camera.position.y, camera.position.z],
      forward: [this.forward.x, this.forward.y, this.forward.z], orthographic: ortho, pixelMeasure, width, height,
      hazeTint: atmosphere.tint, hazeAnisotropy: atmosphere.anisotropy,
    };
    const gb: GBuffer = {
      albedo: this.gpu(this.gbuffer.textures[0]), normal: this.gpu(this.gbuffer.textures[1]),
      emissive: this.gpu(this.gbuffer.textures[2]), depth: this.gpu(this.gbuffer.depthTexture!),
    };

    // 3a. Glass normals (rasterised before the compute submission so one encoder covers all GI work).
    if (hasGlass) {
      three.setMRT(this.glassMRT);
      three.setRenderTarget(this.glassTarget);
      three.render(glassLayer as THREE.Scene, camera);
    }
    three.setMRT(null);

    // 2 + 3b. Compute.
    const gi = this.gi;
    gi.hazeExtinction = atmosphere.haze;
    const encoder = this.device.createCommandEncoder({ label: 'illuminate.gi' });
    gi.timer.begin();
    gi.solve(encoder);
    gi.light(encoder, gb, this.gpu(this.lit), view, false);
    if (this.compare) {
      gi.solveDirect(encoder);
      gi.light(encoder, gb, this.gpu(this.litDirect), view, true);
    }
    if (hasGlass) {
      gi.lightGlass(encoder, {
        normal: this.gpu(this.glassTarget.textures[0]), aux: this.gpu(this.glassTarget.textures[1]), depth: this.gpu(this.glassTarget.depthTexture!),
      }, gb.depth, this.gpu(this.reflection), this.gpu(this.scatter), width, height);
    }
    gi.timer.resolve(encoder);
    this.device.queue.submit([encoder.finish()]);
    gi.timer.collect();

    // 4. Optics: the lit image, then glass over it.
    if (hasGlass) {
      three.setRenderTarget(this.background);
      this.copyQuad.render(three);
    }
    three.setRenderTarget(this.hdr);
    this.copyQuad.render(three);
    if (hasGlass) {
      const auto = three.autoClear;
      three.autoClear = false;
      three.clearDepth();
      three.render(glass as THREE.Scene, camera);
      three.autoClear = auto;
    }

    // 5. Finish.
    if (toCapture && this.captureTarget) {
      this.u.overlay.value = overlay && overlay.visible ? 1 : 0;
      if (overlay && overlay.visible) this.drawOverlay(overlay, camera);
      three.setRenderTarget(this.captureTarget);
      this.pipeline.render();
      three.setRenderTarget(null);
      return;
    }
    // Overlays go into their own target first: drawing a second scene straight onto the canvas
    // would replace the finished image, because the renderer resolves each canvas render through
    // an intermediate buffer.
    this.u.overlay.value = overlay && overlay.visible ? 1 : 0;
    if (overlay && overlay.visible) this.drawOverlay(overlay, camera);
    three.setRenderTarget(null);
    this.pipeline.render();
  }

  private drawOverlay(overlay: THREE.Scene, camera: THREE.Camera) {
    const three = this.three;
    const alpha = three.getClearAlpha();
    three.getClearColor(this.clearColor);
    three.setClearColor(0x000000, 0);
    three.setRenderTarget(this.overlayTarget);
    three.render(overlay, camera);
    three.setClearColor(this.clearColor, alpha);
  }

  /** Allocates the read-back target used by still and loop capture and by headless checks. */
  enableCapture() {
    if (!this.captureTarget) this.captureTarget = new THREE.RenderTarget(this.width, this.height, { type: THREE.UnsignedByteType, depthBuffer: false });
  }

  /** Reads the last captured frame as top-down RGBA bytes. */
  async readCapture(): Promise<ImageData> {
    const { width, height } = this;
    const px = await this.three.readRenderTargetPixelsAsync(this.captureTarget!, 0, 0, width, height);
    const src = new Uint8Array(px.buffer, px.byteOffset, px.byteLength);
    const img = new ImageData(width, height);
    const rowBytes = src.length / height;
    for (let y = 0; y < height; y++) img.data.set(src.subarray(y * rowBytes, y * rowBytes + width * 4), y * width * 4);
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    return img;
  }

  dispose() {
    for (const t of [this.gbuffer, this.glassTarget, this.background, this.hdr, this.overlayTarget, this.captureTarget]) t?.dispose();
    for (const t of [this.lit, this.litDirect, this.reflection, this.scatter]) t.dispose();
    this.pipeline.dispose();
  }
}
