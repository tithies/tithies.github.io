/**
 * What Tithies' own card data doesn't keep, read from Scryfall's public API by the dashboard
 * (CORS is open, only card ids are sent): a print's color identity and rarity, and which set a set
 * belongs to (its parent: FIC "Final Fantasy Commander" → FIN "Final Fantasy").
 *
 * Scryfall's sets have `parent_set_code`, sometimes two levels deep (verified 2026-11-24:
 * atrc → trc → trk; fic, pfin, tfin, afin, fca → fin; big → otj; rex → lci).
 */
import { db } from '@/lib/db';

export const SCRYFALL_API = 'https://api.scryfall.com';
/** Identifiers per /cards/collection request (Scryfall's limit). */
export const COLLECTION_MAX = 75;
/** Scryfall asks for 50–100 ms between requests. */
const GAP_MS = 120;
/** The set list is kept a day. */
export const SETS_TTL_MS = 24 * 3600_000;

/** One Scryfall set, trimmed. */
export interface ScryfallSet {
  code: string;
  name: string;
  /** `parent_set_code`, when it has one. */
  parent?: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchFn = (input, init) => fetch(input, init);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('Aborted', 'AbortError'))), { once: true });
  });

/**
 * `POST /cards/collection`, 75 identifiers at a time, one request after another. Cards Scryfall
 * doesn't know are left out (its `not_found`).
 */
export async function scryfallCollection<T>(
  identifiers: readonly object[],
  signal?: AbortSignal,
  fetchFn: FetchFn = defaultFetch,
  onProgress?: (done: number, total: number) => void,
): Promise<T[]> {
  const out: T[] = [];
  const total = Math.ceil(identifiers.length / COLLECTION_MAX);
  for (let i = 0; i < identifiers.length; i += COLLECTION_MAX) {
    if (i) await sleep(GAP_MS, signal);
    const res = await fetchFn(`${SCRYFALL_API}/cards/collection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers: identifiers.slice(i, i + COLLECTION_MAX) }),
      signal,
    });
    if (!res.ok) throw new Error(`Scryfall answered HTTP ${res.status}`);
    out.push(...(((await res.json()) as { data?: T[] }).data ?? []));
    onProgress?.(i / COLLECTION_MAX + 1, total);
  }
  return out;
}

/** `GET /sets` → every set (code, name, parent). */
export function parseSets(raw: unknown): ScryfallSet[] {
  const data = (raw as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const out: ScryfallSet[] = [];
  for (const s of data) {
    const code = typeof s?.code === 'string' ? s.code.toLowerCase() : '';
    const name = typeof s?.name === 'string' ? s.name : '';
    if (!code || !name) continue;
    const parent = typeof s.parent_set_code === 'string' && s.parent_set_code ? s.parent_set_code.toLowerCase() : undefined;
    out.push({ code, name, ...(parent ? { parent } : {}) });
  }
  return out;
}

/**
 * Every Scryfall set, from the day-old copy when there is one. When Scryfall can't be reached, an
 * older copy is used; with none at all this throws.
 */
export async function scryfallSets(fetchFn: FetchFn = defaultFetch, signal?: AbortSignal, now = Date.now()): Promise<ScryfallSet[]> {
  const cached = (await db.meta.get('scryfallSets'))?.value as { fetchedAt: number; sets: ScryfallSet[] } | undefined;
  if (cached?.sets.length && now - cached.fetchedAt < SETS_TTL_MS) return cached.sets;
  try {
    const res = await fetchFn(`${SCRYFALL_API}/sets`, { headers: { Accept: 'application/json' }, signal });
    if (!res.ok) throw new Error(`Scryfall answered HTTP ${res.status}`);
    const sets = parseSets(await res.json());
    if (!sets.length) throw new Error('Scryfall sent no sets');
    await db.meta.put({ key: 'scryfallSets', value: { fetchedAt: now, sets }, updatedAt: now });
    return sets;
  } catch (e) {
    if (signal?.aborted) throw e;
    if (cached?.sets.length) return cached.sets;
    throw new Error(`Couldn't read Scryfall's set list (${e instanceof Error ? e.message : String(e)})`);
  }
}

/** The set a set belongs to: its parent's parent… up to the top (a set with no parent is its own). Null when unknown. */
export function rootSet(sets: ReadonlyMap<string, ScryfallSet>, code: string): ScryfallSet | null {
  let s = sets.get(code.toLowerCase());
  for (let i = 0; s?.parent && i < 10; i++) {
    const p = sets.get(s.parent);
    if (!p) break;
    s = p;
  }
  return s ?? null;
}

/** What grouping needs of one print. `colors`: its color identity, WUBRG letters. */
export interface CardFacts {
  set: string;
  rarity: string;
  colors: string;
}

interface ScryfallCardFacts {
  id: string;
  set: string;
  rarity: string;
  color_identity?: string[];
}

const WUBRG = 'WUBRG';
/** Color identity letters in WUBRG order ("GW" → "WG"). */
export const colorLetters = (ci: readonly string[] | undefined): string =>
  [...new Set((ci ?? []).map((c) => c.toUpperCase()).filter((c) => WUBRG.includes(c)))].sort((a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b)).join('');

/** Each print's set, rarity and color identity, by Scryfall id (ids Scryfall doesn't know are left out). */
export async function scryfallCardFacts(
  ids: readonly string[],
  opts: { signal?: AbortSignal; fetchFn?: FetchFn; onProgress?: (done: number, total: number) => void } = {},
): Promise<Map<string, CardFacts>> {
  const unique = [...new Set(ids.filter((id) => /^[0-9a-f-]{36}$/i.test(id)))];
  const cards = await scryfallCollection<ScryfallCardFacts>(
    unique.map((id) => ({ id })),
    opts.signal,
    opts.fetchFn,
    opts.onProgress,
  );
  const out = new Map<string, CardFacts>();
  for (const c of cards) {
    if (typeof c?.id !== 'string') continue;
    out.set(c.id, { set: String(c.set ?? '').toLowerCase(), rarity: String(c.rarity ?? '').toLowerCase(), colors: colorLetters(c.color_identity) });
  }
  return out;
}
