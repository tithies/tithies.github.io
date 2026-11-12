import { createShadowRootUi, defineContentScript, type ContentScriptContext } from '#imports';
import ReactDOM from 'react-dom/client';
import { onMessage, sendMessage } from '@/lib/messaging';
import { bridge } from '@/lib/sites/moxfield/bridge';
import { siteFail, type SiteIdentity, type SiteResult, type SiteTabStatus } from '@/lib/sites/types';
import { parseIdentity } from '@/lib/sites/validate';
import { Overlay } from './Overlay';
import './style.css';

/** A CustomEvent bridge call never settles when the other world isn't listening: always bound it. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout());
      },
    );
  });
}

/** The page world isn't trusted: keep only a well-formed account, else "unknown". */
const cleanStatus = (s: SiteTabStatus): SiteTabStatus => ({
  hasAuth: s?.hasAuth === true,
  identity: parseIdentity(s?.identity),
  authAt: typeof s?.authAt === 'number' ? s.authAt : undefined,
  path: typeof s?.path === 'string' ? s.path : location.pathname,
});

/** Relays the background worker's Moxfield requests to the page hook (on every Moxfield page). */
function registerRelays() {
  const offline = (): SiteTabStatus => ({ hasAuth: false, identity: null, path: location.pathname });
  onMessage('siteStatus', async () => cleanStatus(await withTimeout(bridge.sendMessage('getStatus', undefined), 3000, offline)));
  onMessage('siteDropSession', () => withTimeout(bridge.sendMessage('dropSession', undefined), 3000, () => false));
  onMessage('siteApi', async ({ data }) => {
    const res = await withTimeout<SiteResult>(bridge.sendMessage('api', data), 90_000, () => siteFail(0, 'timeout', 'Moxfield took too long to answer', null));
    return res && typeof res === 'object' ? { ...res, as: parseIdentity(res.as) } : res;
  });
}

/**
 * Tells the background which account this tab is logged in as (for the dashboard's "logged in"
 * dot and hints): once now, on every change the page hook reports, and "gone" when the page goes.
 */
function reportSessions() {
  const report = (hasAuth: boolean, identity: SiteIdentity | null) =>
    void sendMessage('siteSessionChanged', { type: 'moxfield', hasAuth, identity: hasAuth ? identity : null }).catch(() => {});
  void withTimeout(bridge.sendMessage('getStatus', undefined), 3000, () => null as SiteTabStatus | null).then((s) => {
    const c = s ? cleanStatus(s) : null;
    report(c?.hasAuth ?? false, c?.identity ?? null);
  });
  bridge.onMessage('sessionChanged', ({ data }) => report(data?.hasAuth === true, parseIdentity(data?.identity)));
  // Signed out here: the background ends the session of the other Moxfield tabs too.
  bridge.onMessage('loggedOut', () => void sendMessage('siteLoggedOut', { type: 'moxfield' }).catch(() => {}));
  window.addEventListener('pagehide', () => report(false, null));
  window.addEventListener('pageshow', (e) => {
    // Back/forward cache: the page (and its session) came back.
    if (!e.persisted) return;
    void bridge
      .sendMessage('getStatus', undefined)
      .then((st) => {
        const c = cleanStatus(st);
        report(c.hasAuth, c.identity ?? null);
      })
      .catch(() => {});
  });
}

const isCollectionPage = (url: string | URL) => new URL(url).pathname.startsWith('/collection');

export default defineContentScript({
  matches: ['https://moxfield.com/*', 'https://www.moxfield.com/*'],
  cssInjectionMode: 'ui',
  async main(ctx: ContentScriptContext) {
    registerRelays();
    reportSessions();
    const ui = await createShadowRootUi<ReactDOM.Root>(ctx, {
      name: 'tithies-overlay',
      position: 'inline',
      anchor: 'body',
      append: 'last',
      onMount(container) {
        const root = ReactDOM.createRoot(container);
        root.render(<Overlay />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });

    const sync = (url: string | URL) => {
      if (isCollectionPage(url)) {
        if (!ui.mounted) ui.mount();
      } else if (ui.mounted) {
        ui.remove();
      }
    };
    sync(location.href);
    // Moxfield is a single-page app.
    ctx.addEventListener(window, 'wxt:locationchange', ({ newUrl }) => sync(newUrl));
  },
});
