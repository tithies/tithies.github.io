import { defineContentScript } from '#imports';
import { SHOP_PARAM } from '@/lib/f2f/links';

/**
 * F2F keeps "shop" vs "sell" mode in a cart attribute. The site handles `?site=sell` itself;
 * this mirrors it for `?tithies=shop` so Tithies "Buy" links always open the shop view.
 */
export default defineContentScript({
  matches: ['https://facetofacegames.com/*'],
  runAt: 'document_start',
  async main() {
    const params = new URLSearchParams(location.search);
    if (params.get(SHOP_PARAM) !== 'shop') return;
    params.delete(SHOP_PARAM);
    const clean = location.pathname + (params.size ? `?${params}` : '') + location.hash;
    try {
      const res = await fetch('/cart/update.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attributes: { site: 'shop' } }),
      });
      if (res.ok) location.replace(clean);
    } catch {
      /* leave the page as is */
    }
  },
});
