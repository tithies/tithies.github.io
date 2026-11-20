/**
 * The reference set in memory, one matrix per method, for brute-force nearest-print search.
 */
import { topKCosine, topKHamming, type Hit } from './match';
import { DIM, PHASH_ID, VARIANTS } from './models';
import type { Features } from './protocol';
import type { PrintInfo } from './reference';
import type { RefRow } from './store';

export interface RefIndex {
  size: number;
  prints: PrintInfo[];
  /** Rows of DIM numbers, one per print, for each variant. */
  matrices: Record<string, Float32Array>;
  /** Two words per print. */
  hashes: Uint32Array;
}

export function buildIndex(rows: readonly RefRow[]): RefIndex {
  const n = rows.length;
  const matrices: Record<string, Float32Array> = {};
  for (const v of VARIANTS) matrices[v.id] = new Float32Array(n * DIM);
  const hashes = new Uint32Array(n * 2);
  const prints: PrintInfo[] = [];
  rows.forEach((r, i) => {
    prints.push({ scryfallId: r.printId ?? r.scryfallId, name: r.name, set: r.set, setName: r.setName, cn: r.cn, lang: r.lang, back: r.back });
    for (const v of VARIANTS) {
      const vec = r.vectors[v.id];
      if (vec?.length === DIM) matrices[v.id].set(vec, i * DIM);
    }
    hashes[i * 2] = r.phash[0];
    hashes[i * 2 + 1] = r.phash[1];
  });
  return { size: n, prints, matrices, hashes };
}

/** The k nearest prints to one card's features, by one method (a variant id, or 'phash'). */
export function searchIndex(index: RefIndex, f: Features, method: string, k: number): Hit[] {
  if (!index.size) return [];
  if (method === PHASH_ID) return topKHamming(f.phash, index.hashes, k);
  const q = f.vectors[method];
  const m = index.matrices[method];
  return q && m ? topKCosine(q, m, DIM, k) : [];
}
