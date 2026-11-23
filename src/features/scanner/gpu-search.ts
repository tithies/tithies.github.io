/**
 * The every-print search on the GPU (WebGPU, in the search worker): the index's rows sit in a storage buffer, one
 * dispatch scores up to 32 queries against every row, and the scores come back for the top 5 (index-file.ts:
 * topKFromScores). JavaScript does 0.3–0.6 billion multiply-adds a second: 1.3 s for 8 queries (4 cards, both ways
 * up) over 105,000 prints in Chrome; the GPU takes 34 ms for those, 124 ms for 32 queries (2026-11-23).
 *
 * Same arithmetic as searchVectorIndex (the CPU path, checked against the trainer): f32 rows, or int8 rows times
 * their scale (unpack4x8snorm gives int8 / 127). Sums run in float32 in another order: scores differ by about 1e-6.
 */
import type { VectorIndex } from './index-file';

/** Queries per dispatch (the shader's accumulators). */
export const MAX_QUERIES = 32;

// The few WebGPU types used here (TypeScript's lib has none; no dependency for them).
interface GpuBuffer {
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
}
interface GpuDevice {
  limits: Record<string, number>;
  queue: { writeBuffer(b: GpuBuffer, offset: number, data: ArrayBufferView | ArrayBuffer): void; submit(cmds: unknown[]): void };
  createBuffer(d: { size: number; usage: number; mappedAtCreation?: boolean }): GpuBuffer;
  createShaderModule(d: { code: string }): unknown;
  createComputePipeline(d: { layout: 'auto'; compute: { module: unknown; entryPoint: string } }): { getBindGroupLayout(i: number): unknown };
  createBindGroup(d: { layout: unknown; entries: { binding: number; resource: { buffer: GpuBuffer } }[] }): unknown;
  createCommandEncoder(): {
    beginComputePass(): { setPipeline(p: unknown): void; setBindGroup(i: number, g: unknown): void; dispatchWorkgroups(x: number, y?: number): void; end(): void };
    copyBufferToBuffer(a: GpuBuffer, ao: number, b: GpuBuffer, bo: number, size: number): void;
    finish(): unknown;
  };
  destroy(): void;
  lost: Promise<{ message: string }>;
}
interface GpuAdapter {
  limits: Record<string, number>;
  requestDevice(d?: { requiredLimits?: Record<string, number> }): Promise<GpuDevice>;
}

const USAGE = { MAP_READ: 0x1, COPY_SRC: 0x4, COPY_DST: 0x8, UNIFORM: 0x40, STORAGE: 0x80 };
const MAP_READ = 0x1;
const WORKGROUP = 64;

const shader = (i8: boolean) => /* wgsl */ `
struct P { m: u32, d4: u32, nq: u32, pad: u32 }
@group(0) @binding(0) var<uniform> p: P;
@group(0) @binding(1) var<storage, read> rows: array<${i8 ? 'u32' : 'vec4<f32>'}>;
@group(0) @binding(2) var<storage, read> scales: array<f32>;
@group(0) @binding(3) var<storage, read> queries: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> scores: array<f32>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(num_workgroups) nw: vec3<u32>) {
  let r = gid.x + gid.y * nw.x * ${WORKGROUP}u;
  if (r >= p.m) { return; }
  var acc: array<f32, ${MAX_QUERIES}>;
  let base = r * p.d4;
  for (var j = 0u; j < p.d4; j++) {
    let v = ${i8 ? 'unpack4x8snorm(rows[base + j])' : 'rows[base + j]'};
    for (var q = 0u; q < p.nq; q++) { acc[q] += dot(v, queries[q * p.d4 + j]); }
  }
  let s = ${i8 ? 'scales[r] * 127.0' : '1.0'};
  for (var q = 0u; q < p.nq; q++) { scores[q * p.m + r] = acc[q] * s; }
}`;

export class GpuSearch {
  private constructor(
    private readonly device: GpuDevice,
    private readonly pipeline: { getBindGroupLayout(i: number): unknown },
    private readonly bind: unknown,
    private readonly params: GpuBuffer,
    private readonly queries: GpuBuffer,
    private readonly scores: GpuBuffer,
    private readonly readback: GpuBuffer,
    private readonly owned: GpuBuffer[],
    readonly count: number,
    readonly dims: number,
  ) {}

  /** The index on the GPU, or null when there's no usable WebGPU (the CPU search is used then). */
  static async create(idx: VectorIndex): Promise<GpuSearch | null> {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<GpuAdapter | null> } }).gpu;
    if (!gpu || idx.dims % 4) return null;
    const adapter = await gpu.requestAdapter().catch(() => null);
    if (!adapter) return null;
    const rowBytes = idx.rows.byteLength;
    const scoreBytes = MAX_QUERIES * idx.count * 4;
    const need = Math.max(rowBytes, scoreBytes);
    if (need > adapter.limits.maxStorageBufferBindingSize || need > adapter.limits.maxBufferSize) return null;
    const device = await adapter.requestDevice({
      requiredLimits: { maxStorageBufferBindingSize: Math.max(need, 134217728), maxBufferSize: Math.max(need, 268435456) },
    });
    const i8 = idx.kind === 'i8';
    const buffer = (size: number, usage: number) => device.createBuffer({ size: Math.max(16, Math.ceil(size / 4) * 4), usage });
    const rows = buffer(rowBytes, USAGE.STORAGE | USAGE.COPY_DST);
    device.queue.writeBuffer(rows, 0, i8 ? new Uint8Array(idx.rows.buffer, idx.rows.byteOffset, idx.rows.byteLength) : idx.rows);
    const scales = buffer(i8 ? idx.count * 4 : 16, USAGE.STORAGE | USAGE.COPY_DST);
    if (i8 && idx.scales) device.queue.writeBuffer(scales, 0, idx.scales);
    const params = buffer(16, USAGE.UNIFORM | USAGE.COPY_DST);
    const queries = buffer(MAX_QUERIES * idx.dims * 4, USAGE.STORAGE | USAGE.COPY_DST);
    const scores = buffer(scoreBytes, USAGE.STORAGE | USAGE.COPY_SRC);
    const readback = buffer(scoreBytes, USAGE.MAP_READ | USAGE.COPY_DST);
    const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: shader(i8) }), entryPoint: 'main' } });
    const bind = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [params, rows, scales, queries, scores].map((b, i) => ({ binding: i, resource: { buffer: b } })),
    });
    return new GpuSearch(device, pipeline, bind, params, queries, scores, readback, [rows, scales, params, queries, scores, readback], idx.count, idx.dims);
  }

  /** Scores of up to 32 projected queries against every row: query q's row r at q × count + r. */
  async score(queries: readonly Float32Array[]): Promise<Float32Array> {
    const nq = queries.length;
    if (nq > MAX_QUERIES) throw new Error(`At most ${MAX_QUERIES} queries per call`);
    const flat = new Float32Array(nq * this.dims);
    queries.forEach((q, i) => flat.set(q, i * this.dims));
    const q = this.device.queue;
    q.writeBuffer(this.params, 0, new Uint32Array([this.count, this.dims / 4, nq, 0]));
    q.writeBuffer(this.queries, 0, flat);
    const enc = this.device.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bind);
    const groups = Math.ceil(this.count / WORKGROUP);
    const x = Math.min(groups, 65535);
    pass.dispatchWorkgroups(x, Math.ceil(groups / x));
    pass.end();
    const bytes = nq * this.count * 4;
    enc.copyBufferToBuffer(this.scores, 0, this.readback, 0, bytes);
    q.submit([enc.finish()]);
    await this.readback.mapAsync(MAP_READ);
    const out = new Float32Array(this.readback.getMappedRange().slice(0, bytes));
    this.readback.unmap();
    return out;
  }

  destroy() {
    for (const b of this.owned) b.destroy();
    this.device.destroy();
  }
}
