/**
 * A card's picture → its vectors (sandbox). Photo cards are flattened from their 4 corners
 * (homography) into 488 × 680, Scryfall's "normal" size, so references and photos go through the
 * same steps. Each flattened card is resized for each model run (squashed, padded), its CLS
 * and mean vectors taken; then the same for the card turned 180°.
 */
import * as ort from 'onnxruntime-web';
import { quadSize, type Quad } from '../geometry';
import { CARD_H, CARD_W, DIM, INPUT, MEAN, RUNS, STD, VARIANTS, type ModelRun } from '../models';
import { l2normalize } from '../match';
import type { Features } from '../protocol';
import { free, type CV, type Mat } from './opencv';

let session: ort.InferenceSession | null = null;
let backend: 'webgpu' | 'wasm' | null = null;
/** The first calls log their timings (console), to see where the time goes. */
let timingLogs = 12;

export function initOrt(wasm: ArrayBuffer) {
  ort.env.wasm.wasmBinary = wasm;
  // One thread: several need SharedArrayBuffer (cross-origin isolation), which the dashboard doesn't have.
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  // ORT warns (as console errors) that it keeps shape operations on the CPU: expected, not a problem.
  ort.env.logLevel = 'error';
}

export const ortVersion = () => ort.env.versions?.web ?? '?';
export const currentBackend = () => backend;

let modelBytes: Uint8Array | null = null;

export interface BenchOptions {
  ep: 'webgpu' | 'wasm';
  opt: 'disabled' | 'basic' | 'extended' | 'all';
  runs: number;
  /** Keep outputs on the GPU (no read back) to time the model alone. */
  gpuOutputs?: boolean;
  /** Pictures per run (default 1). */
  batch?: number;
}

/** Times the model with other session options (prototype tuning; console only). */
export async function bench(o: BenchOptions): Promise<{ create: number; runs: number[]; reads: number[] }> {
  if (!modelBytes) throw new Error('Load the model first');
  let t = performance.now();
  const s = await ort.InferenceSession.create(modelBytes, {
    executionProviders: [o.ep],
    graphOptimizationLevel: o.opt,
    ...(o.gpuOutputs ? { preferredOutputLocation: 'gpu-buffer' as const } : {}),
  });
  const create = performance.now() - t;
  const b = o.batch ?? 1;
  const input = new ort.Tensor('float32', new Float32Array(b * 3 * INPUT * INPUT).map(() => Math.random() - 0.5), [b, 3, INPUT, INPUT]);
  const runs: number[] = [];
  const reads: number[] = [];
  for (let i = 0; i < o.runs; i++) {
    t = performance.now();
    const out = await s.run({ [s.inputNames[0]]: input });
    runs.push(Math.round(performance.now() - t));
    if (o.gpuOutputs) {
      t = performance.now();
      await out.last_hidden_state.getData();
      reads.push(Math.round(performance.now() - t));
    }
    for (const v of Object.values(out)) v.dispose();
  }
  await s.release();
  return { create: Math.round(create), runs, reads };
}

/** Loads the model, on WebGPU when the browser has it, else on the CPU. */
export async function loadModel(bytes: ArrayBuffer): Promise<'webgpu' | 'wasm'> {
  await session?.release();
  session = null;
  modelBytes = new Uint8Array(bytes);
  const tries: ('webgpu' | 'wasm')[] = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError: unknown;
  for (const ep of tries) {
    try {
      // logSeverityLevel 3: onnxruntime's notice that shape ops run on the CPU is not an error.
      session = await ort.InferenceSession.create(modelBytes, { executionProviders: [ep], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
      backend = ep;
      return ep;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Flattens the card under `quad` from the full photo into 488 × 680 RGBA. */
export function warpCard(cv: CV, full: Mat, quad: Quad, W = CARD_W, H = CARD_H): Mat {
  const { h } = quadSize(quad);
  // Large cards: warp at up to 2× the target, then shrink with area averaging (sharper, no aliasing).
  const k = Math.min(2, Math.max(1, h / H));
  const ww = Math.round(W * k);
  const hh = Math.round(H * k);
  const src = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flatMap((p) => [p.x, p.y]));
  const dst = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, ww, 0, ww, hh, 0, hh]);
  const m = cv.getPerspectiveTransform(src, dst);
  const warped = new cv.Mat();
  try {
    cv.warpPerspective(full, warped, m, new cv.Size(ww, hh), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
    if (k === 1) return warped.clone();
    const out = new cv.Mat();
    cv.resize(warped, out, new cv.Size(W, H), 0, 0, cv.INTER_AREA);
    return out;
  } finally {
    free(src, dst, m, warped);
  }
}

/** Any card picture (e.g. a Scryfall image) → 488 × 680 RGBA. */
export function toCardSize(cv: CV, rgba: Mat): Mat {
  const out = new cv.Mat();
  const interp = rgba.cols > CARD_W ? cv.INTER_AREA : cv.INTER_LINEAR;
  cv.resize(rgba, out, new cv.Size(CARD_W, CARD_H), 0, 0, interp);
  return out;
}

export function matToImageData(cv: CV, rgba: Mat): ImageData {
  return new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
}

/**
 * Pictures per model run. Each run has a large fixed cost on some GPUs (measured on a Radeon
 * through Chrome: 680 ms for 1 picture, 800 ms for 4, 1.7 s for 16), so cards are batched.
 */
export const BATCH = 16;
const PLANE = INPUT * INPUT;

/** Writes one card into `data` at picture `slot`: NCHW, normalized for DINOv2; padding is 0 (the mean colour). */
function fillInput(cv: CV, card: Mat, mode: ModelRun['mode'], data: Float32Array, slot: number) {
  const h = INPUT;
  const w = mode === 'pad' ? Math.round((INPUT * CARD_W) / CARD_H) : INPUT;
  const left = (INPUT - w) >> 1;
  const base = slot * 3 * PLANE;
  const resized = new cv.Mat();
  try {
    cv.resize(card, resized, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    const px: Uint8Array = resized.data;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const i = base + y * INPUT + x + left;
        data[i] = (px[p] / 255 - MEAN[0]) / STD[0];
        data[PLANE + i] = (px[p + 1] / 255 - MEAN[1]) / STD[1];
        data[2 * PLANE + i] = (px[p + 2] / 255 - MEAN[2]) / STD[2];
      }
  } finally {
    free(resized);
  }
}

/** The vectors (every variant) of 488 × 680 RGBA cards, in batches of BATCH pictures. */
export async function featuresMany(cv: CV, cards: Mat[]): Promise<Features[]> {
  if (!session) throw new Error('The model is not loaded');
  const s = session;
  const jobs = cards.flatMap((_, ci) => RUNS.map((run) => ({ ci, run })));
  const vectors = cards.map((): Record<string, Float32Array> => ({}));
  const times: string[] = [];
  for (let i = 0; i < jobs.length; i += BATCH) {
    const chunk = jobs.slice(i, i + BATCH);
    let clock = performance.now();
    const data = new Float32Array(chunk.length * 3 * PLANE);
    chunk.forEach((j, slot) => fillInput(cv, cards[j.ci], j.run.mode, data, slot));
    const input = new ort.Tensor('float32', data, [chunk.length, 3, INPUT, INPUT]);
    times.push(`prep ${Math.round(performance.now() - clock)}`);
    clock = performance.now();
    const out = await s.run({ [s.inputNames[0]]: input });
    times.push(`run ${chunk.length}: ${Math.round(performance.now() - clock)}`);
    input.dispose();
    const tokens = out.last_hidden_state;
    if (!tokens) throw new Error(`The model has no last_hidden_state output (it has ${Object.keys(out).join(', ')})`);
    const t = tokens.data as Float32Array;
    const n = tokens.dims[1];
    const pooled = out.pooler_output?.data as Float32Array | undefined;
    chunk.forEach((j, slot) => {
      const o = slot * n * DIM;
      // CLS: pooler_output when the model has it (DINOv2: the layer-normed CLS token), else token 0.
      const cls = pooled ? pooled.slice(slot * DIM, (slot + 1) * DIM) : t.slice(o, o + DIM);
      const mean = new Float32Array(DIM);
      for (let k = 1; k < n; k++) for (let d = 0; d < DIM; d++) mean[d] += t[o + k * DIM + d];
      for (const v of VARIANTS) if (v.run === j.run.id) vectors[j.ci][v.id] = l2normalize(v.pooling === 'cls' ? cls : mean);
    });
    for (const v of Object.values(out)) v.dispose();
  }
  if (timingLogs-- > 0) console.info(`[scanner] ${cards.length} cards (${backend}): ${times.join(', ')} ms`);
  return cards.map((_, ci) => ({ vectors: vectors[ci] }));
}
