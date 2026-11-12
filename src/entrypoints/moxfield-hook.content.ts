import { defineContentScript } from '#imports';
import { bridge } from '@/lib/sites/moxfield/bridge';
import { MOX_API_HOST } from '@/lib/sites/moxfield/constants';
import { isLogoutPath, STARTUP_PATH } from '@/lib/sites/moxfield/identity';
import { MoxPageSession } from '@/lib/sites/moxfield/page-api';

/**
 * Runs in Moxfield's own JS world. It watches the API requests the page makes to know its
 * session (the newest login headers, and whose they are), remembers the last collection-search
 * request (URL = the filters you applied, headers = your session) so the panel can replay it page
 * by page, and makes the API requests the extension asks for (`api`). Nothing captured here is
 * persisted or sent anywhere except back to Moxfield's own API; only trimmed card data and the
 * account (user id + username) leave the page.
 */
export default defineContentScript({
  matches: ['https://moxfield.com/*', 'https://www.moxfield.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    const session = new MoxPageSession((info) => void bridge.sendMessage('sessionChanged', info).catch(() => {}));
    const origFetch = window.fetch.bind(window);
    const pageFetch = (url: string, headers: Record<string, string>) => origFetch(url, { headers, credentials: 'include' });

    const apiUrl = (url: string): URL | null => {
      try {
        const u = new URL(url, location.href);
        return u.hostname === MOX_API_HOST ? u : null;
      } catch {
        return null;
      }
    };

    const headersToObject = (h: HeadersInit | undefined): Record<string, string> => {
      const out: Record<string, string> = {};
      if (!h) return out;
      new Headers(h).forEach((v, k) => {
        out[k] = v;
      });
      return out;
    };

    /** Every page request to the API: follow the session, and capture collection searches. */
    const noteRequest = (u: URL, headers: Record<string, string>) => {
      session.noteRequest(headers);
      if (u.pathname.includes('/collections/search') && session.noteCollectionSearch(u.toString(), headers)) {
        void bridge.sendMessage('captureUpdated', session.captureInfo()).catch(() => {});
      }
    };

    /** The page's "Sign out" answered: the session ends here and, through the background, in every tab. */
    const noteLogout = () => {
      const identity = session.logout();
      void bridge.sendMessage('loggedOut', { identity }).catch(() => {});
    };

    /** The page's own token refresh / login (`startup/authenticated`) answered. */
    const noteStartup = (status: number, readBody: () => Promise<unknown>) => {
      void readBody()
        .catch(() => null)
        .then((body) => session.noteStartup(status, body));
    };

    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      let startup = false;
      let logout = false;
      try {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const u = apiUrl(url);
        if (u) {
          noteRequest(u, { ...(input instanceof Request ? headersToObject(input.headers) : {}), ...headersToObject(init?.headers) });
          startup = u.pathname === STARTUP_PATH;
          logout = isLogoutPath(u.pathname);
        }
      } catch {
        /* never break the page */
      }
      const p = origFetch(input as RequestInfo, init);
      if (startup) {
        void p.then(
          (res) => noteStartup(res.status, () => res.clone().json()),
          () => {},
        );
      }
      if (logout) void p.then(noteLogout, () => {});
      return p;
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
        const u = m && apiUrl(m.url);
        if (m && u) {
          noteRequest(u, m.headers);
          if (isLogoutPath(u.pathname)) this.addEventListener('load', noteLogout);
          if (u.pathname === STARTUP_PATH) {
            const xhr = this;
            xhr.addEventListener('load', () =>
              noteStartup(xhr.status, async () => {
                if (xhr.responseType === 'json') return xhr.response;
                if (xhr.responseType === '' || xhr.responseType === 'text') return JSON.parse(xhr.responseText);
                return null;
              }),
            );
          }
        }
      } catch {
        /* never break the page */
      }
      return send.call(this, body);
    };

    bridge.onMessage('getCaptureInfo', () => session.captureInfo());

    bridge.onMessage('getStatus', () => session.status(location.pathname));

    // Another tab signed out: the browser's Moxfield session is over here too.
    bridge.onMessage('dropSession', () => {
      session.logout();
      return true;
    });

    // One request per call: throttling, retries and progress live in the extension's background worker.
    bridge.onMessage('api', ({ data }) => session.api(data, pageFetch));

    bridge.onMessage('fetchCollection', ({ data }) =>
      session.readCapture(data, pageFetch, (p) => void bridge.sendMessage('collectionProgress', p).catch(() => {})),
    );
  },
});
