/**
 * Moxfield API requests Tithies makes, and how they are answered. Requests always run inside a
 * logged-in Moxfield tab (see moxfield-hook.content.ts), so the session token never leaves the page.
 */
import type { CollectionEntry } from '@/lib/cards/types';
import { siteFail, type SiteRequest, type SiteResult } from '@/lib/sites/types';
import { MAX_COLLECTION_PAGE_SIZE, MOX_API_ORIGIN } from './constants';
import { normalizeDeckCards, normalizeDeckList } from './decks';
import { binderFromAnswer, buildMoxMutation, normalizeBinderList, type BuiltMutation } from './mutations';
import { COLLECTION_SEARCH_PATH, normalizeEntry, type CollectionPage } from './normalize';

export const DECK_LIST_URL = `${MOX_API_ORIGIN}/v3/decks`;
export const BINDER_LIST_URL = `${MOX_API_ORIGIN}/v1/trade-binders`;
/** Longest answer kept for the change log (characters). */
export const MAX_LOGGED_RESPONSE = 32_000;
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

/** Validates an incoming request (it crosses a page boundary) and returns its URL, or null. */
export function requestUrl(req: unknown): string | null {
  if (!req || typeof req !== 'object') return null;
  const r = req as Record<string, unknown>;
  switch (r.kind) {
    case 'deckList':
      return DECK_LIST_URL;
    case 'binders':
      return BINDER_LIST_URL;
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

/** How the page sends a write: method and body (JSON or multipart). */
export interface WriteInit {
  method: BuiltMutation['method'];
  body?: string | FormData;
  /** Set for JSON bodies; multipart bodies let the browser set it (with its boundary). */
  contentType?: string;
}

function writeInit(b: BuiltMutation): WriteInit {
  if (b.file) {
    const form = new FormData();
    form.append(b.file.field, new Blob([b.file.text], { type: b.file.type }), b.file.name);
    return { method: b.method, body: form };
  }
  if (b.json !== undefined) return { method: b.method, body: JSON.stringify(b.json), contentType: 'application/json' };
  return { method: b.method };
}

const clip = (s: string) => (s.length > MAX_LOGGED_RESPONSE ? `${s.slice(0, MAX_LOGGED_RESPONSE)}… (${s.length} characters)` : s);

/**
 * One write. Sent once: whatever happens, it is never sent again from here (the extension decides,
 * knowing whether the outcome is unknown). The answer's start comes back for the change log.
 */
async function runMoxWrite(op: unknown, doFetch: (url: string, init?: WriteInit) => Promise<Response>): Promise<SiteResult> {
  const built = buildMoxMutation(op);
  if (!built) return siteFail(0, 'bad_request', 'Unsupported Moxfield change');
  let res: Response;
  try {
    res = await doFetch(built.url, writeInit(built));
  } catch (e) {
    return siteFail(0, 'network', `Couldn't reach Moxfield (${e instanceof Error ? e.message : String(e)})`);
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    /* keep '' */
  }
  const response = clip(text);
  if (res.status === 401 || res.status === 403) return { ...siteFail(res.status, 'no_auth', 'Moxfield refused the change: log in to Moxfield, or reload the Moxfield tab.'), response };
  if (!res.ok) return { ...siteFail(res.status, 'http', `Moxfield answered HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`), response };
  const kind = (op as { op?: unknown }).op;
  if (kind === 'createBinder') {
    let binder = null;
    try {
      binder = binderFromAnswer(JSON.parse(text));
    } catch {
      /* handled below */
    }
    if (!binder) return { ...siteFail(res.status, 'parse', "Moxfield created the binder but its answer didn't say which one"), response };
    return { ok: true, kind: 'mutate', status: res.status, response, binder };
  }
  return { ok: true, kind: 'mutate', status: res.status, response };
}

/**
 * Performs one request with `doFetch` (the page's own fetch + session headers) and trims the answer.
 * Runs in the Moxfield page.
 */
export async function runMoxRequest(req: SiteRequest, doFetch: (url: string, init?: WriteInit) => Promise<Response>): Promise<SiteResult> {
  if (req && typeof req === 'object' && req.kind === 'mutate') return runMoxWrite(req.op, doFetch);
  const url = requestUrl(req);
  if (!url) return siteFail(0, 'bad_request', 'Unsupported Moxfield request');
  let res: Response;
  try {
    res = await doFetch(url);
  } catch (e) {
    return siteFail(0, 'network', `Couldn't reach Moxfield (${e instanceof Error ? e.message : String(e)})`);
  }
  if (res.status === 401 || res.status === 403) return siteFail(res.status, 'no_auth', 'Moxfield refused the request: log in to Moxfield, or reload the Moxfield tab.');
  if (!res.ok) return siteFail(res.status, 'http', `Moxfield answered HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`);
  let body: any;
  try {
    body = await res.json();
  } catch {
    return siteFail(res.status, 'parse', 'Moxfield sent an unreadable answer');
  }
  switch (req.kind) {
    case 'deckList':
      return { ok: true, kind: 'deckList', decks: normalizeDeckList(body) };
    case 'binders':
      return { ok: true, kind: 'binders', binders: normalizeBinderList(body) };
    case 'deck': {
      const { lastUpdatedAt, cards } = normalizeDeckCards(body);
      return { ok: true, kind: 'deck', lastUpdatedAt, cards };
    }
    case 'collection': {
      const p = body as CollectionPage;
      const entries: CollectionEntry[] = [];
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
