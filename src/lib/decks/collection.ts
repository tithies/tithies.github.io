/**
 * Snapshot of an account's whole collection (every row, no filters), replaced on every read.
 * Every page is read (and checked by the client to come from this account) before the single
 * write, so a read interrupted or answered by another account leaves the previous snapshot as is.
 *
 * Most reads only fetch what changed: Moxfield lists entries most recently changed first, so
 * Tithies reads pages until it reaches entries older than its snapshot, and merges them in.
 * Moxfield's totals (entries and copies over the whole collection) then tell whether anything
 * else happened (a deletion, which no listing shows): if they don't match, every page is read.
 * Every page is also read on request, and when the last full read is a week old.
 */
import type { AccountData } from '@/lib/accounts/data';
import type { CollectionEntry } from '@/lib/cards/types';
import { CancelledError, type CollectionPageResult, type CollectionSource, type SiteClient } from '@/lib/sites/client';
import type { SiteProvider } from '@/lib/sites/provider';
import type { CollectionMeta } from './types';

const MAX_PAGES = 200;
/** Every page is read again when the last full read is older than this. */
export const FULL_READ_EVERY_MS = 7 * 24 * 3600_000;
/** Entries changed up to this long before the snapshot's newest change are read again (same-time changes, clock rounding). */
export const CHANGE_OVERLAP_MS = 5 * 60_000;
/** More changed pages than this: read every page instead (and stop paying for both). */
export const MAX_CHANGE_PAGES = 10;

type Site = Pick<SiteProvider, 'collectionPageSize'>;
type ReadControl = {
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number; entries: number }) => void | Promise<void>;
};

/** Reads every row of the collection (each row once), writing nothing. */
export function readWholeCollection(site: Site, client: CollectionSource, ctl: ReadControl = {}): Promise<CollectionEntry[]> {
  return readPages(site, (page, size) => client.collectionPage(page, size), ctl);
}

/** Reads every card of one binder (`publicId` as in its URL), writing nothing. */
export function readBinder(site: Site, client: Pick<SiteClient, 'binderPage'>, publicId: string, ctl: ReadControl = {}): Promise<CollectionEntry[]> {
  return readPages(site, (page, size) => client.binderPage(publicId, page, size), ctl);
}

async function readPages(site: Site, getPage: (page: number, size: number) => Promise<CollectionPageResult>, ctl: ReadControl): Promise<CollectionEntry[]> {
  const first = await getPage(1, site.collectionPageSize);
  const pageSize = first.pageSize || site.collectionPageSize;
  const totalPages = Math.min(MAX_PAGES, Math.max(1, first.totalPages));
  const all: CollectionEntry[] = [...first.entries];
  await ctl.onProgress?.({ done: 1, total: totalPages, entries: all.length });
  for (let page = 2; page <= totalPages; page++) {
    if (ctl.signal?.aborted) throw new CancelledError();
    all.push(...(await getPage(page, pageSize)).entries);
    await ctl.onProgress?.({ done: page, total: totalPages, entries: all.length });
  }

  // Rows can shift between pages while paging: keep each collection row once.
  const byId = new Map<string, CollectionEntry>();
  all.forEach((e, i) => {
    const id = e.id || `row-${i}`;
    if (!byId.has(id)) byId.set(id, { ...e, id });
  });
  return [...byId.values()];
}

/** The newest change time of a snapshot (ms); null when an entry has none (a snapshot from before times were kept). */
export function newestChange(entries: readonly CollectionEntry[]): number | null {
  let newest = -Infinity;
  for (const e of entries) {
    const t = e.updatedAt ? Date.parse(e.updatedAt) : NaN;
    if (!Number.isFinite(t)) return null;
    if (t > newest) newest = t;
  }
  return newest;
}

export type CollectionRead =
  | { mode: 'full'; entries: CollectionEntry[]; pages: number; why?: string }
  | { mode: 'changes'; entries: CollectionEntry[]; pages: number; changed: number };

/**
 * The collection as it is now, from `base` (a complete earlier read) and the entries changed
 * since: pages read most recently changed first, until entries are older than `base`'s newest
 * change. Null (with why) when that can't be trusted: the totals don't match (something was
 * deleted), too many pages changed, or `base` has no change times (or print languages).
 */
export async function readCollectionChanges(
  site: Site,
  client: CollectionSource,
  base: readonly CollectionEntry[],
  ctl: ReadControl = {},
): Promise<CollectionRead | { mode: 'none'; why: string }> {
  const newest = base.length ? newestChange(base) : -Infinity;
  if (newest === null) return { mode: 'none', why: 'the saved collection has no change times yet' };
  // Prints read before Tithies kept their language: read every page once to learn them.
  if (base.some((e) => typeof e.card.lang !== 'string')) return { mode: 'none', why: 'the saved collection has no print languages yet' };
  const cutoff = newest - CHANGE_OVERLAP_MS;
  const changed = new Map<string, CollectionEntry>();
  let totals: { entries: number; copies?: number } | null = null;
  let page = 1;
  let size = site.collectionPageSize;
  await ctl.onProgress?.({ done: 0, total: 1, entries: 0 });
  for (;;) {
    if (ctl.signal?.aborted) throw new CancelledError();
    const p = await client.collectionPage(page, size, { newestFirst: true });
    size = p.pageSize || size;
    totals ??= { entries: p.totalResults, copies: p.totalCopies };
    let older = false;
    for (const e of p.entries) {
      const t = e.updatedAt ? Date.parse(e.updatedAt) : NaN;
      if (Number.isFinite(t) && t >= cutoff) changed.set(e.id, e);
      else older = true;
    }
    const more = !older && page < p.totalPages && p.entries.length > 0;
    await ctl.onProgress?.({ done: page, total: more ? page + 1 : page, entries: changed.size });
    if (!more) break;
    if (page >= MAX_CHANGE_PAGES) return { mode: 'none', why: `more than ${MAX_CHANGE_PAGES * size} entries changed` };
    page++;
  }
  const merged = new Map(base.map((e) => [e.id, e]));
  // Entries re-read within the overlap but unchanged don't count as changes.
  let differ = 0;
  for (const [id, e] of changed) {
    const was = merged.get(id);
    if (!was || was.updatedAt !== e.updatedAt || was.qty !== e.qty) differ++;
    merged.set(id, e);
  }
  const entries = [...merged.values()];
  const copies = entries.reduce((s, e) => s + e.qty, 0);
  if (entries.length !== totals!.entries) return { mode: 'none', why: `${totals!.entries < entries.length ? 'entries were deleted' : 'entries are missing'} since the last read` };
  if (totals!.copies !== undefined && copies !== totals!.copies) return { mode: 'none', why: 'copies changed without a newer change time' };
  return { mode: 'changes', entries, pages: page, changed: differ };
}

/** The changes since `base` when they can be trusted, else every page. */
export async function readCollection(site: Site, client: CollectionSource, base: readonly CollectionEntry[] | null, ctl: ReadControl = {}): Promise<CollectionRead> {
  let why: string | undefined;
  if (base) {
    const r = await readCollectionChanges(site, client, base, ctl);
    if (r.mode === 'changes') return r;
    if (r.mode === 'none') why = r.why;
  }
  let pages = 0;
  const entries = await readWholeCollection(site, client, {
    ...ctl,
    onProgress: (p) => {
      pages = p.total;
      return ctl.onProgress?.(p);
    },
  });
  return { mode: 'full', entries, pages, ...(why ? { why } : {}) };
}

/**
 * Reads the account's collection and saves it as its snapshot: only the changes since the saved
 * snapshot, unless `full`, or the snapshot's last full read is over a week old (or unknown).
 */
export async function refreshCollection(site: Site, data: AccountData, client: CollectionSource, ctl: ReadControl & { full?: boolean; now?: () => number } = {}): Promise<CollectionMeta> {
  const now = ctl.now ?? Date.now;
  const saved = await data.meta.get('collection');
  const fullDue = ctl.full || !saved?.fullReadAt || now() - saved.fullReadAt > FULL_READ_EVERY_MS;
  const base = fullDue ? null : await data.collection.list();
  const r = await readCollection(site, client, base, ctl);
  const at = now();
  const meta: CollectionMeta = {
    fetchedAt: at,
    entries: r.entries.length,
    copies: r.entries.reduce((s, e) => s + e.qty, 0),
    fullReadAt: r.mode === 'full' ? at : saved?.fullReadAt,
    lastRead:
      r.mode === 'full'
        ? { mode: 'full', pages: r.pages, changed: r.entries.length, why: r.why ?? (ctl.full ? 'asked for' : saved?.fullReadAt ? 'a week since the last one' : 'first read') }
        : { mode: 'changes', pages: r.pages, changed: r.changed },
  };
  await data.write((w) => w.collection.replace(r.entries, meta));
  return meta;
}
