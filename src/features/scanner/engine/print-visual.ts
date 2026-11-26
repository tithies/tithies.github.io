/**
 * The visual print check (sandbox): which of several same-art prints a card cut-out is, by comparing it with each
 * print's picture only where those pictures differ (collector line, set symbol, wording, List icon, stamps). The
 * same steps as the trainer's trainer/verify.py (visual_check), at the same size (672 × 936):
 * - alignment: an ECC homography at 1/4, then 1/2 size (60 iterations, ε 1e-5, Gaussian 5), the cut-out warped
 *   onto each picture;
 * - for each pair of pictures: the second aligned onto the first, their grey difference blurred (σ 2) above 0.08,
 *   inside the card (2–98 % of its height, 3–97 % of its width), not where the photo is near white (glare),
 *   dilated 7 × 7;
 * - there, the windowed normalized cross-correlation (15 × 15) of the photo with each picture: the pair's lead;
 * - the winner leads every other candidate; its margin is its smallest lead.
 */
import { free, type CV, type Mat } from './opencv';

export const CHECK_W = 672;
export const CHECK_H = 936;

/** Grey, float, 0…1. */
function gray(cv: CV, rgba: Mat): Mat {
  const g = new cv.Mat();
  const f = new cv.Mat();
  cv.cvtColor(rgba, g, cv.COLOR_RGBA2GRAY);
  g.convertTo(f, cv.CV_32F, 1 / 255);
  free(g);
  return f;
}

function mul3(a: number[], b: number[]): number[] {
  const out = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return out;
}

/** `moving` (RGBA) warped onto `ref` (RGBA), or null when ECC doesn't converge. */
export function align(cv: CV, moving: Mat, ref: Mat): Mat | null {
  let w = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const gRef = gray(cv, ref);
  const gMov = gray(cv, moving);
  try {
    for (const scale of [0.25, 0.5]) {
      const a = new cv.Mat();
      const b = new cv.Mat();
      const size = new cv.Size(Math.round(CHECK_W * scale), Math.round(CHECK_H * scale));
      cv.resize(gRef, a, size, 0, 0, cv.INTER_AREA);
      cv.resize(gMov, b, size, 0, 0, cv.INTER_AREA);
      const S = [scale, 0, 0, 0, scale, 0, 0, 0, 1];
      const Si = [1 / scale, 0, 0, 0, 1 / scale, 0, 0, 0, 1];
      const ws = cv.matFromArray(3, 3, cv.CV_32F, mul3(mul3(S, w), Si));
      const noMask = new cv.Mat();
      try {
        const criteria = new cv.TermCriteria((cv.TERM_CRITERIA_EPS ?? 2) | (cv.TERM_CRITERIA_COUNT ?? 1), 60, 1e-5);
        cv.findTransformECC(a, b, ws, cv.MOTION_HOMOGRAPHY, criteria, noMask, 5);
        w = mul3(mul3(Si, Array.from(ws.data32F as Float32Array)), S);
      } finally {
        free(a, b, ws, noMask);
      }
    }
  } catch {
    return null;
  } finally {
    free(gRef, gMov);
  }
  const m = cv.matFromArray(3, 3, cv.CV_32F, w);
  const out = new cv.Mat();
  try {
    cv.warpPerspective(moving, out, m, new cv.Size(CHECK_W, CHECK_H), cv.INTER_LINEAR + cv.WARP_INVERSE_MAP, cv.BORDER_REPLICATE);
    return out;
  } finally {
    free(m);
  }
}

/** Windowed normalized cross-correlation of two grey float images (k × k box). */
function localNcc(cv: CV, a: Mat, b: Mat, k = 15): Mat {
  const ksize = new cv.Size(k, k);
  const ma = new cv.Mat();
  const mb = new cv.Mat();
  const aa = new cv.Mat();
  const bb = new cv.Mat();
  const ab = new cv.Mat();
  const tmp = new cv.Mat();
  try {
    cv.blur(a, ma, ksize);
    cv.blur(b, mb, ksize);
    cv.multiply(a, a, tmp);
    cv.blur(tmp, aa, ksize);
    cv.multiply(b, b, tmp);
    cv.blur(tmp, bb, ksize);
    cv.multiply(a, b, tmp);
    cv.blur(tmp, ab, ksize);
    const n = a.rows * a.cols;
    const out = new cv.Mat(a.rows, a.cols, cv.CV_32F);
    const A = ma.data32F as Float32Array;
    const B = mb.data32F as Float32Array;
    const AA = aa.data32F as Float32Array;
    const BB = bb.data32F as Float32Array;
    const AB = ab.data32F as Float32Array;
    const O = out.data32F as Float32Array;
    for (let i = 0; i < n; i++) {
      const va = AA[i] - A[i] * A[i];
      const vb = BB[i] - B[i] * B[i];
      O[i] = (AB[i] - A[i] * B[i]) / Math.sqrt(Math.max(va * vb, 1e-6));
    }
    return out;
  } finally {
    free(ma, mb, aa, bb, ab, tmp);
  }
}

export interface VisualCheck {
  /** Index of the winning picture, or null (no pair had differences to compare). */
  winner: number | null;
  /** The winner's smallest lead over another picture. */
  margin: number;
  /** Per pair [i, j, score i, score j, mask pixels], or [i, j] when the pictures don't differ. */
  pairs: number[][];
}

/** Compares a card cut-out (RGBA, 672 × 936) with each candidate's picture (RGBA, any size). */
export function visualCheck(cv: CV, card: Mat, pictures: Mat[], diff = 0.08): VisualCheck {
  const pics = pictures.map((p) => {
    if (p.cols === CHECK_W && p.rows === CHECK_H) return p.clone();
    const r = new cv.Mat();
    cv.resize(p, r, new cv.Size(CHECK_W, CHECK_H), 0, 0, p.cols > CHECK_W ? cv.INTER_AREA : cv.INTER_LINEAR);
    return r;
  });
  const on = pics.map((p) => align(cv, card, p) ?? card.clone());
  const lead: number[][] = pics.map(() => []);
  const pairs: number[][] = [];
  const kernel = cv.Mat.ones(7, 7, cv.CV_8U);
  try {
    for (let i = 0; i < pics.length; i++) {
      for (let j = i + 1; j < pics.length; j++) {
        const pbOnA = align(cv, pics[j], pics[i]) ?? pics[j].clone();
        const ga = gray(cv, pics[i]);
        const gb = gray(cv, pbOnA);
        const photo = gray(cv, on[i]);
        const d = new cv.Mat();
        const mask = new cv.Mat(CHECK_H, CHECK_W, cv.CV_8U);
        const dil = new cv.Mat();
        let nccA: Mat | null = null;
        let nccB: Mat | null = null;
        try {
          cv.absdiff(ga, gb, d);
          cv.GaussianBlur(d, d, new cv.Size(0, 0), 2);
          const D = d.data32F as Float32Array;
          const P = photo.data32F as Float32Array;
          const M = mask.data as Uint8Array;
          const y0 = Math.floor(0.02 * CHECK_H);
          const y1 = Math.floor(0.98 * CHECK_H);
          const x0 = Math.floor(0.03 * CHECK_W);
          const x1 = Math.floor(0.97 * CHECK_W);
          for (let y = 0; y < CHECK_H; y++) {
            for (let x = 0; x < CHECK_W; x++) {
              const o = y * CHECK_W + x;
              M[o] = y >= y0 && y < y1 && x >= x0 && x < x1 && D[o] > diff && P[o] < 0.93 ? 1 : 0;
            }
          }
          cv.dilate(mask, dil, kernel);
          const DM = dil.data as Uint8Array;
          let n = 0;
          for (let o = 0; o < DM.length; o++) n += DM[o];
          if (n < 60) {
            pairs.push([i, j]);
            continue;
          }
          nccA = localNcc(cv, photo, ga);
          nccB = localNcc(cv, photo, gb);
          const NA = nccA.data32F as Float32Array;
          const NB = nccB.data32F as Float32Array;
          let sa = 0;
          let sb = 0;
          for (let o = 0; o < DM.length; o++) {
            if (DM[o]) {
              sa += NA[o];
              sb += NB[o];
            }
          }
          sa /= n;
          sb /= n;
          lead[i].push(sa - sb);
          lead[j].push(sb - sa);
          pairs.push([i, j, sa, sb, n]);
        } finally {
          free(pbOnA, ga, gb, photo, d, mask, dil, nccA, nccB);
        }
      }
    }
  } finally {
    free(kernel, ...pics, ...on);
  }
  let winner: number | null = null;
  let margin = 0;
  lead.forEach((l, i) => {
    if (!l.length) return;
    const m = Math.min(...l);
    if (winner === null || m > margin) {
      winner = i;
      margin = m;
    }
  });
  return { winner, margin, pairs };
}
