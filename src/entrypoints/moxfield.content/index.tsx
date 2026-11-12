import { createShadowRootUi, defineContentScript, type ContentScriptContext } from '#imports';
import ReactDOM from 'react-dom/client';
import { onMessage } from '@/lib/messaging';
import { bridge } from '@/lib/sites/moxfield/bridge';
import { siteFail, type SiteResult, type SiteTabStatus } from '@/lib/sites/types';
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

/** Relays the background worker's Moxfield requests to the page hook (on every Moxfield page). */
function registerRelays() {
  const offline = (): SiteTabStatus => ({ hasAuth: false, path: location.pathname });
  onMessage('siteStatus', () => withTimeout(bridge.sendMessage('getStatus', undefined), 3000, offline));
  onMessage('siteApi', ({ data }) =>
    withTimeout<SiteResult>(bridge.sendMessage('api', data), 90_000, () => siteFail(0, 'timeout', 'Moxfield took too long to answer')),
  );
}

const isCollectionPage = (url: string | URL) => new URL(url).pathname.startsWith('/collection');

export default defineContentScript({
  matches: ['https://moxfield.com/*', 'https://www.moxfield.com/*'],
  cssInjectionMode: 'ui',
  async main(ctx: ContentScriptContext) {
    registerRelays();
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
