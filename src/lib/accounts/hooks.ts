/** Dashboard-side live reads of one account's data. */
import { useLiveQuery } from 'dexie-react-hooks';
import type { Item, Run } from '@/features/f2f-buylist/types';
import { accountData, findRun, itemsOfRun, type AccountData } from './data';
import type { AccountKey } from './types';

/**
 * A live query over one account's data. `useLiveQuery` keeps its previous result while a new
 * query starts, so after switching accounts it would briefly show the old account's data: each
 * result is tagged with its account and only returned for the account asked for.
 * undefined while loading (and when there's no account).
 */
export function useAccountLive<T>(key: AccountKey | null, query: (d: AccountData) => Promise<T>, deps: unknown[] = []): T | undefined {
  const r = useLiveQuery(async () => (key ? { key, v: await query(accountData(key)) } : null), [key, ...deps]);
  return r && r.key === key ? r.v : undefined;
}

/** The account's Selling runs, newest first. */
export const useRuns = (key: AccountKey | null): Run[] | undefined => useAccountLive(key, (d) => d.runs.list());

/** One run by id (null when it doesn't exist). */
export const useRun = (runId: number): Run | null | undefined => useLiveQuery(async () => (await findRun(runId)) ?? null, [runId]);

export const useRunItems = (runId: number): Item[] | undefined => useLiveQuery(() => itemsOfRun(runId), [runId]);
