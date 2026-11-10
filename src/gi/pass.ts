// Small helpers for explicitly owned WebGPU compute passes.
// Each pass declares its resources by name; WGSL declarations and the bind group layout
// are generated from that list so shader and layout cannot drift apart.

export type BindKind =
  | 'uniform' | 'storage' | 'sampler'
  | 'tex3d' | 'tex2d' | 'depth2d'
  | 'store3d' | 'store2d';

export interface BindDecl {
  name: string;
  kind: BindKind;
  /** WGSL type for uniform / storage bindings. */
  type?: string;
  format?: GPUTextureFormat;
}

function declare(d: BindDecl, i: number): string {
  const at = `@group(0) @binding(${i})`;
  const fmt = d.format ?? 'rgba16float';
  switch (d.kind) {
    case 'uniform': return `${at} var<uniform> ${d.name}: ${d.type};`;
    case 'storage': return `${at} var<storage, read> ${d.name}: array<${d.type}>;`;
    case 'sampler': return `${at} var ${d.name}: sampler;`;
    case 'tex3d': return `${at} var ${d.name}: texture_3d<f32>;`;
    case 'tex2d': return `${at} var ${d.name}: texture_2d<f32>;`;
    case 'depth2d': return `${at} var ${d.name}: texture_depth_2d;`;
    case 'store3d': return `${at} var ${d.name}: texture_storage_3d<${fmt}, write>;`;
    case 'store2d': return `${at} var ${d.name}: texture_storage_2d<${fmt}, write>;`;
  }
}

function layoutEntry(d: BindDecl, i: number): GPUBindGroupLayoutEntry {
  const base = { binding: i, visibility: GPUShaderStage.COMPUTE };
  const fmt = d.format ?? 'rgba16float';
  switch (d.kind) {
    case 'uniform': return { ...base, buffer: { type: 'uniform' } };
    case 'storage': return { ...base, buffer: { type: 'read-only-storage' } };
    case 'sampler': return { ...base, sampler: { type: 'filtering' } };
    case 'tex3d': return { ...base, texture: { sampleType: 'float', viewDimension: '3d' } };
    case 'tex2d': return { ...base, texture: { sampleType: 'float', viewDimension: '2d' } };
    case 'depth2d': return { ...base, texture: { sampleType: 'depth', viewDimension: '2d' } };
    case 'store3d': return { ...base, storageTexture: { access: 'write-only', format: fmt, viewDimension: '3d' } };
    case 'store2d': return { ...base, storageTexture: { access: 'write-only', format: fmt, viewDimension: '2d' } };
  }
}

export class ComputePass {
  readonly pipeline: GPUComputePipeline;
  readonly layout: GPUBindGroupLayout;
  private readonly decls: BindDecl[];

  constructor(
    private readonly device: GPUDevice,
    readonly label: string,
    decls: BindDecl[],
    /** WGSL source chunks. Module-scope declarations are order independent in WGSL. */
    chunks: string[],
  ) {
    this.decls = decls;
    const bindings = decls.map(declare).join('\n');
    const code = [bindings, ...chunks].join('\n\n');
    const module = device.createShaderModule({ label, code });
    module.getCompilationInfo().then((info) => {
      for (const m of info.messages) {
        if (m.type === 'error') console.error(`[wgsl:${label}] ${m.lineNum}:${m.linePos} ${m.message}`);
      }
    });
    this.layout = device.createBindGroupLayout({ label, entries: decls.map(layoutEntry) });
    this.pipeline = device.createComputePipeline({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
      compute: { module, entryPoint: 'main' },
    });
  }

  bind(resources: Record<string, GPUBindingResource>): GPUBindGroup {
    return this.device.createBindGroup({
      label: this.label,
      layout: this.layout,
      entries: this.decls.map((d, i) => {
        const r = resources[d.name];
        if (!r) throw new Error(`Pass "${this.label}" is missing resource "${d.name}"`);
        return { binding: i, resource: r };
      }),
    });
  }
}

/** GPU pass timing via timestamp queries, read back asynchronously (never blocks a frame). */
export class GpuTimer {
  readonly supported: boolean;
  readonly results = new Map<string, number>();
  private querySet?: GPUQuerySet;
  private resolveBuf?: GPUBuffer;
  private readBuf?: GPUBuffer;
  private labels: string[] = [];
  private pendingLabels: string[] = [];
  private busy = false;
  private readonly capacity = 64;

  constructor(private readonly device: GPUDevice) {
    this.supported = device.features.has('timestamp-query');
    if (!this.supported) return;
    this.querySet = device.createQuerySet({ type: 'timestamp', count: this.capacity * 2 });
    this.resolveBuf = device.createBuffer({
      size: this.capacity * 16,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readBuf = device.createBuffer({
      size: this.capacity * 16,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  begin() { this.labels = []; }

  /** Returns timestampWrites for a pass, or undefined when unsupported or busy. */
  writes(label: string): GPUComputePassTimestampWrites | undefined {
    if (!this.supported || this.busy || this.labels.length >= this.capacity) return undefined;
    const i = this.labels.length;
    this.labels.push(label);
    return { querySet: this.querySet!, beginningOfPassWriteIndex: i * 2, endOfPassWriteIndex: i * 2 + 1 };
  }

  resolve(encoder: GPUCommandEncoder) {
    if (!this.supported || this.busy || this.labels.length === 0) return;
    const n = this.labels.length;
    encoder.resolveQuerySet(this.querySet!, 0, n * 2, this.resolveBuf!, 0);
    encoder.copyBufferToBuffer(this.resolveBuf!, 0, this.readBuf!, 0, n * 16);
    this.pendingLabels = this.labels.slice();
    this.busy = true;
  }

  /** Call after the encoder that carried resolve() has been submitted. */
  collect() {
    if (!this.busy || this.readBuf!.mapState !== 'unmapped') return;
    const labels = this.pendingLabels;
    this.readBuf!.mapAsync(GPUMapMode.READ, 0, labels.length * 16).then(() => {
      const t = new BigInt64Array(this.readBuf!.getMappedRange(0, labels.length * 16));
      const sums = new Map<string, number>();
      for (let i = 0; i < labels.length; i++) {
        const ms = Number(t[i * 2 + 1] - t[i * 2]) / 1e6;
        if (ms >= 0 && ms < 1e4) sums.set(labels[i], (sums.get(labels[i]) ?? 0) + ms);
      }
      for (const [k, v] of sums) {
        const prev = this.results.get(k);
        this.results.set(k, prev === undefined ? v : prev * 0.9 + v * 0.1);
      }
      this.readBuf!.unmap();
      this.busy = false;
    }).catch(() => { this.busy = false; });
  }

  total(prefix = ''): number {
    let s = 0;
    for (const [k, v] of this.results) if (k.startsWith(prefix)) s += v;
    return s;
  }
}
