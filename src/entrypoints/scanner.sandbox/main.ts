/**
 * The Scanner's engine: a sandboxed page (manifest `sandbox.pages`) the Scanner page loads in a
 * hidden iframe. Sandboxed pages may build functions from strings, which OpenCV.js and
 * onnxruntime-web need; they have no storage, no extension APIs and an opaque origin, so the page
 * sends every byte in (photos, model, WebAssembly) and keeps every result. Requests run one at a
 * time, in order.
 */
import { detectCards } from '@/features/scanner/engine/detect';
import { bench, currentBackend, featuresMany, initOrt, loadModel, matToImageData, ortVersion, toCardSize, warpCard } from '@/features/scanner/engine/features';
import { free, loadOpenCv, type CV, type Mat } from '@/features/scanner/engine/opencv';
import { quadSize } from '@/features/scanner/geometry';
import { CHANNEL, type CardFeatures, type EngineCall, type EngineReply, type EngineRequest, type EngineResults, type Features } from '@/features/scanner/protocol';

interface Photo {
  full: Mat;
  width: number;
  height: number;
}

const photos = new Map<string, Photo>();
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

const featureBuffers = (f: Features): ArrayBuffer[] => [...Object.values(f.vectors).map((v) => v.buffer as ArrayBuffer), f.phash.buffer as ArrayBuffer];

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
      const scale = Math.max(1, Math.max(p.width, p.height) / req.options.maxSide);
      const small = new c.Mat();
      try {
        if (scale > 1) c.resize(p.full, small, new c.Size(Math.round(p.width / scale), Math.round(p.height / scale)), 0, 0, c.INTER_AREA);
        else p.full.copyTo(small);
        const out = detectCards(c, small, scale, req.options.debug);
        const edges = out.edges ? await createImageBitmap(out.edges) : undefined;
        const result: EngineResults['detect'] = { width: p.width, height: p.height, cards: out.cards, rejected: out.rejected, edges, ms: performance.now() - t0 };
        return { result, transfer: edges ? [edges] : [] };
      } finally {
        free(small);
      }
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
