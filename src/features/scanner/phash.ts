/**
 * Perceptual hash (pHash): the baseline the image models are compared against. The card is
 * shrunk to 32×32 grey, its 2-D DCT taken, and each of the 64 lowest frequencies (DC left out of
 * the median) gives one bit: above or below their median. Similar pictures differ in few bits.
 */

const N = 32;
const LOW = 8;

/** Rec. 601 luma of RGBA pixels. */
export function grayFromRGBA(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Float32Array {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2];
  return out;
}

/** Shrinks a grey image by averaging the source pixels under each target pixel (box filter). */
export function resizeGray(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor((y * sh) / dh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor((x * sw) / dw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / dw));
      let s = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) s += src[yy * sw + xx];
      out[y * dw + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

let cosTable: Float64Array | null = null;
function cosines(): Float64Array {
  if (!cosTable) {
    cosTable = new Float64Array(LOW * N);
    for (let u = 0; u < LOW; u++) for (let x = 0; x < N; x++) cosTable[u * N + x] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * N));
  }
  return cosTable;
}

/** The 64-bit hash of a 32×32 grey image, as two 32-bit words. */
export function phash32(gray32: Float32Array): Uint32Array {
  if (gray32.length !== N * N) throw new Error(`pHash needs a ${N}×${N} image`);
  const c = cosines();
  // Only the 8×8 lowest frequencies are needed: rows first, then columns.
  const rowsDct = new Float64Array(N * LOW);
  for (let y = 0; y < N; y++)
    for (let u = 0; u < LOW; u++) {
      let s = 0;
      for (let x = 0; x < N; x++) s += gray32[y * N + x] * c[u * N + x];
      rowsDct[y * LOW + u] = s;
    }
  const coef = new Float64Array(LOW * LOW);
  for (let v = 0; v < LOW; v++)
    for (let u = 0; u < LOW; u++) {
      let s = 0;
      for (let y = 0; y < N; y++) s += rowsDct[y * LOW + u] * c[v * N + y];
      coef[v * LOW + u] = s;
    }
  const ac = Array.from(coef.subarray(1)).sort((a, b) => a - b);
  const median = (ac[31] + ac[32]) / 2;
  const out = new Uint32Array(2);
  for (let i = 0; i < 64; i++) if (coef[i] > median) out[i >> 5] |= 1 << (i & 31);
  return out;
}

/** pHash of any grey image (shrunk to 32×32 first; the aspect ratio is not kept). */
export function phash(gray: Float32Array, width: number, height: number): Uint32Array {
  return phash32(width === N && height === N ? gray : resizeGray(gray, width, height, N, N));
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Bits that differ between two hashes (0–64). */
export function hamming(a: Uint32Array, b: Uint32Array, bOffset = 0): number {
  return popcount(a[0] ^ b[bOffset]) + popcount(a[1] ^ b[bOffset + 1]);
}
