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

  // Running exports, and those waiting for the one before them (started together with it), in the order they run.
  for (const op of (await db.changeOps.where('status').anyOf('running', 'queued').toArray()).sort((a, b) => Number(a.status === 'queued') - Number(b.status === 'queued') || a.id! - b.id!)) {
    const waiting = op.status === 'queued';
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
      detail: waiting ? 'Waiting for its turn' : (op.phase ?? 'Working…'),
      progress: waiting ? undefined : (op.overall ?? (op.progress && op.progress.total > 0 ? { done: op.progress.done, total: op.progress.total } : undefined)),
      to: fromComparator ? `/collection/comparator?export=${op.id}` : `/changes?op=${op.id}`,
    });
  }

  // Collection reads a Selling check waits for: shown as the check, not as a sync of their own.
  const readFor = new Map<string, SyncState>();
  for (const run of await unfinishedRuns()) {
    const key = run.accountKey as AccountKey;
    if (!names.has(key)) continue;
    const read = run.status === 'fetching_collection' ? await accountData(key).meta.get('sync') : undefined;
    const reading = read?.status === 'running' && read.jobId === run.collectionJobId ? read : undefined;
    if (reading) readFor.set(reading.jobId, reading);
    items.push({
      id: `run:${run.id}`,
      kind: 'run',
      accountKey: key,
      userName: names.get(key)!,
      title: `Selling check · ${run.source.summary || 'Whole collection'}`,
      detail: reading ? syncDetail(reading) : (RUN_DETAIL[run.status] ?? run.status),
      progress: reading?.overall ?? (run.totals.prints > 0 ? { done: run.totals.done, total: run.totals.prints } : undefined),
      to: `/f2f/runs/${run.id}`,
    });
  }

  for (const a of accounts) {
    const data = accountData(a.key);
    const s = await data.meta.get('sync');
    if (s?.status !== 'running') continue;
    if (s.withDecks === false && readFor.has(s.jobId)) continue;
    // The account's decks were never synced to the end: this is its initial sync.
    const initial = !(await data.meta.get('decks'))?.lastSuccessAt;
    items.push({
      id: `sync:${a.key}`,
      kind: 'sync',
      accountKey: a.key,
      userName: names.get(a.key)!,
      title:
        s.withDecks === false
          ? 'Collection read'
          : initial
            ? s.withCollection
              ? 'Initial sync (decks and collection)'
              : 'First deck sync'
            : s.withCollection
              ? 'Deck and collection sync'
              : 'Deck sync',
      detail: syncDetail(s),
      progress: s.overall ?? (s.phase === 'decks' && s.total > 0 ? { done: s.done, total: s.total } : undefined),
      to: '/collection/comparator',
    });
  }
  return items;
}

/** Live list of running jobs (empty while loading). */
export function useActivity(): ActivityItem[] {
  return useLiveQuery(readActivity, []) ?? [];
}
