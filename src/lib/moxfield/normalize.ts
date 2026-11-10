/**
 * Moxfield collection API (`api2.moxfield.com/v1/collections/search`) → compact entries.
 * Runs in the Moxfield page (MAIN world) so only trimmed data crosses the message bridge.
 */

export type MoxFinish = 'nonFoil' | 'foil' | 'etched';

/** One row of the user's Moxfield collection, trimmed to what Tithies needs. */
export interface MoxEntry {
  id: string;
  qty: number;
  condition: string;
  finish: MoxFinish;
  lang: string;
  isProxy: boolean;
  isAlter: boolean;
  /** "paper", "mtgo" or "arena" when Moxfield says (collection rows only). */
  game?: string;
  card: MoxCard;
}

export interface MoxCard {
  id: string;
  scryfallId: string;
  set: string;
  setName: string;
  setType: string;
  name: string;
  /** Face names (front first). Single-faced cards have one entry. */
  faces: string[];
  /** Alternate printed name (Universes Beyond / Godzilla-style flavor name), e.g. "The Imperial City of Archades". */
  flavorName: string;
  cn: string;
  rarity: string;
  typeLine: string;
  isToken: boolean;
  /** Moxfield USD market price for each finish (TCGplayer), null when unknown. */
  usd: { nonFoil: number | null; foil: number | null; etched: number | null };
}

/** Collection entries aggregated by exact print + finish (conditions merged, NM is always used). */
export interface PrintGroup {
  key: string;
  qty: number;
  entryIds: string[];
  conditions: Record<string, number>;
  alters: number;
  finish: MoxFinish;
  card: MoxCard;
}

export interface CollectionPage {
  totalResults: number;
  totalPages: number;
  pageNumber: number;
  pageSize: number;
  data: unknown[];
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));

function toFinish(raw: unknown, isFoil: unknown): MoxFinish {
  if (raw === 'foil' || raw === 'etched' || raw === 'nonFoil') return raw;
  return isFoil ? 'foil' : 'nonFoil';
}

/** Normalises one raw `data[]` item. Returns null for anything that is not a usable paper card row. */
export function normalizeEntry(raw: any): MoxEntry | null {
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

/** Keeps English, non-proxy, paper rows; this feature ignores everything else. */
export function isEligible(e: MoxEntry): boolean {
  return e.lang === 'en' && !e.isProxy && e.qty > 0 && Boolean(e.card.set) && Boolean(e.card.cn);
}

export function printKey(set: string, cn: string, finish: MoxFinish): string {
  return `${set.toLowerCase()}|${cn.toLowerCase()}|${finish}`;
}

/** Groups eligible entries by exact print (set + collector number + finish). */
export function groupPrints(entries: MoxEntry[]): PrintGroup[] {
  const map = new Map<string, PrintGroup>();
  const seen = new Set<string>();
  for (const e of entries) {
    if (!isEligible(e) || (e.id && seen.has(e.id))) continue;
    if (e.id) seen.add(e.id);
    const key = printKey(e.card.set, e.card.cn, e.finish);
    let g = map.get(key);
    if (!g) {
      g = { key, qty: 0, entryIds: [], conditions: {}, alters: 0, finish: e.finish, card: e.card };
      map.set(key, g);
    }
    g.qty += e.qty;
    if (e.id) g.entryIds.push(e.id);
    g.conditions[e.condition] = (g.conditions[e.condition] ?? 0) + e.qty;
    if (e.isAlter) g.alters += e.qty;
  }
  return [...map.values()];
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
