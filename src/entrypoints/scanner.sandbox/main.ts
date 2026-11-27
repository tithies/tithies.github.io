/**
 * The Scanner's engine: a sandboxed page (manifest `sandbox.pages`) the Scanner page loads in a
 * hidden iframe. Sandboxed pages may build functions from strings, which OpenCV.js and
 * onnxruntime-web need; they have no storage, no extension APIs and an opaque origin, so the page
 * sends every byte in (photos, model, WebAssembly) and keeps every result. Requests run one at a
 * time, in order.
 */
import { bench, currentBackend, featuresMany, initOrt, loadModel, matToImageData, ortVersion, toCardSize, warpCard } from '@/features/scanner/engine/features';
import { loadDetector, runDetector } from '@/features/scanner/engine/detector';
import { free, loadOpenCv, type CV, type Mat } from '@/features/scanner/engine/opencv';
import { CHECK_H, CHECK_W, visualCheck } from '@/features/scanner/engine/print-visual';
import { cropBox, detectText, loadTextModel, recognize, warmText, type TextBox } from '@/features/scanner/engine/text';
import { quadSize } from '@/features/scanner/geometry';
import { CHANNEL, type CardFeatures, type DetectedCard, type EngineCall, type EngineReply, type EngineRequest, type EngineResults, type Features } from '@/features/scanner/protocol';

interface Photo {
  full: Mat;
  width: number;
  height: number;
}

const photos = new Map<string, Photo>();

/** Cards cut out for the print and language checks: the 672 × 936 cut-out, and its text lines once found. */
interface Detail {
  card: Mat;
  boxes?: TextBox[];
  crops?: Mat[];
}
const details = new Map<string, Detail>();

function detail(id: string): Detail {
  const d = details.get(id);
  if (!d) throw new Error(`Unknown card cut-out ${id}`);
  return d;
}

/** A box's place on the cut-out, as shares of it (the trainer's: y the mean, x the leftmost, h left side's height). */
function boxGeo(p: [number, number][]) {
  return {
    y: p.reduce((s2, q) => s2 + q[1], 0) / 4 / CHECK_H,
    x: Math.min(...p.map((q) => q[0])) / CHECK_W,
    h: (p[3][1] - p[0][1]) / CHECK_H,
  };
}

function dropDetail(id: string) {
  const d = details.get(id);
  if (d) free(d.card, ...(d.crops ?? []));
  details.delete(id);
}
let cv: CV | null = null;
let imageLogs = 12;

function bitmapToMat(c: CV, bitmap: ImageBitmap): Mat {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();
  return c.matFromImageData(data);
}

function needCv(): CV {
  if (!cv) throw new Error('The engine is not started');
  return cv;
}

function photo(id: string): Photo {
  const p = photos.get(id);
  if (!p) throw new Error(`Unknown photo ${id}`);
  return p;
}

const featureBuffers = (f: Features): ArrayBuffer[] => Object.values(f.vectors).map((v) => v.buffer as ArrayBuffer);

type Handled<T extends EngineRequest['type']> = { result: EngineResults[T]; transfer?: Transferable[] };

async function handle(req: EngineRequest): Promise<Handled<EngineRequest['type']>> {
  switch (req.type) {
    case 'init': {
      ({ cv } = await loadOpenCv());
      initOrt(req.ortWasm);
      const result: EngineResults['init'] = {
        opencv: String(cv.getBuildInformation?.().match(/OpenCV (\d+\.\d+\.\d+)/)?.[1] ?? '4.x'),
        ort: ortVersion(),
        webgpu: 'gpu' in navigator && !!(await (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null)),
        backend: currentBackend(),
      };
      return { result };
    }
    case 'loadModel': {
      const t0 = performance.now();
      const backend = await loadModel(req.bytes);
      return { result: { backend, ms: performance.now() - t0 } };
    }
    case 'loadDetector': {
      const t0 = performance.now();
      const r = await loadDetector(req.bytes);
      return { result: { ...r, ms: performance.now() - t0 } };
    }
    case 'loadPhoto': {
      const c = needCv();
      const old = photos.get(req.photoId);
      if (old) free(old.full);
      const { width, height } = req.bitmap;
      photos.set(req.photoId, { full: bitmapToMat(c, req.bitmap), width, height });
      return { result: { width, height } };
    }
    case 'detect': {
      const c = needCv();
      const t0 = performance.now();
      const p = photo(req.photoId);
      const cards: DetectedCard[] = (await runDetector(c, p.full, req.options.modelThreshold)).map((f) => ({ quad: f.quad, score: f.score, source: 'model' }));
      const result: EngineResults['detect'] = { width: p.width, height: p.height, cards, ms: performance.now() - t0 };
      return { result };
    }
    case 'cardFeatures': {
      const c = needCv();
      const t0 = performance.now();
      const full = photo(req.photoId).full;
      const mats: Mat[] = [];
      try {
        // Each card upright and turned 180°: [card 1, card 1 turned, card 2, …].
        for (const quad of req.quads) {
          const card = warpCard(c, full, quad);
          const turned = new c.Mat();
          c.rotate(card, turned, c.ROTATE_180);
          mats.push(card, turned);
        }
        const feats = await featuresMany(c, mats);
        const cards: CardFeatures[] = [];
        for (let i = 0; i < req.quads.length; i++) {
          const crop = await createImageBitmap(matToImageData(c, mats[2 * i]));
          cards.push({ crop, heightPx: quadSize(req.quads[i]).h, upright: feats[2 * i], turned: feats[2 * i + 1] });
        }
        const transfer = cards.flatMap((x) => [x.crop, ...featureBuffers(x.upright), ...featureBuffers(x.turned)]);
        return { result: { cards, ms: performance.now() - t0 }, transfer };
      } finally {
        free(...mats);
      }
    }
    case 'imageFeatures': {
      const c = needCv();
      const t0 = performance.now();
      const mats: Mat[] = [];
      try {
        for (const bitmap of req.bitmaps) {
          const rgba = bitmapToMat(c, bitmap);
          mats.push(toCardSize(c, rgba));
          free(rgba);
        }
        const features = await featuresMany(c, mats);
        const ms = performance.now() - t0;
        if (imageLogs-- > 0) console.info(`[scanner] imageFeatures: ${req.bitmaps.length} images in ${Math.round(ms)} ms`);
        return { result: { features, ms }, transfer: features.flatMap(featureBuffers) };
      } finally {
        free(...mats);
      }
    }
    case 'bench':
      return { result: await bench(req) };
    case 'loadTextModel': {
      needCv();
      const t0 = performance.now();
      const backend = await loadTextModel(req.name, req.bytes, req.chars, req.prefer);
      return { result: { backend, ms: performance.now() - t0 } };
    }
    case 'cardDetail': {
      const c = needCv();
      const t0 = performance.now();
      dropDetail(req.detailId);
      details.set(req.detailId, { card: warpCard(c, photo(req.photoId).full, req.quad, CHECK_W, CHECK_H) });
      return { result: { ms: performance.now() - t0 } };
    }
    case 'findText': {
      const c = needCv();
      const t0 = performance.now();
      const d = detail(req.detailId);
      if (!d.boxes) {
        d.boxes = await detectText(c, d.card);
        d.crops = d.boxes.map((b) => cropBox(c, d.card, b.pts));
      }
      return { result: { boxes: d.boxes.map((b) => boxGeo(b.pts)), ms: performance.now() - t0 } };
    }
    case 'readText': {
      const c = needCv();
      const t0 = performance.now();
      const d = detail(req.detailId);
      if (!d.boxes || !d.crops) throw new Error('findText first');
      const reads = await recognize(c, req.model, req.lines.map((i) => d.crops![i]));
      const lines = req.lines.map((i, k) => ({ ...boxGeo(d.boxes![i].pts), text: reads[k].text, conf: reads[k].conf }));
      return { result: { lines, ms: performance.now() - t0 } };
    }
    case 'checkPrint': {
      const c = needCv();
      const t0 = performance.now();
      const d = detail(req.detailId);
      const pics = req.pictures.map((b) => bitmapToMat(c, b));
      try {
        const r = visualCheck(c, d.card, pics);
        return { result: { ...r, ms: performance.now() - t0 } };
      } finally {
        free(...pics);
      }
    }
    case 'warmText': {
      const c = needCv();
      const t0 = performance.now();
      await warmText(c, req.model, req.widths);
      return { result: { ms: performance.now() - t0 } };
    }
    case 'releaseDetail': {
      if (req.detailId) dropDetail(req.detailId);
      else for (const id of [...details.keys()]) dropDetail(id);
      return { result: null };
    }
    case 'releasePhoto': {
      const p = photos.get(req.photoId);
      if (p) free(p.full);
      photos.delete(req.photoId);
      return { result: null };
    }
  }
}

let queue: Promise<unknown> = Promise.resolve();

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const msg = e.data as EngineCall;
  if (msg?.channel !== CHANNEL || typeof msg.id !== 'number') return;
  queue = queue.then(async () => {
    let reply: EngineReply;
    let transfer: Transferable[] = [];
    try {
      const out = await handle(msg.request);
      reply = { channel: CHANNEL, id: msg.id, ok: true, result: out.result };
      transfer = out.transfer ?? [];
    } catch (err) {
      reply = { channel: CHANNEL, id: msg.id, ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
    }
    // The parent is the Scanner page; a sandboxed page has an opaque origin, so '*' is the only target it can name.
    window.parent.postMessage(reply, '*', transfer);
  });
});

window.parent.postMessage({ channel: CHANNEL, hello: true }, '*');
