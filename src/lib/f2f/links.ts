import { F2F_ORIGIN } from './api';

/**
 * F2F switches between its shop and sell ("buylist") views with a Shopify cart attribute `site`.
 * The site itself honours `?site=sell` on any URL. For the shop view Tithies adds `?tithies=shop`,
 * which our small facetofacegames.com content script turns into `site: 'shop'` the same way.
 */
export const SHOP_PARAM = 'tithies';

export const f2fLinks = {
  sellHome: `${F2F_ORIGIN}/pages/sell-your-cards`,
  sellBulk: `${F2F_ORIGIN}/collections/wholesale-bulk?site=sell`,
  sellMtg: `${F2F_ORIGIN}/collections/magic-the-gathering?site=sell`,
  shopHome: `${F2F_ORIGIN}/`,
  shopProduct: (handle: string) => `${F2F_ORIGIN}/products/${encodeURIComponent(handle)}?${SHOP_PARAM}=shop`,
  sellProduct: (handle: string) => `${F2F_ORIGIN}/products/${encodeURIComponent(handle)}?site=sell`,
  shopSearch: (q: string) => `${F2F_ORIGIN}/search?q=${encodeURIComponent(q)}&${SHOP_PARAM}=shop`,
};

export const scryfallCardLink = (set: string, cn: string) =>
  `https://scryfall.com/card/${encodeURIComponent(set)}/${encodeURIComponent(cn)}`;

export function scryfallImage(scryfallId: string, size: 'small' | 'normal' = 'small'): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(scryfallId)) return null;
  return `https://cards.scryfall.io/${size}/front/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`;
}
