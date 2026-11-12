import { defineContentScript } from '#imports';
import { bridge, type CaptureInfo } from '@/lib/page-bridge';
import { moxFail, runMoxRequest, type MoxTabStatus } from '@/lib/moxfield/api';
import type { CollectionEntry } from '@/lib/cards/types';
import { isCollectionSearchUrl, normalizeEntry, withPaging, type CollectionPage } from '@/lib/moxfield/normalize';

const API_HOST = 'api2.moxfield.com';

/** Session headers worth replaying: the bearer token and Moxfield's own x-* headers. */
const pickAuthHeaders = (h: Record<string, string>): Record<string, string> | null => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (key === 'authorization' || key.startsWith('x-')) out[key] = v;
  }
  return out.authorization ? out : null;
};

/**
 * Runs in Moxfield's own JS world. It remembers the last collection-search request the page made
 * (URL = the filters you applied, headers = your session) and can replay it page by page. It also
 * remembers the session headers of the page's latest API request, so the extension can ask this
 * page to read decks and the whole collection (`api`). Nothing captured here is persisted or sent
 * anywhere except back to Moxfield's own API; only trimmed card data leaves the page.
 */
export default defineContentScript({
  matches: ['https://moxfield.com/*', 'https://www.moxfield.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    let captured: { url: string; headers: Record<string, string>; at: number } | null = null;
    let auth: { headers: Record<string, string>; at: number } | null = null;
    const origFetch = window.fetch.bind(window);

    const isApiUrl = (url: string) => {
      try {
        return new URL(url, location.href).hostname === API_HOST;
      } catch {
        return false;
      }
    };

    /** Keeps the newest session headers (the page refreshes its token by itself). */
    const noteAuth = (headers: Record<string, string>) => {
      const picked = pickAuthHeaders(headers);
      if (picked) auth = { headers: picked, at: Date.now() };
    };

    const info = (): CaptureInfo =>
      captured ? { hasCapture: true, url: captured.url, capturedAt: captured.at } : { hasCapture: false };

    const capture = (url: string, headers: Record<string, string>) => {
      const abs = new URL(url, location.href).toString();
      if (!isCollectionSearchUrl(abs)) return;
      captured = { url: abs, headers, at: Date.now() };
      void bridge.sendMessage('captureUpdated', info()).catch(() => {});
    };

    const headersToObject = (h: HeadersInit | undefined): Record<string, string> => {
      const out: Record<string, string> = {};
      if (!h) return out;
      new Headers(h).forEach((v, k) => {
        out[k] = v;
      });
      return out;
    };

    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (isApiUrl(url)) {
          const headers = { ...(input instanceof Request ? headersToObject(input.headers) : {}), ...headersToObject(init?.headers) };
          noteAuth(headers);
          if (url.includes('/collections/search')) capture(url, headers);
        }
      } catch {
        /* never break the page */
      }
      return origFetch(input as RequestInfo, init);
    };

    const xhrMeta = new WeakMap<XMLHttpRequest, { url: string; headers: Record<string, string> }>();
    const { open, setRequestHeader, send } = XMLHttpRequest.prototype;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      xhrMeta.set(this, { url: String(url), headers: {} });
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.setRequestHeader = function (this: XMLHttpRequest, name: string, value: string) {
      const m = xhrMeta.get(this);
      if (m) m.headers[name.toLowerCase()] = value;
      return setRequestHeader.call(this, name, value);
    };
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      try {
        const m = xhrMeta.get(this);
        if (m && isApiUrl(m.url)) {
          noteAuth(m.headers);
          if (m.url.includes('/collections/search')) capture(m.url, m.headers);
        }
      } catch {
        /* never break the page */
      }
      return send.call(this, body);
    };

    bridge.onMessage('getCaptureInfo', () => info());

    bridge.onMessage('getStatus', (): MoxTabStatus => ({ hasAuth: auth != null, authAt: auth?.at, path: location.pathname }));

    // One request per call: throttling, retries and progress live in the extension's background worker.
    bridge.onMessage('api', async ({ data }) => {
      if (!auth) return moxFail(0, 'no_auth', 'No Moxfield session in this tab yet: log in to Moxfield, or reload the page.');
      const headers = { ...auth.headers };
      return runMoxRequest(data, (url) => origFetch(url, { headers, credentials: 'include' }));
    });

    bridge.onMessage('fetchCollection', async ({ data }) => {
      if (!captured) throw new Error('No collection query seen yet. Reload the collection page and try again.');
      const { url, headers } = captured;
      const getPage = async (pageNumber: number, pageSize: number): Promise<CollectionPage> => {
        const res = await origFetch(withPaging(url, pageNumber, pageSize), { headers, credentials: 'include' });
        if (res.status === 401 || res.status === 403) throw new Error('Moxfield refused the request (session expired?). Reload the page and try again.');
        if (!res.ok) throw new Error(`Moxfield answered HTTP ${res.status}`);
        return res.json();
      };

      const entries: CollectionEntry[] = [];
      const first = await getPage(1, data.pageSize);
      // Moxfield may cap the page size: keep paging with whatever size it actually used.
      const size = first.pageSize || data.pageSize;
      const totalPages = first.totalPages || Math.ceil((first.totalResults || 0) / size) || 1;
      const push = (p: CollectionPage) => {
        for (const raw of p.data ?? []) {
          const e = normalizeEntry(raw);
          if (e) entries.push(e);
        }
      };
      push(first);
      void bridge.sendMessage('collectionProgress', { page: 1, totalPages, fetched: entries.length }).catch(() => {});
      for (let page = 2; page <= totalPages; page++) {
        await new Promise((r) => setTimeout(r, data.delayMs));
        push(await getPage(page, size));
        void bridge.sendMessage('collectionProgress', { page, totalPages, fetched: entries.length }).catch(() => {});
      }
      return { url, entries, totalResults: first.totalResults ?? entries.length, pages: totalPages };
    });
  },
});
