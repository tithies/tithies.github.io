/**
 * The reference set in memory, one matrix per method, for brute-force nearest-print search.
 */
import { topKCosine, type Hit } from './match';
import { DIM, VARIANTS } from './models';
import type { Features } from './protocol';
import type { PrintInfo } from './reference';
import type { RefRow } from './store';

export interface RefIndex {
  size: number;
  prints: PrintInfo[];
  /** Rows of DIM numbers, one per print, for each variant. */
  matrices: Record<string, Float32Array>;
}

export function buildIndex(rows: readonly RefRow[]): RefIndex {
  const n = rows.length;
  const matrices: Record<string, Float32Array> = {};
  for (const v of VARIANTS) matrices[v.id] = new Float32Array(n * DIM);
  const prints: PrintInfo[] = [];
  rows.forEach((r, i) => {
    prints.push({ scryfallId: r.printId ?? r.scryfallId, name: r.name, set: r.set, setName: r.setName, cn: r.cn, lang: r.lang, back: r.back });
    for (const v of VARIANTS) {
      const vec = r.vectors[v.id];
      if (vec?.length === DIM) matrices[v.id].set(vec, i * DIM);
    }
  });
  return { size: n, prints, matrices };
}

/** The k nearest prints to one card's features, by one method (a variant id). */
export function searchIndex(index: RefIndex, f: Features, method: string, k: number): Hit[] {
  if (!index.size) return [];
  const q = f.vectors[method];
  const m = index.matrices[method];
  return q && m ? topKCosine(q, m, DIM, k) : [];
}
