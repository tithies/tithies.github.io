/**
 * The trained card detector (sandbox): an ONNX model from the tithies-scanner-trainer repo (export.py). The
 * photo is letterboxed the way training did: shrunk to fit the model's square input, at the
 * top-left, the rest grey (114); outputs are decoded into card quads (detector-decode.ts),
 * then scaled back to the photo's pixels.
 */
import * as ort from 'onnxruntime-web';
import { scaleQuad } from '../geometry';
import { decodeDetector, type DecodedCard } from '../detector-decode';
import { free, type CV, type Mat } from './opencv';

const STRIDE = 4;
const PAD = 114;

let session: ort.InferenceSession | null = null;
let inputSize = 0;
let backend: 'webgpu' | 'wasm' | null = null;

export const detectorInfo = () => (session ? { size: inputSize, backend } : null);

export async function loadDetector(bytes: ArrayBuffer): Promise<{ size: number; backend: 'webgpu' | 'wasm' }> {
  await session?.release();
  session = null;
  const tries: ('webgpu' | 'wasm')[] = 'gpu' in navigator ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError: unknown;
  for (const ep of tries) {
    try {
      // logSeverityLevel 3: onnxruntime's notice that shape ops run on the CPU is not an error.
      const s = await ort.InferenceSession.create(new Uint8Array(bytes), { executionProviders: [ep], graphOptimizationLevel: 'all', logSeverityLevel: 3 });
      const meta = s.inputMetadata?.[0];
      const shape = meta && 'shape' in meta ? meta.shape : [];
      const size = Number(shape[2]);
      if (!(size > 0) || Number(shape[3]) !== size) throw new Error(`Unexpected detector input shape ${JSON.stringify(shape)}`);
      if (!s.outputNames.includes('heat') || !s.outputNames.includes('corners')) throw new Error(`The model has no heat/corners outputs (${s.outputNames.join(', ')})`);
      session = s;
      inputSize = size;
      backend = ep;
      return { size, backend: ep };
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Cards in the full photo (RGBA Mat), in its pixels, best first. */
export async function runDetector(cv: CV, full: Mat, threshold: number): Promise<DecodedCard[]> {
  if (!session) throw new Error('No detector loaded');
  const S = inputSize;
  const scale = S / Math.max(full.cols, full.rows);
  const w = Math.max(1, Math.round(full.cols * scale));
  const h = Math.max(1, Math.round(full.rows * scale));
  const small: Mat = new cv.Mat();
  try {
    cv.resize(full, small, new cv.Size(w, h), 0, 0, cv.INTER_AREA);
    const px: Uint8Array = small.data;
    const plane = S * S;
    const data = new Float32Array(3 * plane).fill(PAD / 255);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const p = (y * w + x) * 4;
        const i = y * S + x;
        data[i] = px[p] / 255;
        data[plane + i] = px[p + 1] / 255;
        data[2 * plane + i] = px[p + 2] / 255;
      }
    const input = new ort.Tensor('float32', data, [1, 3, S, S]);
    const out = await session.run({ [session.inputNames[0]]: input });
    input.dispose();
    const heat = out.heat;
    const corners = out.corners;
    const [gh, gw] = [heat.dims[2], heat.dims[3]];
    const cards = decodeDetector(heat.data as Float32Array, corners.data as Float32Array, gw, gh, { stride: STRIDE, threshold });
    for (const v of Object.values(out)) v.dispose();
    return cards.map((c) => ({ quad: scaleQuad(c.quad, 1 / scale), score: c.score }));
  } finally {
    free(small);
  }
}
