/**
 * Snapshot of an account's whole collection (every row, no filters), replaced on every read.
 * Every page is read (and checked by the client to come from this account) before the single
 * write, so a read interrupted or answered by another account leaves the previous snapshot as is.
 */
import type { AccountData } from '@/lib/accounts/data';
import type { CollectionEntry } from '@/lib/cards/types';
import { CancelledError, type CollectionSource } from '@/lib/sites/client';
import type { SiteProvider } from '@/lib/sites/provider';
import type { CollectionMeta } from './types';

const MAX_PAGES = 200;

export async function refreshCollection(
  site: Pick<SiteProvider, 'maxCollectionPageSize'>,
  data: AccountData,
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
  await data.write((w) => w.collection.replace(entries, meta));
  return meta;
}
