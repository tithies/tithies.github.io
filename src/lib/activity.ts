/** Everything running in the background, for every account: exports, Selling checks and deck syncs. */
import { useLiveQuery } from 'dexie-react-hooks';
import { accountData, listAccounts, unfinishedRuns } from '@/lib/accounts/data';
import type { AccountKey } from '@/lib/accounts/types';
import { db } from '@/lib/db';
import type { SyncState } from '@/lib/decks/types';
import type { ExportDetails } from '@/lib/export/types';

export interface ActivityItem {
  id: string;
  kind: 'export' | 'run' | 'sync';
  /** The account whose page `to` shows (switched to before opening it). */
  accountKey: AccountKey;
  /** The account the job acts as. */
  userName: string;
  title: string;
  detail: string;
  /** Unknown total: no progress. */
  progress?: { done: number; total: number };
  /** Dashboard route of the job. */
  to: string;
}

const RUN_DETAIL: Record<string, string> = {
  fetching_collection: 'Reading the collection…',
  queued: 'Waiting for its turn',
  running: 'Checking prices on F2F…',
};

function syncDetail(s: SyncState): string {
  switch (s.phase) {
    case 'connecting':
      return 'Connecting…';
    case 'deckList':
      return 'Reading your deck list…';
    case 'decks':
      return s.total ? `Reading decks ${s.done}/${s.total}` : 'Decks are up to date';
    case 'collection':
      return s.total > 1 ? `Reading your collection (page ${s.done}/${s.total})` : 'Reading your collection…';
    default:
      return 'Finishing…';
  }
}

export async function readActivity(): Promise<ActivityItem[]> {
  const accounts = await listAccounts();
  const names = new Map(accounts.map((a) => [a.key, a.nickname || a.userName]));
  const items: ActivityItem[] = [];

  for (const op of await db.changeOps.where('status').equals('running').toArray()) {
    if (!names.has(op.accountKey)) continue;
    // An export opens on the Comparator it was made from, in its window; else in the Change log.
    const source = (op.details as ExportDetails | undefined)?.sourceAccountKey;
    const fromComparator = op.kind === 'export' && !!source && names.has(source);
    items.push({
      id: `export:${op.id}`,
      kind: 'export',
      accountKey: fromComparator ? source : op.accountKey,
      userName: names.get(op.accountKey)!,
      title: op.title,
      detail: op.phase ?? 'Working…',
      progress: op.progress && op.progress.total > 0 ? { done: op.progress.done, total: op.progress.total } : undefined,
      to: fromComparator ? `/collection/comparator?export=${op.id}` : `/changes?op=${op.id}`,
    });
  }

  for (const run of await unfinishedRuns()) {
    if (!names.has(run.accountKey as AccountKey)) continue;
    items.push({
      id: `run:${run.id}`,
      kind: 'run',
      accountKey: run.accountKey as AccountKey,
      userName: names.get(run.accountKey as AccountKey)!,
      title: `Selling check · ${run.source.summary || 'Whole collection'}`,
      detail: RUN_DETAIL[run.status] ?? run.status,
      progress: run.totals.prints > 0 ? { done: run.totals.done, total: run.totals.prints } : undefined,
      to: `/f2f/runs/${run.id}`,
    });
  }

  for (const a of accounts) {
    const s = await accountData(a.key).meta.get('sync');
    if (s?.status !== 'running') continue;
    items.push({
      id: `sync:${a.key}`,
      kind: 'sync',
      accountKey: a.key,
      userName: names.get(a.key)!,
      title: s.withCollection ? 'Deck and collection sync' : 'Deck sync',
      detail: syncDetail(s),
      progress: s.total > 1 || s.phase === 'decks' ? (s.total > 0 ? { done: s.done, total: s.total } : undefined) : undefined,
      to: '/collection/comparator',
    });
  }
  return items;
}

/** Live list of running jobs (empty while loading). */
export function useActivity(): ActivityItem[] {
  return useLiveQuery(readActivity, []) ?? [];
}
