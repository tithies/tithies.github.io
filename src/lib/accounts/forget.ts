/**
 * Forgetting an account (Settings → Accounts): its runs, synced decks, collection snapshot and
 * per-account options go, for good. Anything still working for it is stopped first, and waited
 * for, so nothing writes rows nobody owns afterwards (the access layer refuses such writes too).
 * The account isn't added again until Tithies acts as it (accounts are only added by actions).
 */
import { accountData } from './data';
import { accountStorageKeys } from './storage-keys';
import type { AccountKey } from './types';

export interface ForgetDeps {
  /** Cancels these runs, and resolves once the runner has stopped working on them. */
  stopRuns(runIds: number[]): Promise<void>;
  /** The background sync jobs (one per site). */
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
  await deps.removeStorage(accountStorageKeys(key));
}
