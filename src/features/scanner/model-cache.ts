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

/** Removes every cached model file. */
export async function clearModelCache(): Promise<void> {
  await caches.delete(MODEL_CACHE);
}
