/**
 * Face to Face Games search API (Shopify app proxy in front of Elasticsearch).
 *
 * `/apps/prod-indexer/buy/search` is what F2F's own "sell your cards" mode calls. It returns the
 * same product docs as the shop index plus buy-only products (bulk lots). Every variant carries
 * both `price` (F2F retail) and `sellPrice` (what F2F pays you), so one request covers both sides.
 */

export const F2F_ORIGIN = 'https://facetofacegames.com';
export const F2F_BUY_SEARCH = `${F2F_ORIGIN}/apps/prod-indexer/buy/search`;

export const F2F_COLLECTIONS = {
  mtgSingles: '616193818996',
  mtgAll: '616193786228',
  wholesaleBulk: '616828141940',
} as const;

/** Mirrors the site's own encoding: values joined by `$^` (OR), then encodeURIComponent twice. */
export const encodeFacetValue = (values: string[]): string =>
  encodeURIComponent(encodeURIComponent(values.join('$^')));

export interface SearchParams {
  collection: string;
  pageSize: number;
  page?: number;
  keyword?: string;
  /** Facet name → accepted values (OR within a facet, AND across facets). */
  facets?: Record<string, string[]>;
  /** Include facet aggregations (e.g. the list of all set names) in the response. */
  withFacets?: boolean;
}

export function buildSearchUrl({ collection, pageSize, page = 1, keyword, facets = {}, withFacets = false }: SearchParams): string {
  let url = `${F2F_BUY_SEARCH}/collections/${collection}/pageSize/${pageSize}/page/${page}`;
  if (keyword) url += `/keyword/${encodeURIComponent(encodeURIComponent(keyword))}`;
  for (const [name, values] of Object.entries(facets)) {
    const clean = values.map((v) => v.trim()).filter(Boolean);
    if (clean.length) url += `/${encodeURIComponent(name)}/${encodeFacetValue(clean)}`;
  }
  return withFacets ? url : `${url}/withFacets/false`;
}

// ---------------------------------------------------------------------------------------------
// Raw response types (only the fields Tithies reads)

export interface RawVariant {
  id?: string;
  price?: number | string | null;
  sellPrice?: number | string | null;
  inventoryQuantity?: number | null;
  sku?: string | null;
  selectedOptions?: { name: string; value: string }[];
  image?: { url?: string | null } | null;
}

export interface RawDoc {
  title?: string;
  handle?: string;
  'Card Name'?: string | string[];
  General_Card_Name?: string;
  General_Card_Language?: string;
  MTG_Set_Name?: string;
  MTG_Collector_Number?: string | number;
  MTG_Foil_Option?: string;
  MTG_Rarity?: string;
  publishedF2FSell?: number | boolean;
  product_type?: string;
  media?: ({ url?: string } | null)[];
  variants?: RawVariant[];
}

export interface SearchResponse {
  hits?: { total?: { value?: number }; hits?: { _id?: string; _source?: RawDoc }[] };
  aggregations?: Record<string, { buckets?: { key: string; doc_count?: number }[] }>;
}

/** Bucket keys of one facet aggregation (e.g. every F2F set name for "Set"). */
export function parseFacetValues(json: SearchResponse, facet: string): string[] {
  const buckets = json?.aggregations?.[facet]?.buckets;
  if (!Array.isArray(buckets)) throw new Error(`Unexpected F2F response (no "${facet}" facet)`);
  return buckets.map((b) => b.key).filter((k): k is string => typeof k === 'string' && k.length > 0);
}

// ---------------------------------------------------------------------------------------------
// Trimmed doc stored in IndexedDB

export interface F2FVariant {
  condition: string;
  retail: number | null;
  buy: number | null;
  stock: number;
  sku: string;
}

export interface F2FDoc {
  id: string;
  handle: string;
  title: string;
  name: string;
  names: string[];
  setName: string;
  skuSet: string | null;
  cn: string;
  finish: string;
  rarity: string;
  language: string;
  publishedF2FSell: boolean;
  image: string | null;
  variants: F2FVariant[];
}

const toPrice = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number.parseFloat(v) : typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Extracts the set code from F2F SKUs. Two formats are in use:
 * `SIN-MTG-{SET}-{CN}-{LANG}-{COND}-{FIN}` (current) and `M-{SET}-{Name}-{CN}-{COND}-{FIN}` (older).
 */
export function skuSetCode(sku: string | null | undefined): string | null {
  if (!sku) return null;
  const parts = sku.split('-');
  if (parts[0] === 'SIN' && parts[1] === 'MTG' && parts[2]) return parts[2].toLowerCase();
  if (parts[0] === 'M' && parts[1]) return parts[1].toLowerCase();
  return null;
}

export function trimDoc(id: string, s: RawDoc): F2FDoc {
  const cardNames = Array.isArray(s['Card Name']) ? s['Card Name'] : s['Card Name'] ? [s['Card Name']] : [];
  const variants: F2FVariant[] = (s.variants ?? []).map((v) => ({
    condition: v.selectedOptions?.find((o) => o.name === 'Condition')?.value ?? v.selectedOptions?.[0]?.value ?? '',
    retail: toPrice(v.price),
    buy: toPrice(v.sellPrice),
    stock: Math.max(0, Number(v.inventoryQuantity ?? 0) || 0),
    sku: v.sku ?? '',
  }));
  const image = s.variants?.find((v) => v.image?.url)?.image?.url ?? s.media?.find((m) => m?.url)?.url ?? null;
  return {
    id,
    handle: s.handle ?? '',
    title: s.title ?? '',
    name: s.General_Card_Name ?? cardNames[0] ?? s.title ?? '',
    names: [...new Set([s.General_Card_Name, ...cardNames].filter((n): n is string => Boolean(n)))],
    setName: s.MTG_Set_Name ?? '',
    skuSet: skuSetCode(variants.find((v) => v.sku)?.sku),
    cn: s.MTG_Collector_Number == null ? '' : String(s.MTG_Collector_Number),
    finish: s.MTG_Foil_Option ?? '',
    rarity: s.MTG_Rarity ?? '',
    language: s.General_Card_Language ?? '',
    publishedF2FSell: s.publishedF2FSell === 1 || s.publishedF2FSell === true,
    image,
    variants,
  };
}

export function parseSearch(json: SearchResponse): { total: number; docs: F2FDoc[] } {
  const hits = json?.hits?.hits;
  if (!Array.isArray(hits)) throw new Error('Unexpected F2F response (no hits array)');
  return {
    total: json.hits?.total?.value ?? hits.length,
    docs: hits.filter((h) => h?._source).map((h) => trimDoc(h._id ?? '', h._source as RawDoc)),
  };
}

/** NM variant (falls back to the first variant). */
export const nmVariant = (doc: F2FDoc): F2FVariant | null =>
  doc.variants.find((v) => v.condition.toUpperCase() === 'NM') ?? doc.variants[0] ?? null;

/** Shopify CDN images accept a `width` query parameter. */
export function sizedImage(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.endsWith('shopify.com')) u.searchParams.set('width', String(width));
    return u.toString();
  } catch {
    return url;
  }
}
