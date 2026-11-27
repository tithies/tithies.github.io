/**
 * Nearest reference prints for one card: cosine similarity over L2-normalized vectors. Brute force:
 * a few thousand to a hundred thousand prints take milliseconds.
 */

export interface Hit {
  /** Row in the reference set. */
  index: number;
  /** Higher is better: cosine similarity (−1…1). */
  score: number;
}

/** Keeps the k best hits seen so far, best first. */
class TopK {
  readonly hits: Hit[] = [];
  constructor(private readonly k: number) {}
  push(index: number, score: number) {
    const h = this.hits;
    if (h.length === this.k && score <= h[h.length - 1].score) return;
    let i = h.length;
    while (i > 0 && h[i - 1].score < score) i--;
    h.splice(i, 0, { index, score });
    if (h.length > this.k) h.pop();
  }
}

export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

/** `refs` holds one normalized vector of `dim` numbers per row; `query` is normalized too. */
export function topKCosine(query: Float32Array, refs: Float32Array, dim: number, k: number): Hit[] {
  if (query.length !== dim) throw new Error(`Query has ${query.length} numbers, the reference set ${dim}`);
  const top = new TopK(k);
  const rows = refs.length / dim;
  for (let r = 0; r < rows; r++) {
    let s = 0;
    const o = r * dim;
    for (let i = 0; i < dim; i++) s += query[i] * refs[o + i];
    top.push(r, s);
  }
  return top.hits;
}

/**
 * The best hit's lead over the first hit of another card name: how sure the name is. When every
 * hit has the same name (reprints), its lead over the last hit, a lower bound.
 */
export function nameMargin(hits: readonly Hit[], nameOf: (index: number) => string): number {
  if (hits.length < 2) return 0;
  const top = nameOf(hits[0].index);
  const other = hits.find((h) => nameOf(h.index) !== top) ?? hits[hits.length - 1];
  return hits[0].score - other.score;
}
