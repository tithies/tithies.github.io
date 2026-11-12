/** Snapshot of a site's whole collection (every row, no filters), replaced on every read. */
import { db, putMeta } from '@/lib/db';
import { CancelledError, type CollectionSource } from '@/lib/sites/client';
import type { SiteProvider } from '@/lib/sites/provider';
import type { CollectionEntry } from '@/lib/cards/types';
import { META_COLLECTION, type CollectionMeta } from './types';

const MAX_PAGES = 200;

export async function refreshCollection(
  site: Pick<SiteProvider, 'maxCollectionPageSize'>,
  client: CollectionSource,
  ctl: { signal?: AbortSignal; onProgress?: (p: { done: number; total: number; entries: number }) => void | Promise<void> } = {},
): Promise<CollectionMeta> {
  const first = await client.collectionPage(1, site.maxCollectionPageSize);
  const pageSize = first.pageSize || site.maxCollectionPageSize;
  const totalPages = Math.min(MAX_PAGES, Math.max(1, first.totalPages));
  const all: CollectionEntry[] = [...first.entries];
  await ctl.onProgress?.({ done: 1, total: totalPages, entries: all.length });
  for (let page = 2; page <= totalPages; page++) {
    if (ctl.signal?.aborted) throw new CancelledError();
    all.push(...(await client.collectionPage(page, pageSize)).entries);
    await ctl.onProgress?.({ done: page, total: totalPages, entries: all.length });
  }

  // Rows can shift between pages while paging: keep each collection row once.
  const byId = new Map<string, CollectionEntry>();
  all.forEach((e, i) => {
    const id = e.id || `row-${i}`;
    if (!byId.has(id)) byId.set(id, { ...e, id });
  });
  const entries = [...byId.values()];
  const meta: CollectionMeta = { fetchedAt: Date.now(), entries: entries.length, copies: entries.reduce((s, e) => s + e.qty, 0) };
  await db.transaction('rw', db.moxCollection, db.meta, async () => {
    await db.moxCollection.clear();
    await db.moxCollection.bulkPut(entries);
    await putMeta(META_COLLECTION, meta);
  });
  return meta;
}
