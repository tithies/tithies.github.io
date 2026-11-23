/**
 * The every-print search, as the search worker runs it (search.worker.ts): the index, the "only my prints" mask, and
 * the nearest rows for a batch of queries, on the GPU when WebGPU works (gpu-search.ts), else on the CPU
 * (index-file.ts: searchVectorIndex, the arithmetic the tests check against the trainer's).
 */
import { GpuSearch, MAX_QUERIES } from './gpu-search';
import { projectQuery, readIndexBin, rowVector, searchVectorIndex, topKFromScores, type VectorIndex } from './index-file';
import type { Hit } from './match';

export interface SearchInfo {
  count: number;
  dims: number;
  modelDims: number;
  kind: string;
  backend: 'webgpu' | 'cpu';
  /** Why the GPU isn't used, when it isn't. */
  gpuNote?: string;
  ms: number;
}

export class SearchCore {
  private idx: VectorIndex | null = null;
  private gpu: GpuSearch | null = null;
  private mask: Uint8Array | null = null;

  async load(bin: ArrayBuffer, opts: { gpu?: boolean } = {}): Promise<SearchInfo> {
    const t0 = performance.now();
    this.gpu?.destroy();
    this.gpu = null;
    this.mask = null;
    const idx = readIndexBin(bin);
    this.idx = idx;
    let gpuNote: string | undefined;
    if (opts.gpu !== false) {
      try {
        this.gpu = await GpuSearch.create(idx);
        if (!this.gpu) gpuNote = 'no WebGPU';
        else if (!(await this.gpuAgrees())) {
          gpuNote = 'the GPU disagreed with the CPU';
          this.gpu.destroy();
          this.gpu = null;
        }
      } catch (e) {
        gpuNote = (e as Error).message;
        this.gpu = null;
      }
      if (gpuNote) console.warn(`Scanner search: on the CPU (${gpuNote})`);
    }
    return { count: idx.count, dims: idx.dims, modelDims: idx.modelDims, kind: idx.kind, backend: this.gpu ? 'webgpu' : 'cpu', gpuNote, ms: performance.now() - t0 };
  }

  /** A few rows looked up both ways: same rows, scores within 1e-4. */
  private async gpuAgrees(): Promise<boolean> {
    const idx = this.idx!;
    const qs = [0, idx.count >> 1, idx.count - 1].map((r) => rowVector(idx, r));
    // The queries are already in the index's space: no projection.
    const cpu = searchVectorIndex({ ...idx, basis: null, modelDims: idx.dims }, qs, 5);
    const gpu = topKFromScores(await this.gpu!.score(qs), qs.length, idx.count, 5);
    return cpu.every((hits, q) => gpu[q][0]?.index === hits[0]?.index && hits.every((h, i) => Math.abs((gpu[q][i]?.score ?? Infinity) - h.score) < 1e-4));
  }

  /** 1 = keep the row; null = every row. */
  setMask(mask: Uint8Array | null) {
    if (mask && this.idx && mask.length !== this.idx.count) throw new Error(`Mask of ${mask.length} rows for an index of ${this.idx.count}`);
    this.mask = mask;
  }

  async search(queries: readonly Float32Array[], k: number): Promise<{ hits: Hit[][]; ms: number }> {
    const idx = this.idx;
    if (!idx) throw new Error('No index loaded');
    const t0 = performance.now();
    let hits: Hit[][];
    if (this.gpu) {
      hits = [];
      for (let i = 0; i < queries.length; i += MAX_QUERIES) {
        const part = queries.slice(i, i + MAX_QUERIES).map((q) => projectQuery(idx, q));
        hits.push(...topKFromScores(await this.gpu.score(part), part.length, idx.count, k, this.mask));
      }
    } else hits = searchVectorIndex(idx, queries, k, this.mask);
    return { hits, ms: performance.now() - t0 };
  }

  dispose() {
    this.gpu?.destroy();
    this.gpu = null;
    this.idx = null;
  }
}
