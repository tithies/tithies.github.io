/**
 * The search worker: holds the every-print index and searches it (search-core.ts), off the page's main thread.
 * Messages: search-client.ts.
 */
import { SearchCore } from './search-core';
import type { SearchReply, SearchRequest } from './search-client';

const core = new SearchCore();

self.onmessage = async (e: MessageEvent<{ id: number; request: SearchRequest }>) => {
  const { id, request } = e.data;
  try {
    let result: unknown;
    if (request.type === 'load') result = await core.load(request.bin, { gpu: request.gpu });
    else if (request.type === 'mask') result = core.setMask(request.mask) ?? null;
    else result = await core.search(request.queries, request.k);
    (self as unknown as Worker).postMessage({ id, ok: true, result } satisfies SearchReply);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: (err as Error).message } satisfies SearchReply);
  }
};
