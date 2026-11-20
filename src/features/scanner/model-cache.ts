/**
 * Model files, downloaded once from Hugging Face (pinned revision) and kept in the page's Cache
 * Storage (`tithies-scanner-models`), so later visits load them from disk.
 */
import type { ModelFile } from './models';

export const MODEL_CACHE = 'tithies-scanner-models';

export async function isModelCached(file: ModelFile): Promise<boolean> {
  const cache = await caches.open(MODEL_CACHE);
  return !!(await cache.match(file.url));
}

/** The model's bytes: from the cache, else downloaded (with progress) and cached. */
export async function loadModelFile(file: ModelFile, onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<ArrayBuffer> {
  const cache = await caches.open(MODEL_CACHE);
  const hit = await cache.match(file.url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(file.url, { signal });
  if (!res.ok || !res.body) throw new Error(`Downloading ${file.label} failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || file.bytes;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let done = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    chunks.push(value);
    done += value.length;
    onProgress?.(done, total);
  }
  const bytes = new Uint8Array(done);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  await cache.put(file.url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }));
  return bytes.buffer;
}

/** Where a card detector file dropped on the page is kept (a made-up URL: Cache Storage keys are requests). */
export const DETECTOR_KEY = 'https://tithies.local/scanner/card-detector.onnx';

/** The card detector dropped on the page earlier, if any. */
export async function cachedDetector(): Promise<ArrayBuffer | null> {
  const hit = await (await caches.open(MODEL_CACHE)).match(DETECTOR_KEY);
  return hit ? hit.arrayBuffer() : null;
}

export async function cacheDetector(bytes: ArrayBuffer): Promise<void> {
  await (await caches.open(MODEL_CACHE)).put(DETECTOR_KEY, new Response(bytes.slice(0), { headers: { 'content-type': 'application/octet-stream' } }));
}

/** Where a tuned recognition model dropped on the page is kept (scanner-train/export_recog.py). */
export const RECOGNIZER_KEY = 'https://tithies.local/scanner/card-recognizer.onnx';

export async function cachedRecognizer(): Promise<ArrayBuffer | null> {
  const hit = await (await caches.open(MODEL_CACHE)).match(RECOGNIZER_KEY);
  return hit ? hit.arrayBuffer() : null;
}

export async function cacheRecognizer(bytes: ArrayBuffer): Promise<void> {
  await (await caches.open(MODEL_CACHE)).put(RECOGNIZER_KEY, new Response(bytes.slice(0), { headers: { 'content-type': 'application/octet-stream' } }));
}

/** Removes every cached model file. */
export async function clearModelCache(): Promise<void> {
  await caches.delete(MODEL_CACHE);
}
