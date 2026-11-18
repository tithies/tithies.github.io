/** Background handlers of Selling runs started from a site page or the dashboard (kept apart so they can be tested). */
import { accountData, addAccountFromAction, findRun } from '@/lib/accounts/data';
import type { AccountKey } from '@/lib/accounts/types';
import { isEligible } from '@/lib/cards/prints';
import type { CollectionEntry } from '@/lib/cards/types';
import { initialSyncStateOf } from '@/lib/decks/initial-sync';
import type { AccountSyncJob } from '@/lib/decks/job';
import { describeSiteError } from '@/lib/sites/client';
import { isSiteType, siteOf } from '@/lib/sites/registry';
import type { SiteIdentity } from '@/lib/sites/types';
import { parseIdentity } from '@/lib/sites/validate';
import { createCollectionRun, createRun as defaultCreateRun, endCollectionRun, fillCollectionRun, toProgress } from './runner';
import type { RunProgress, RunSource } from './types';

export interface StartRunInput {
  type: unknown;
  /** Whose collection the entries are: the account of the request that read them. */
  account: unknown;
  source: Omit<RunSource, 'tabId'>;
  entries: CollectionEntry[];
}

/**
 * A run started from a site tab: it belongs to the account of the collection read (not to
 * whoever the tab is logged in as by now). Starting it is an action as that account, so the
 * account is added if new and becomes the current one. The panel is told when the account still
 * needs its initial sync (decks and collection), which the dashboard offers.
 */
export async function startRunFromSite(
  input: StartRunInput,
  tabId: number | undefined,
  creditBonus: number,
  createRun = defaultCreateRun,
): Promise<{ runId: number; prints: number; accountKey: AccountKey; needsInitialSync: boolean }> {
  if (!isSiteType(input.type)) throw new Error('Unknown site.');
  const identity = parseIdentity(input.account);
  if (!identity) throw new Error(`Couldn't tell which ${siteOf(input.type).label} account this collection belongs to. Reload the page, then try again.`);
  const account = await addAccountFromAction(input.type, identity);
  const res = await createRun(account.key, { ...input.source, tabId }, input.entries, creditBonus);
  return { ...res, accountKey: account.key, needsInitialSync: (await initialSyncStateOf(account.key)).needed };
}

/** Progress of a run, or of the newest run of `accountKey` started from that tab (never another account's). */
export async function progressFor(q: { runId?: number; accountKey?: AccountKey }, tabId: number | undefined): Promise<RunProgress | null> {
  let run = q.runId ? await findRun(q.runId) : undefined;
  if (!run && q.accountKey && tabId != null) run = await accountData(q.accountKey).runs.latestForTab(tabId);
  if (!run || (q.accountKey && run.accountKey !== q.accountKey)) return null;
  return toProgress(run);
}

/** Copies a check of the whole collection covers: paper (not MTGO or Arena), non-proxy, with a known print. */
export const isSellable = (e: CollectionEntry): boolean => isEligible(e) && (!e.game || e.game === 'paper');

export const WHOLE_COLLECTION_SUMMARY = 'Whole collection';

export type StartCollectionRunResult =
  | { ok: true; runId: number; accountKey: AccountKey }
  | {
      ok: false;
      error: string;
      /** As the sync job says (busy, exporting, no_tab, wrong_account…). */
      code?: string;
      /** wrong_account: who the site is logged in as. */
      actual?: SiteIdentity | null;
    };

export interface CollectionRunDeps {
  /** The site's sync job, which reads the collection (alone, or by joining a sync of the account that runs). */
  sync: Pick<AccountSyncJob, 'start' | 'finished'>;
  creditBonus: number;
  /** A run got its cards: it waits for the runner. */
  onQueued(): void;
}

/**
 * A Selling check of an account's whole collection, started from the dashboard (`accountKey`
 * null: whoever is logged in on the site, who is then added). The collection is read in the
 * background like the Comparator's (only what changed since the last read, when that can be
 * trusted), into the account's collection snapshot; the run, created at once, waits for it
 * ('fetching_collection') and then checks its paper, non-proxy cards like any other run.
 * `result` comes once the read has started; `done` once the run has its cards (or has ended).
 */
export async function startCollectionRun(
  type: unknown,
  accountKey: AccountKey | null,
  deps: CollectionRunDeps,
): Promise<{ result: StartCollectionRunResult; done: Promise<void> }> {
  const none = Promise.resolve();
  if (!isSiteType(type)) return { result: { ok: false, error: 'Unknown site.' }, done: none };
  const { label } = siteOf(type);
  const askedAt = Date.now();
  const sync = await deps.sync.start({ accountKey, collection: true, decks: false });
  if (!sync.ok) return { result: { ok: false, error: sync.error, code: sync.code, actual: sync.actual }, done: none };
  // The job started or joined (read now: the next one may start once it ends).
  const finished = deps.sync.finished;
  const data = accountData(sync.accountKey);
  // A known account with no usable tab: the job ended at once, saying why.
  const state = await data.meta.get('sync');
  if (state?.jobId === sync.jobId && state.status !== 'running') {
    return { result: { ok: false, error: state.error ?? `Couldn't read the ${label} collection.`, code: state.code, actual: state.actual }, done: none };
  }

  const source: RunSource = { url: '', pageUrl: '', query: {}, summary: WHOLE_COLLECTION_SUMMARY, wholeCollection: true };
  const runId = await createCollectionRun(sync.accountKey, source, deps.creditBonus, sync.jobId);
  const done = (async () => {
    await finished;
    // Read since the check was asked for (by this job, or one it joined).
    const meta = await data.meta.get('collection');
    if (meta && meta.fetchedAt >= askedAt) {
      const entries = (await data.collection.list()).filter(isSellable);
      if (!entries.length) return endCollectionRun(runId, 'failed', `The ${label} collection has no paper, non-proxy cards to check.`);
      if (await fillCollectionRun(runId, entries)) deps.onQueued();
      return;
    }
    const s = await data.meta.get('sync');
    const mine = s?.jobId === sync.jobId;
    if (mine && s.status === 'cancelled') return endCollectionRun(runId, 'cancelled', 'The collection read was cancelled.');
    return endCollectionRun(runId, 'failed', `Couldn't read the ${label} collection${mine && s.error ? `: ${s.error}` : '.'}`);
  })().catch((e) => endCollectionRun(runId, 'failed', describeSiteError(e)).catch(() => {}));
  return { result: { ok: true, runId, accountKey: sync.accountKey }, done };
}
