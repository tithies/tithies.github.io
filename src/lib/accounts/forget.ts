/**
 * Forgetting an account (Settings → Accounts): its runs, synced decks, collection snapshot,
 * per-account options and the log of the changes Tithies made to it go, for good. Anything still working for it is stopped first, and waited
 * for, so nothing writes rows nobody owns afterwards (the access layer refuses such writes too).
 * The account isn't added again until Tithies acts as it (accounts are only added by actions).
 */
import { clearChangeLogOf } from '@/lib/changes/log';
import { clearDatabase } from '@/lib/db';
import { accountData, unfinishedRuns } from './data';
import { accountStorageKeys } from './storage-keys';
import type { AccountKey } from './types';

export interface ForgetDeps {
  /** Cancels these runs, and resolves once the runner has stopped working on them. */
  stopRuns(runIds: number[]): Promise<void>;
  /** The background jobs working for an account (sync and export, one of each per site). */
  syncJobs: { readonly activeAccountKey: AccountKey | null; cancel(): boolean; readonly finished: Promise<void> }[];
  removeStorage(keys: string[]): Promise<void>;
}

export async function forgetAccount(key: AccountKey, deps: ForgetDeps): Promise<void> {
  const data = accountData(key);
  await deps.stopRuns(await data.runs.activeIds());
  for (const job of deps.syncJobs) {
    if (job.activeAccountKey !== key) continue;
    const done = job.finished;
    job.cancel();
    await done;
  }
  await data.removeAll();
  await clearChangeLogOf(key);
  await deps.removeStorage(accountStorageKeys(key));
}

export interface RemoveAllDeps {
  /** Cancels these runs, and resolves once the runner has stopped working on them. */
  stopRuns(runIds: number[]): Promise<void>;
  /** Every background job (sync and export of each site). */
  jobs: { cancel(): boolean; readonly finished: Promise<void> }[];
  /** Empties the extension storage (settings, preferences, every account's options). */
  clearStorage(): Promise<void>;
}

/**
 * Settings → Remove all data: Tithies as after a fresh install. Every run, sync and export is
 * stopped and waited for first, so nothing writes into the emptied database; then every table
 * (accounts and their data, the F2F caches, the change log) and the extension storage go. The
 * dashboard empties its own localStorage (page sizes, theme).
 */
export async function removeAllData(deps: RemoveAllDeps): Promise<void> {
  await deps.stopRuns((await unfinishedRuns()).map((r) => r.id!));
  for (const job of deps.jobs) {
    const done = job.finished;
    job.cancel();
    await done;
  }
  await clearDatabase();
  await deps.clearStorage();
}
