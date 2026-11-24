/**
 * Moxfield API requests Tithies makes, and how they are answered. Requests always run inside a
 * logged-in Moxfield tab (see moxfield-hook.content.ts), so the session token never leaves the page.
 */
import type { CollectionEntry } from '@/lib/cards/types';
import { siteFail, type SiteRequest, type SiteResult } from '@/lib/sites/types';
import { MOX_API_ORIGIN, MOX_COLLECTION_PAGE_SIZE } from './constants';
import { normalizeDeckCards, normalizeDeckFolders, normalizeDeckList } from './decks';
import { binderFromAnswer, buildMoxMutation, deckFromAnswer, folderFromAnswer, importAnswer, normalizeBinderList, type BuiltMutation } from './mutations';
import { COLLECTION_SEARCH_PATH, normalizeEntry, type CollectionPage } from './normalize';

export const DECK_LIST_URL = `${MOX_API_ORIGIN}/v3/decks`;
/** Every deck folder, as Moxfield's own deck page asks for them (one page of up to 1000; it answers 100 per page). */
export const deckFoldersUrl = (pageNumber = 1) => `${MOX_API_ORIGIN}/v1/deck-folders?pageNumber=${pageNumber}&pageSize=1000`;
export const BINDER_LIST_URL = `${MOX_API_ORIGIN}/v1/trade-binders`;
/** Longest answer kept for the change log (characters). */
export const MAX_LOGGED_RESPONSE = 32_000;
export const deckUrl = (publicId: string) => `${MOX_API_ORIGIN}/v3/decks/all/${encodeURIComponent(publicId)}`;
export const isPublicId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(s);

/** The whole collection, no filters: the same query the collection page sends with every filter empty. */
export function wholeCollectionUrl(pageNumber: number, pageSize: number, newestFirst = false): string {
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
    ['sortType', newestFirst ? 'lastUpdated' : 'cardName'],
    ['sortDirection', newestFirst ? 'descending' : 'ascending'],
  ];
  for (const [k, v] of params) u.searchParams.append(k, v);
  return u.toString();
}

/**
 * One binder's cards: the search Moxfield's own binder page makes (`GET_TRADE_BINDER`,
 * `/v1/trade-binders/{publicId}/search`). (The collection search's `tradeBinderId` filter is
 * ignored: verified 2026-11-16, an unknown id returned the whole collection.)
 */
export function binderSearchUrl(publicId: string, pageNumber: number, pageSize: number): string {
  const u = new URL(`${MOX_API_ORIGIN}/v1/trade-binders/${encodeURIComponent(publicId)}/search`);
  for (const [k, v] of [
    ['pageNumber', String(pageNumber)],
    ['pageSize', String(pageSize)],
    ['sortType', 'cardName'],
    ['sortDirection', 'ascending'],
    ['pricingProvider', 'tcgplayer'],
  ])
    u.searchParams.append(k, v);
  return u.toString();
}

/** Validates an incoming request (it crosses a page boundary) and returns its URL, or null. */
export function requestUrl(req: unknown): string | null {
  if (!req || typeof req !== 'object') return null;
  const r = req as Record<string, unknown>;
  switch (r.kind) {
    case 'deckList':
      return DECK_LIST_URL;
    case 'deckFolders': {
      const page = Math.floor(Number(r.pageNumber));
      return page >= 1 ? deckFoldersUrl(page) : null;
    }
    case 'binders':
      return BINDER_LIST_URL;
    case 'deck':
      return isPublicId(r.publicId) ? deckUrl(r.publicId) : null;
    case 'collection': {
      const page = Math.floor(Number(r.pageNumber));
      const size = Math.floor(Number(r.pageSize));
      if (!(page >= 1) || !(size >= 1)) return null;
      return wholeCollectionUrl(page, Math.min(size, MOX_COLLECTION_PAGE_SIZE), r.newestFirst === true);
    }
    case 'binderPage': {
      const page = Math.floor(Number(r.pageNumber));
      const size = Math.floor(Number(r.pageSize));
      if (!(page >= 1) || !(size >= 1) || !isPublicId(r.publicId)) return null;
      return binderSearchUrl(r.publicId, page, Math.min(size, MOX_COLLECTION_PAGE_SIZE));
    }
    default:
      return null;
  }
}

/** How the page sends a write: method, headers of its own, and body (JSON or multipart). */
export interface WriteInit {
  method: BuiltMutation['method'];
  body?: string | FormData;
  /** Set for JSON bodies; multipart bodies let the browser set it (with its boundary). */
  contentType?: string;
  /** A deck change's own headers (they win over the session's). */
  headers?: Record<string, string>;
}

function writeInit(b: BuiltMutation): WriteInit {
  const headers = b.headers ? { headers: { ...b.headers } } : {};
  if (b.file) {
    const form = new FormData();
    form.append(b.file.field, new Blob([b.file.text], { type: b.file.type }), b.file.name);
    return { method: b.method, body: form, ...headers };
  }
  if (b.json !== undefined) return { method: b.method, body: JSON.stringify(b.json), contentType: 'application/json', ...headers };
  return { method: b.method, ...headers };
}

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** Moxfield's reasons for a refused write, when it gives them (`{"name":["Name must be between 2 and 100 characters."]}`). */
export function refusalReasons(text: string): string {
  const r = parse(text);
  if (!r || typeof r !== 'object' || Array.isArray(r)) return '';
  const out = Object.values(r as Record<string, unknown>).flatMap((v) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []));
  return out.slice(0, 3).map((m) => m.slice(0, 200)).join(' ');
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
  if (!res.ok) {
    const why = res.status >= 400 && res.status < 500 ? refusalReasons(text) : '';
    return { ...siteFail(res.status, 'http', `Moxfield answered HTTP ${res.status}${res.status === 429 ? ' (rate limited)' : ''}${why ? `: ${why}` : ''}`), response };
  }
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
  if (kind === 'importCsv') {
    let imported = null;
    try {
      imported = importAnswer(JSON.parse(text));
    } catch {
      /* an unexpected answer: the check after the export tells what was made */
    }
    return { ok: true, kind: 'mutate', status: res.status, response, ...(imported ? { imported } : {}) };
  }
  if (kind === 'addCard') {
    // A 2xx is the card added (the check after the export reads what was made).
    const count = (op as { quantity: number }).quantity;
    return { ok: true, kind: 'mutate', status: res.status, response, imported: { ok: true, count, errors: [] } };
  }
  if (kind === 'createDeckFolder') {
    const folder = folderFromAnswer(parse(text));
    if (!folder) return { ...siteFail(res.status, 'parse', "Moxfield created the folder but its answer didn't say which one"), response };
    return { ok: true, kind: 'mutate', status: res.status, response, folder: folder.path ? folder : { ...folder, path: (op as { name: string }).name.trim() } };
  }
  if (kind === 'createDeck' || kind === 'importDeck' || kind === 'addDeckCard') {
    const { deck, failed, errors } = deckFromAnswer(parse(text));
    // An added card's answer has no deck in it: Moxfield's own app reads the new version from this header.
    const header = Number(res.headers.get('x-deck-version') ?? NaN);
    if (deck.version === undefined && Number.isInteger(header) && header >= 0) deck.version = header;
    if (kind === 'createDeck' && failed) return { ...siteFail(res.status, 'http', `Moxfield didn't create the deck${errors.length ? `: ${errors.slice(0, 3).join('; ')}` : ''}`), response };
    if (kind === 'createDeck' && !deck.publicId) return { ...siteFail(res.status, 'parse', "Moxfield created the deck but its answer didn't say which one"), response };
    const imported = kind === 'addDeckCard' ? { ok: true, count: (op as { quantity: number }).quantity, errors: [] } : failed || errors.length ? { ok: !failed, count: 0, errors } : undefined;
    return { ok: true, kind: 'mutate', status: res.status, response, deck, ...(imported ? { imported } : {}) };
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
    case 'deckFolders':
      return { ok: true, kind: 'deckFolders', folders: normalizeDeckFolders(body), totalPages: Math.max(1, Math.floor(Number(body?.totalPages)) || 1) };
    case 'binders':
      return { ok: true, kind: 'binders', binders: normalizeBinderList(body) };
    case 'deck': {
      const { lastUpdatedAt, cards, id, version, tooBig } = normalizeDeckCards(body);
      return { ok: true, kind: 'deck', lastUpdatedAt, cards, ...(id ? { id } : {}), ...(version !== undefined ? { version } : {}), ...(tooBig ? { tooBig } : {}) };
    }
    case 'collection':
    case 'binderPage': {
      const p = body as CollectionPage;
      // A binder search says which binder once (`tradeBinder`): every card it lists is in it.
      const inBinder = req.kind === 'binderPage' ? (body as { tradeBinder?: { id?: unknown } })?.tradeBinder?.id : undefined;
      const entries: CollectionEntry[] = [];
      for (const raw of Array.isArray(p?.data) ? p.data : []) {
        const e = normalizeEntry(raw);
        if (e) entries.push(!e.binderId && typeof inBinder === 'string' ? { ...e, binderId: inBinder } : e);
      }
      const pageSize = Number(p?.pageSize) || req.pageSize;
      const totalResults = Number(p?.totalResults) || entries.length;
      const totalPages = Number(p?.totalPages) || Math.max(1, Math.ceil(totalResults / pageSize));
      // `totalOverall`: copies over every page (5,431 for 4,010 entries, verified 2026-11-16).
      const copies = Number((p as { totalOverall?: unknown })?.totalOverall);
      return { ok: true, kind: req.kind, entries, totalResults, totalPages, pageSize, ...(Number.isFinite(copies) ? { totalCopies: copies } : {}) };
    }
  }
}
