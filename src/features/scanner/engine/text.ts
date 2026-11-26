/**
 * Text on a card (sandbox): PaddlePaddle's PP-OCRv5 mobile models (Apache-2.0) through onnxruntime. The text
 * detector (DB) finds the lines of a card cut-out, a recognizer (CTC) reads each. The same steps as the
 * trainer's trainer/ocr.py (tithies-scanner-trainer repo), so both read the same text:
 * - detection: the cut-out (BGR) resized to multiples of 32 (longest side at most 960), ImageNet normalization;
 *   the probability map above 0.3 → contours; a contour's mean probability at least 0.6; its rotated rectangle
 *   grown by area × 1.5 ÷ perimeter on each side;
 * - recognition: each line straightened (perspective, cubic), 48 px tall, (x/255 − 0.5)/0.5; lines sorted by
 *   width ÷ height and read 16 at a time, padded to the batch's widest; greedy CTC decoding (0 = blank).
 */
import * as ort from 'onnxruntime-web';
import { free, type CV, type Mat } from './opencv';

export type TextModel = 'det' | 'latin' | 'main' | 'korean' | 'cyrillic';

export interface TextLine {
  /** Centre height and left edge, as shares of the card's height and width. */
  y: number;
  x: number;
  /** Height, as a share of the card's height. */
  h: number;
  text: string;
  /** Mean probability of the characters read. */
  conf: number;
}

const sessions = new Map<TextModel, { s: ort.InferenceSession; backend: 'webgpu' | 'wasm' }>();
const dictionaries = new Map<TextModel, string[]>();

export const hasTextModel = (m: TextModel) => sessions.has(m);

/** A recognizer's characters as its inference.yml lists them: CTC's blank comes first, a space last. */
export async function loadTextModel(name: TextModel, bytes: ArrayBuffer, chars?: string[]): Promise<'webgpu' | 'wasm'> {
  await sessions.get(name)?.s.release();
  sessions.delete(name);
  if (name !== 'det') {
    if (!chars?.length) throw new Error(`No characters for the ${name} recognizer`);
    dictionaries.set(name, ['', ...chars, ' ']);
  }
  const tries: ('webgpu' | 'wasm')[] = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError: unknown;
  for (const ep of tries) {
    try {
      const s = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: [ep], graphOptimizationLevel: 'all' });
      sessions.set(name, { s, backend: ep });
      return ep;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function session(name: TextModel): ort.InferenceSession {
  const s = sessions.get(name);
  if (!s) throw new Error(`The ${name} text model is not loaded`);
  return s.s;
}

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

/** An RGBA Mat as a 1 × 3 × H × W float tensor in B, G, R order (the models were trained on BGR). */
function bgrTensor(rgba: Mat, norm: (v: number, c: number) => number, out?: Float32Array, offset = 0, width = rgba.cols): Float32Array {
  const { rows, cols } = rgba;
  const data: Uint8Array = rgba.data;
  const plane = rows * width;
  const t = out ?? new Float32Array(3 * plane);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const i = (y * cols + x) * 4;
      const o = offset + y * width + x;
      // Channel 0 is blue, 1 green, 2 red.
      t[o] = norm(data[i + 2] / 255, 0);
      t[o + plane] = norm(data[i + 1] / 255, 1);
      t[o + 2 * plane] = norm(data[i] / 255, 2);
    }
  }
  return t;
}

export interface TextBox {
  /** Top-left, top-right, bottom-right, bottom-left, in the cut-out's pixels. */
  pts: [number, number][];
  score: number;
}

/** Top-left, top-right, bottom-right, bottom-left for a near-horizontal box (trainer: order_box). */
function orderBox(pts: [number, number][]): [number, number][] {
  const byX = [...pts].sort((a, b) => a[0] - b[0]);
  const [tl, bl] = byX.slice(0, 2).sort((a, b) => a[1] - b[1]);
  const [tr, br] = byX.slice(2).sort((a, b) => a[1] - b[1]);
  return [tl, tr, br, bl];
}

/** The text lines of a card cut-out (RGBA), top to bottom. */
export async function detectText(cv: CV, card: Mat, limit = 960, thresh = 0.3, boxThresh = 0.6, unclip = 1.5): Promise<TextBox[]> {
  const h = card.rows;
  const w = card.cols;
  const s = Math.max(h, w) > limit ? limit / Math.max(h, w) : 1;
  const nh = Math.max(32, Math.round((h * s) / 32) * 32);
  const nw = Math.max(32, Math.round((w * s) / 32) * 32);
  const resized = new cv.Mat();
  const bin = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let probMat: Mat | null = null;
  try {
    cv.resize(card, resized, new cv.Size(nw, nh), 0, 0, cv.INTER_LINEAR);
    const input = new ort.Tensor('float32', bgrTensor(resized, (v, c) => (v - MEAN[c]) / STD[c]), [1, 3, nh, nw]);
    const sess = session('det');
    const out = await sess.run({ [sess.inputNames[0]]: input });
    const t = out[sess.outputNames[0]];
    const prob = (await t.getData()) as Float32Array;
    for (const v of Object.values(out)) v.dispose();
    probMat = cv.matFromArray(nh, nw, cv.CV_32F, prob);
    cv.threshold(probMat, bin, thresh, 1, cv.THRESH_BINARY);
    bin.convertTo(bin, cv.CV_8U);
    cv.findContours(bin, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const boxes: TextBox[] = [];
    const n = Math.min(contours.size(), 1000);
    for (let i = 0; i < n; i++) {
      const c = contours.get(i);
      try {
        if (c.rows < 4) continue;
        const rect = cv.minAreaRect(c);
        if (Math.min(rect.size.width, rect.size.height) < 3) continue;
        // The contour's mean probability.
        const mask = cv.Mat.zeros(nh, nw, cv.CV_8U);
        const one = new cv.MatVector();
        one.push_back(c);
        cv.fillPoly(mask, one, new cv.Scalar(1));
        const score = cv.countNonZero(mask) ? cv.mean(probMat, mask)[0] : 0;
        free(mask, one);
        if (score < boxThresh) continue;
        const area = cv.contourArea(c);
        const perim = cv.arcLength(c, true);
        const d = (area * unclip) / Math.max(perim, 1e-6);
        const grown = { center: rect.center, size: { width: rect.size.width + 2 * d, height: rect.size.height + 2 * d }, angle: rect.angle };
        const pts = (cv.RotatedRect.points(grown) as { x: number; y: number }[]).map((p): [number, number] => [(p.x * w) / nw, (p.y * h) / nh]);
        boxes.push({ pts: orderBox(pts), score });
      } finally {
        free(c);
      }
    }
    const mean = (b: TextBox, k: 0 | 1) => b.pts.reduce((s2, p) => s2 + p[k], 0) / 4;
    return boxes.sort((a, b) => mean(a, 1) - mean(b, 1) || mean(a, 0) - mean(b, 0));
  } finally {
    free(resized, bin, contours, hierarchy, probMat);
  }
}

/** A box straightened out of the cut-out (trainer: crop_box). */
export function cropBox(cv: CV, card: Mat, pts: [number, number][]): Mat {
  const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const w = Math.max(2, Math.floor(Math.max(dist(pts[0], pts[1]), dist(pts[3], pts[2]))));
  const h = Math.max(2, Math.floor(Math.max(dist(pts[0], pts[3]), dist(pts[1], pts[2]))));
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, pts.flat());
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]);
  const m = cv.getPerspectiveTransform(src, dst);
  const out = new cv.Mat();
  try {
    cv.warpPerspective(card, out, m, new cv.Size(w, h), cv.INTER_CUBIC, cv.BORDER_REPLICATE);
    return out;
  } finally {
    free(src, dst, m);
  }
}

/** Reads line crops (RGBA) with a recognizer: [text, conf] each. */
export async function recognize(cv: CV, name: TextModel, crops: Mat[], batch = 16): Promise<{ text: string; conf: number }[]> {
  const chars = dictionaries.get(name);
  if (!chars) throw new Error(`The ${name} recognizer is not loaded`);
  const sess = session(name);
  const out: { text: string; conf: number }[] = new Array(crops.length);
  const ratio = (m: Mat) => m.cols / Math.max(1, m.rows);
  // Stable: equal ratios keep their order (as Python's sorted).
  const order = crops.map((_, i) => i).sort((a, b) => ratio(crops[a]) - ratio(crops[b]) || a - b);
  for (let start = 0; start < order.length; start += batch) {
    const idx = order.slice(start, start + batch);
    const widths = idx.map((i) => Math.min(3200, Math.max(16, Math.ceil((48 * crops[i].cols) / Math.max(1, crops[i].rows)))));
    const W = Math.max(...widths);
    const plane = 48 * W;
    const x = new Float32Array(idx.length * 3 * plane);
    idx.forEach((i, k) => {
      const r = new cv.Mat();
      try {
        cv.resize(crops[i], r, new cv.Size(widths[k], 48), 0, 0, cv.INTER_LINEAR);
        // Written into this line's slot; the rest of the width stays 0 (the padding).
        bgrTensor(r, (v) => (v - 0.5) / 0.5, x.subarray(k * 3 * plane, (k + 1) * 3 * plane), 0, W);
      } finally {
        free(r);
      }
    });
    const res = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', x, [idx.length, 3, 48, W]) });
    const t = res[sess.outputNames[0]];
    const p = (await t.getData()) as Float32Array;
    const [, T, C] = t.dims as number[];
    for (const v of Object.values(res)) v.dispose();
    idx.forEach((i, k) => {
      let text = '';
      const confs: number[] = [];
      let prev = -1;
      for (let s = 0; s < T; s++) {
        const o = (k * T + s) * C;
        let best = 0;
        for (let c = 1; c < C; c++) if (p[o + c] > p[o + best]) best = c;
        if (best !== prev && best !== 0 && best < chars.length) {
          text += chars[best];
          confs.push(p[o + best]);
        }
        prev = best;
      }
      out[i] = { text, conf: confs.length ? confs.reduce((a, b) => a + b, 0) / confs.length : 0 };
    });
  }
  return out;
}
