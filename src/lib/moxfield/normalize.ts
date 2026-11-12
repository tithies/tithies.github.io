/**
 * Moxfield collection API (`api2.moxfield.com/v1/collections/search`) → compact entries.
 * Runs in the Moxfield page (MAIN world) so only trimmed data crosses the message bridge.
 */
import type { CollectionEntry, Finish } from '@/lib/cards/types';

export interface CollectionPage {
  totalResults: number;
  totalPages: number;
  pageNumber: number;
  pageSize: number;
  data: unknown[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

function toFinish(raw: unknown, isFoil: unknown): Finish {
  if (raw === 'foil' || raw === 'etched' || raw === 'nonFoil') return raw;
  return isFoil ? 'foil' : 'nonFoil';
}

/** Normalises one raw `data[]` item. Returns null for anything that is not a usable paper card row. */
export function normalizeEntry(raw: any): CollectionEntry | null {
  if (!raw || typeof raw !== 'object' || !raw.card) return null;
  const c = raw.card;
  const name = str(c.name);
  const faceNames: string[] = Array.isArray(c.card_faces)
    ? c.card_faces.map((f: any) => str(f?.name)).filter(Boolean)
    : [];
  const faces = faceNames.length ? faceNames : name.split(' // ').map((s) => s.trim()).filter(Boolean);
  const faceFlavor = Array.isArray(c.card_faces) ? str(c.card_faces[0]?.flavor_name) : '';
  const prices = c.prices ?? {};
  return {
    id: str(raw.id),
    qty: num(raw.quantity) ?? 1,
    condition: str(raw.condition) || 'nearMint',
    finish: toFinish(raw.finish, raw.isFoil),
    lang: str(raw.language?.code ?? c.lang ?? 'en').toLowerCase(),
    isProxy: Boolean(raw.isProxy),
    isAlter: Boolean(raw.isAlter),
    game: raw.game == null || raw.game === '' ? undefined : str(raw.game).toLowerCase(),
    card: {
      id: str(c.id),
      scryfallId: str(c.scryfall_id),
      set: str(c.set).toLowerCase(),
      setName: str(c.set_name),
      setType: str(c.set_type),
      name,
      faces: faces.length ? faces : [name],
      flavorName: str(c.flavor_name) || faceFlavor,
      cn: str(c.cn),
      rarity: str(raw.rarity || c.rarity).toLowerCase(),
      typeLine: str(c.type_line),
      isToken: Boolean(c.isToken),
      usd: { nonFoil: num(prices.usd), foil: num(prices.usd_foil), etched: num(prices.usd_etched) },
    },
  };
}

const IGNORED_QUERY_KEYS = new Set(['pageNumber', 'pageSize', 'sortType', 'sortDirection', 'pricingProvider']);

/** The filters the user applied on Moxfield, as a readable summary (empty = whole collection). */
export function describeQuery(url: string): { query: Record<string, string>; summary: string } {
  const query: Record<string, string> = {};
  try {
    new URL(url).searchParams.forEach((v, k) => {
      if (!IGNORED_QUERY_KEYS.has(k) && v.trim() !== '') query[k] = v.trim();
    });
  } catch {
    /* ignore malformed */
  }
  const summary = Object.entries(query)
    .map(([k, v]) => (k === 'q' ? `"${v}"` : `${k}=${v}`))
    .join(', ');
  return { query, summary: summary || 'Whole collection' };
}

export const COLLECTION_SEARCH_PATH = '/v1/collections/search';

export function isCollectionSearchUrl(url: string): boolean {
  try {
    const u = new URL(url, 'https://moxfield.com');
    return u.hostname === 'api2.moxfield.com' && u.pathname === COLLECTION_SEARCH_PATH;
  } catch {
    return false;
  }
}

export function withPaging(url: string, pageNumber: number, pageSize: number): string {
  const u = new URL(url);
  u.searchParams.set('pageNumber', String(pageNumber));
  u.searchParams.set('pageSize', String(pageSize));
  return u.toString();
}
