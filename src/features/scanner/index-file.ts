/**
 * The every-print index (made by `python -m trainer index` in the tithies-scanner-trainer repo, published with the
 * models): every print's vector, and the print of each. Reading the files, and the nearest-print search over them.
 *
 * `index-<date>.bin`, little-endian: "TSIX", then uint32 × 7 (file version 1, rows M, dimensions D, model dimensions
 * (384), kind 0 f32 · 1 f16 · 2 i8, has a basis, 0); the basis (float32, model dims × D, row-major) when D is less than
 * the model's; the scales (float32 × M) for i8; the rows (M × D). A query is projected on the basis and normalized
 * again, then a row's score is query · row (× its scale, for i8): the trainer's arithmetic (trainer/vectors.py).
 *
 * `prints-<date>.json.gz`: `{ sets: {code: name}, columns, rows: [[scryfallId, face, name, set, cn, lang, art, finishes]] }`.
 */
import type { Hit } from './match';
import type { PrintInfo } from './reference';

export type IndexKind = 'f32' | 'f16' | 'i8';

export interface VectorIndex {
  count: number;
  dims: number;
  modelDims: number;
  kind: IndexKind;
  /** modelDims × dims (row-major), when the vectors were projected. */
  basis: Float32Array | null;
  /** One per row, for i8. */
  scales: Float32Array | null;
  /** count × dims: f16 rows are turned into float32 when read. */
  rows: Float32Array | Int8Array;
}

const KINDS: IndexKind[] = ['f32', 'f16', 'i8'];
const MAGIC = 0x58495354; // "TSIX" read as a little-endian uint32

/** float16 bits → number (no Float16Array needed). */
function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

export function readIndexBin(buf: ArrayBuffer): VectorIndex {
  const v = new DataView(buf);
  if (buf.byteLength < 32 || v.getUint32(0, true) !== MAGIC) throw new Error('Not a Scanner index file');
  const [version, count, dims, modelDims, kindCode, hasBasis] = [4, 8, 12, 16, 20, 24].map((o) => v.getUint32(o, true));
  if (version !== 1) throw new Error(`Index file version ${version}: this Tithies reads version 1`);
  const kind = KINDS[kindCode];
  if (!kind) throw new Error(`Unknown index kind ${kindCode}`);
  let o = 32;
  let basis: Float32Array | null = null;
  if (hasBasis) {
    basis = new Float32Array(buf, o, modelDims * dims);
    o += basis.byteLength;
  }
  let scales: Float32Array | null = null;
  if (kind === 'i8') {
    scales = new Float32Array(buf, o, count);
    o += scales.byteLength;
  }
  const n = count * dims;
  const need = o + n * (kind === 'f32' ? 4 : kind === 'f16' ? 2 : 1);
  if (buf.byteLength < need) throw new Error(`The index file is cut short (${buf.byteLength} of ${need} bytes)`);
  let rows: Float32Array | Int8Array;
  if (kind === 'f32') rows = new Float32Array(buf, o, n);
  else if (kind === 'i8') rows = new Int8Array(buf, o, n);
  else {
    const half = new Uint16Array(buf, o, n);
    const table = new Float32Array(65536);
    for (let h = 0; h < 65536; h++) table[h] = halfToFloat(h);
    rows = new Float32Array(n);
    for (let i = 0; i < n; i++) rows[i] = table[half[i]];
  }
  return { count, dims, modelDims, kind, basis, scales, rows };
}

/** One print of the index: the PrintInfo the page shows, its artwork group and finishes (1 nonfoil, 2 foil, 4 etched, 8 glossy). */
export interface IndexPrint extends PrintInfo {
  art: number;
  finishes: number;
}

interface PrintsFile {
  sets: Record<string, string>;
  columns: string[];
  rows: [string, number, string, string, string, string, number, number][];
}

/** The prints file's rows, in the index's order. */
export function parsePrints(json: string): IndexPrint[] {
  const f = JSON.parse(json) as PrintsFile;
  const want = ['scryfallId', 'face', 'name', 'set', 'cn', 'lang', 'art', 'finishes'];
  if (want.some((c, i) => f.columns?.[i] !== c)) throw new Error('Unexpected prints file columns');
  return f.rows.map(([scryfallId, face, name, set, cn, lang, art, finishes]) => ({
    scryfallId,
    name,
    set,
    setName: f.sets[set] ?? set,
    cn,
    lang,
    ...(face ? { back: true } : {}),
    art,
    finishes,
  }));
}

/** A gzipped file's text (DecompressionStream: browsers, Node 18+). */
export async function gunzipText(buf: ArrayBuffer): Promise<string> {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/** A query (model dims, normalized) in the index's space: projected on the basis and normalized again, or as it is. */
export function projectQuery(idx: Pick<VectorIndex, 'basis' | 'dims' | 'modelDims'>, q: Float32Array): Float32Array {
  if (q.length !== idx.modelDims) throw new Error(`Query has ${q.length} numbers, the index's model ${idx.modelDims}`);
  if (!idx.basis) return q;
  const { basis, dims } = idx;
  const out = new Float32Array(dims);
  for (let i = 0; i < q.length; i++) {
    const qi = q[i];
    if (!qi) continue;
    const o = i * dims;
    for (let j = 0; j < dims; j++) out[j] += qi * basis[o + j];
  }
  let s = 0;
  for (let j = 0; j < dims; j++) s += out[j] * out[j];
  const n = Math.sqrt(s) || 1;
  for (let j = 0; j < dims; j++) out[j] /= n;
  return out;
}

/**
 * The k best rows for each query (best first), brute force over every row: the rows are read once for all the
 * queries. `mask`, when given, keeps only the rows where it is 1 ("only my prints").
 */
export function searchVectorIndex(idx: VectorIndex, queries: readonly Float32Array[], k: number, mask?: Uint8Array | null): Hit[][] {
  const qs = queries.map((q) => projectQuery(idx, q));
  const nq = qs.length;
  const { dims, rows, scales, count } = idx;
  // Per query, the k best so far (score descending), in flat arrays.
  const topS = qs.map(() => new Float64Array(k).fill(-Infinity));
  const topI = qs.map(() => new Int32Array(k).fill(-1));
  const sums = new Float64Array(nq);
  for (let r = 0; r < count; r++) {
    if (mask && !mask[r]) continue;
    const o = r * dims;
    for (let q = 0; q < nq; q++) {
      const qv = qs[q];
      let s = 0;
      for (let j = 0; j < dims; j++) s += qv[j] * rows[o + j];
      sums[q] = s;
    }
    const scale = scales ? scales[r] : 1;
    for (let q = 0; q < nq; q++) {
      const s = sums[q] * scale;
      const ts = topS[q];
      if (s <= ts[k - 1]) continue;
      const ti = topI[q];
      let i = k - 1;
      while (i > 0 && ts[i - 1] < s) {
        ts[i] = ts[i - 1];
        ti[i] = ti[i - 1];
        i--;
      }
      ts[i] = s;
      ti[i] = r;
    }
  }
  return qs.map((_, q) => {
    const hits: Hit[] = [];
    for (let i = 0; i < k; i++) if (topI[q][i] >= 0) hits.push({ index: topI[q][i], score: topS[q][i] });
    return hits;
  });
}

/** Rows of the index that are the given prints: by Scryfall id and face, else by set, number and face (a print the index
 * doesn't hold, such as a non-English one, is the default print with its set and number). 1 = keep. */
export function printMask(prints: readonly IndexPrint[], owned: readonly Pick<PrintInfo, 'scryfallId' | 'set' | 'cn'>[]): Uint8Array {
  const mask = new Uint8Array(prints.length);
  const byId = new Map<string, number[]>();
  const bySetCn = new Map<string, number[]>();
  const norm = (s: string) => s.trim().toLowerCase();
  prints.forEach((p, i) => {
    const id = byId.get(p.scryfallId);
    if (id) id.push(i);
    else byId.set(p.scryfallId, [i]);
    const key = `${norm(p.set)}|${norm(p.cn)}`;
    const sc = bySetCn.get(key);
    if (sc) sc.push(i);
    else bySetCn.set(key, [i]);
  });
  for (const o of owned) {
    // Every face of the print: its rows by id, else the rows of its set and number.
    const rows = byId.get(o.scryfallId) ?? bySetCn.get(`${norm(o.set)}|${norm(o.cn)}`) ?? [];
    for (const i of rows) mask[i] = 1;
  }
  return mask;
}

/** The k best rows of each query from a scores matrix (query q's row r at q × count + r), skipping rows the mask drops. */
export function topKFromScores(scores: Float32Array, nq: number, count: number, k: number, mask?: Uint8Array | null): Hit[][] {
  const out: Hit[][] = [];
  for (let q = 0; q < nq; q++) {
    const ts = new Float64Array(k).fill(-Infinity);
    const ti = new Int32Array(k).fill(-1);
    const o = q * count;
    for (let r = 0; r < count; r++) {
      const s = scores[o + r];
      if (s <= ts[k - 1] || (mask && !mask[r])) continue;
      let i = k - 1;
      while (i > 0 && ts[i - 1] < s) {
        ts[i] = ts[i - 1];
        ti[i] = ti[i - 1];
        i--;
      }
      ts[i] = s;
      ti[i] = r;
    }
    const hits: Hit[] = [];
    for (let i = 0; i < k; i++) if (ti[i] >= 0) hits.push({ index: ti[i], score: ts[i] });
    out.push(hits);
  }
  return out;
}

/** Row r of the index as a vector in its own space (int8 rows times their scale), normalized: a query that should find row r. */
export function rowVector(idx: VectorIndex, r: number): Float32Array {
  const v = new Float32Array(idx.dims);
  const scale = idx.scales ? idx.scales[r] : 1;
  for (let j = 0; j < idx.dims; j++) v[j] = idx.rows[r * idx.dims + j] * scale;
  let s = 0;
  for (let j = 0; j < idx.dims; j++) s += v[j] * v[j];
  const n = Math.sqrt(s) || 1;
  for (let j = 0; j < idx.dims; j++) v[j] /= n;
  return v;
}
