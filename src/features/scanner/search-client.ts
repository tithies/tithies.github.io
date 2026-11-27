/**
 * The page's side of the search worker (search.worker.ts): load the index (its bytes are moved, not copied), set
 * the "only my prints" mask, search a batch of queries.
 */
import type { Hit } from './match';
import { ClosedError } from './protocol';
import type { SearchInfo } from './search-core';

export type SearchRequest =
  | { type: 'load'; bin: ArrayBuffer; gpu?: boolean }
  | { type: 'mask'; mask: Uint8Array | null }
  | { type: 'search'; queries: Float32Array[]; k: number };

export interface SearchReply {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

type Results = { load: SearchInfo; mask: null; search: { hits: Hit[][]; ms: number } };

export class SearchClient {
  private worker: Worker;
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private closed = false;

  constructor() {
    this.worker = new Worker(new URL('./search.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<SearchReply>) => {
      const p = this.pending.get(e.data.id);
      if (!p) return;
      this.pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data.result);
      else p.reject(new Error(e.data.error ?? 'Search failed'));
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.reject(new Error(e.message || 'The search worker failed'));
      this.pending.clear();
    };
  }

  private call<T extends SearchRequest>(request: T, transfer: Transferable[] = []): Promise<Results[T['type']]> {
    // A terminated worker never answers: a call after dispose fails at once.
    if (this.closed) return Promise.reject(new ClosedError('The search worker'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage({ id, request }, transfer);
    });
  }

  /** The index file's bytes move to the worker: `bin` is empty afterwards. */
  load(bin: ArrayBuffer, gpu = true) {
    return this.call({ type: 'load', bin, gpu }, [bin]);
  }

  setMask(mask: Uint8Array | null) {
    return this.call({ type: 'mask', mask: mask ? mask.slice() : null });
  }

  search(queries: Float32Array[], k: number) {
    return this.call({ type: 'search', queries, k });
  }

  dispose() {
    this.closed = true;
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new ClosedError('The search worker'));
    this.pending.clear();
  }
}
