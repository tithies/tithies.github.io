/**
 * Shopify's own storefront endpoints on facetofacegames.com, used when F2F's search index
 * (prod-indexer) doesn't have a print. That index misses some live products, in blocks of
 * consecutive Shopify ids (verified 2026-11-11: about 45 Magic 2015 non-foils, e.g. #3 Avacyn,
 * Guardian Angel). Shopify's predictive search and product JSON still list them, with retail
 * prices, but not F2F's buy price: that one only shows on the sell-mode product page.
 * Both endpoints answer without cookies.
 */
import { F2F_ORIGIN, skuSetCode, type F2FDoc, type F2FVariant } from './api';

/** Results Shopify's predictive search returns at most. */
export const SUGGEST_LIMIT = 10;

export const suggestUrl = (q: string, limit = SUGGEST_LIMIT) =>
  `${F2F_ORIGIN}/search/suggest.json?q=${encodeURIComponent(q)}&resources%5Btype%5D=product&resources%5Blimit%5D=${limit}`;

export const productJsUrl = (handle: string) => `${F2F_ORIGIN}/products/${encodeURIComponent(handle)}.js`;

export interface SuggestProduct {
  id?: number;
  title?: string;
  handle?: string;
  type?: string;
  available?: boolean;
  image?: string | null;
}

export interface SuggestResponse {
  resources?: { results?: { products?: SuggestProduct[] } };
}

/** `/products/{handle}.js` (prices in cents, no stock counts). */
export interface ProductJs {
  id?: number;
  title?: string;
  handle?: string;
  featured_image?: string | null;
  variants?: { id?: number; title?: string; option1?: string | null; sku?: string | null; available?: boolean; price?: number }[];
}

/** F2F titles non-English singles "Twitching Doll - Japanese [2026-4] […]". */
const LANGUAGE_SUFFIX = / - (Japanese|French|German|Italian|Spanish|Portuguese|Korean|Russian|Chinese(?: Simplified| Traditional)?|Phyrexian)$/i;

export interface SinglesTitle {
  name: string;
  cn: string;
  setName: string;
  finish: string;
  language: string;
}

/**
 * "Avacyn, Guardian Angel [3] [Magic 2015] [Non-Foil]" → name, collector number, set, finish.
 * Variant tags ("[Showcase]", "[Borderless]") sit between the number and the set. Anything else
 * (sealed products, "… — ID 21301" scans) returns null.
 */
export function parseSinglesTitle(title: string): SinglesTitle | null {
  const m = /^(.*?)((?:\s\[[^\]]*\])+)$/.exec(title.trim());
  if (!m || !m[1].trim()) return null;
  const tags = [...m[2].matchAll(/\[([^\]]*)\]/g)].map((t) => t[1].trim());
  if (tags.length < 3) return null;
  const lang = LANGUAGE_SUFFIX.exec(m[1].trim());
  return {
    name: lang ? m[1].trim().slice(0, lang.index) : m[1].trim(),
    cn: tags[0],
    setName: tags[tags.length - 2],
    finish: tags[tags.length - 1],
    language: lang ? lang[1] : 'English',
  };
}

/** Singles among predictive-search results, as docs without variants. `total` counts every result. */
export function parseSuggest(json: SuggestResponse): { total: number; docs: F2FDoc[] } {
  const products = json?.resources?.results?.products;
  if (!Array.isArray(products)) throw new Error('Unexpected F2F response (no product results)');
  const docs = products.flatMap((p): F2FDoc[] => {
    if (!p?.title || !p.handle || (p.type && p.type !== 'Singles')) return [];
    const t = parseSinglesTitle(p.title);
    if (!t) return [];
    return [
      {
        id: `gid://shopify/Product/${p.id ?? p.handle}`,
        handle: p.handle,
        title: p.title,
        name: t.name,
        names: [t.name],
        setName: t.setName,
        skuSet: null,
        cn: t.cn,
        finish: t.finish,
        rarity: '',
        language: t.language,
        publishedF2FSell: false,
        image: p.image || null,
        variants: [],
        source: 'shopify',
      },
    ];
  });
  return { total: products.length, docs };
}

/** Language code in current SKUs (`SIN-MTG-{SET}-{CN}-{LANG}-{COND}-{FIN}`); older `M-…` SKUs have none. */
export function skuLanguage(sku: string | null | undefined): string | null {
  const parts = (sku ?? '').split('-');
  if (parts[0] !== 'SIN' || parts[1] !== 'MTG' || parts.length < 7) return null;
  const lang = parts[parts.length - 3];
  return /^[A-Z]{3}$/i.test(lang) ? lang.toUpperCase() : null;
}

/** Adds the conditions and retail prices from the product JSON. Stock is unknown (no counts there). */
export function withProductVariants(doc: F2FDoc, product: ProductJs): F2FDoc {
  const variants: F2FVariant[] = (product.variants ?? []).map((v) => ({
    condition: v.option1 ?? v.title ?? '',
    retail: typeof v.price === 'number' && v.price > 0 ? v.price / 100 : null,
    buy: null,
    stock: null,
    sku: v.sku ?? '',
  }));
  const sku = variants.find((v) => v.sku)?.sku;
  const lang = skuLanguage(sku);
  const image = doc.image ?? (product.featured_image ? product.featured_image.replace(/^\/\//, 'https://') : null);
  return {
    ...doc,
    skuSet: skuSetCode(sku),
    language: lang && lang !== 'ENG' ? lang : doc.language,
    image,
    variants,
  };
}
