/**
 * Moxfield API requests Tithies makes, and how they are answered. Requests always run inside a
 * logged-in Moxfield tab (see moxfield-hook.content.ts), so the session token never leaves the page.
 */
import { normalizeDeckCards, normalizeDeckList, type DeckCard, type DeckSummary } from './decks';
import { COLLECTION_SEARCH_PATH, normalizeEntry, type CollectionPage, type MoxEntry } from './normalize';

export const MOX_API_ORIGIN = 'https://api2.moxfield.com';
export const MOX_TAB_PATTERNS = ['https://moxfield.com/*', 'https://www.moxfield.com/*'];
/** Page Tithies opens when it needs a Moxfield tab (any logged-in page works). */
export const MOX_SYNC_TAB_URL = 'https://moxfield.com/decks/personal';
/** Largest collection page Moxfield accepts (verified 2026-11-09). */
export const MAX_COLLECTION_PAGE_SIZE = 5000;

export const DECK_LIST_URL = `${MOX_API_ORIGIN}/v3/decks`;
export const deckUrl = (publicId: string) => `${MOX_API_ORIGIN}/v3/decks/all/${encodeURIComponent(publicId)}`;
export const isPublicId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(s);

/** The whole collection, no filters: the same query the collection page sends with every filter empty. */
export function wholeCollectionUrl(pageNumber: number, pageSize: number): string {
  const u = new URL(MOX_API_ORIGIN + COLLECTION_SEARCH_PATH);
  const params: [string, string][] = [
    ['q', ' '],
    ['setId', ''],
    ['deckId', ''],
    ['rarity', ''],
    ['condition', ''],
    ['game', ''],
    ['cardLanguageId', ''],
    ['finish', ''],
    ['isAlter', ''],
    ['isProxy', ''],
    ['tradeBinderId', ''],
    ['pricingProvider', 'tcgplayer'],
    ['priceMinimum', ''],
    ['priceMaximum', ''],
    ['pageNumber', String(pageNumber)],
    ['pageSize', String(pageSize)],
    ['sortType', 'cardName'],
    ['sortDirection', 'ascending'],
  ];
  for (const [k, v] of params) u.searchParams.append(k, v);
  return u.toString();
}

export type MoxApiRequest =
  | { kind: 'deckList' }
  | { kind: 'deck'; publicId: string }
  | { kind: 'collection'; pageNumber: number; pageSize: number };

export type MoxErrorCode = 'no_auth' | 'http' | 'network' | 'parse' | 'timeout' | 'no_tab' | 'tab_lost' | 'bad_request';

export interface MoxApiFailure {
  ok: false;
  /** HTTP status (0 when no response). */
  status: number;
  code: MoxErrorCode;
  message: string;
}

export type MoxApiSuccess =
  | { ok: true; kind: 'deckList'; decks: DeckSummary[] }
  | { ok: true; kind: 'deck'; lastUpdatedAt: string; cards: DeckCard[] }
  | { ok: true; kind: 'collection'; entries: MoxEntry[]; totalResults: number; totalPages: number; pageSize: number };

/** Results are returned, never thrown: status codes don't survive a thrown error across the messaging layers. */
export type MoxApiResult = MoxApiSuccess | MoxApiFailure;

/** What a Moxfield tab can do right now. */
export interface MoxTabStatus {
  /** The page has made an authenticated API request, so Tithies can make its own. */
  hasAuth: boolean;
  authAt?: number;
  path: string;
}

export const moxFail = (status: number, code: MoxErrorCode, message: string): MoxApiFailure => ({ ok: false, status, code, message });

/** Validates an incoming request (it crosses a page boundary) and returns its URL, or null. */
export function requestUrl(req: unknown): string | null {
  if (!req || typeof req !== 'object') return null;
  const r = req as Record<string, unknown>;
  switch (r.kind) {
    case 'deckList':
      return DECK_LIST_URL;
    case 'deck':
      return isPublicId(r.publicId) ? deckUrl(r.publicId) : null;
    case 'collection': {
      const page = Math.floor(Number(r.pageNumber));
      const size = Math.floor(Number(r.pageSize));
      if (!(page >= 1) || !(size >= 1)) return null;
      return wholeCollectionUrl(page, Math.min(size, MAX_COLLECTION_PAGE_SIZE));
    }
    default:
      return null;
  }
}

/**
 * Performs one request with `doFetch` (the page's own fetch + session headers) and trims the answer.
 * Runs in the Moxfield page.
 */
export async function runMoxRequest(req: MoxApiRequest, doFetch: (url: string) => Promise<Response>): Promise<MoxApiResult> {
  const url = requestUrl(req);
  if (!url) return moxFail(0, 'bad_request', 'Unsupported Moxfield request');
  let res: Response;
  try {
    res = await doFetch(url);
  } catch (e) {
    return moxFail(0, 'network', `Couldn't reach Moxfield (${e instanceof Error ? e.message : String(e)})`);
  }
  if (res.status === 401 || res.status === 403) return moxFail(res.status, 'no_auth', 'Moxfield refused the request: log in to Moxfield, or reload the Moxfield tab.');
  if (!res.ok) return moxFail(res.status, 'http', `Moxfield answered HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
  let body: any;
  try {
    body = await res.json();
  } catch {
    return moxFail(res.status, 'parse', 'Moxfield sent an unreadable answer');
  }
  switch (req.kind) {
    case 'deckList':
      return { ok: true, kind: 'deckList', decks: normalizeDeckList(body) };
    case 'deck': {
      const { lastUpdatedAt, cards } = normalizeDeckCards(body);
      return { ok: true, kind: 'deck', lastUpdatedAt, cards };
    }
    case 'collection': {
      const p = body as CollectionPage;
      const entries: MoxEntry[] = [];
      for (const raw of Array.isArray(p?.data) ? p.data : []) {
        const e = normalizeEntry(raw);
        if (e) entries.push(e);
      }
      const pageSize = Number(p?.pageSize) || req.pageSize;
      const totalResults = Number(p?.totalResults) || entries.length;
      const totalPages = Number(p?.totalPages) || Math.max(1, Math.ceil(totalResults / pageSize));
      return { ok: true, kind: 'collection', entries, totalResults, totalPages, pageSize };
    }
  }
}
