/** Background handlers of Selling runs started from a site page (kept apart so they can be tested). */
import { accountData, addAccountFromAction, findRun } from '@/lib/accounts/data';
import type { AccountKey } from '@/lib/accounts/types';
import type { CollectionEntry } from '@/lib/cards/types';
import { isSiteType, siteOf } from '@/lib/sites/registry';
import { parseIdentity } from '@/lib/sites/validate';
import { createRun as defaultCreateRun, toProgress } from './runner';
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
 * account is added if new and becomes the current one.
 */
export async function startRunFromSite(
  input: StartRunInput,
  tabId: number | undefined,
  creditBonus: number,
  createRun = defaultCreateRun,
): Promise<{ runId: number; prints: number; accountKey: AccountKey }> {
  if (!isSiteType(input.type)) throw new Error('Unknown site.');
  const identity = parseIdentity(input.account);
  if (!identity) throw new Error(`Couldn't tell which ${siteOf(input.type).label} account this collection belongs to. Reload the page, then try again.`);
  const account = await addAccountFromAction(input.type, identity);
  const res = await createRun(account.key, { ...input.source, tabId }, input.entries, creditBonus);
  return { ...res, accountKey: account.key };
}

/** Progress of a run, or of the newest run of `accountKey` started from that tab (never another account's). */
export async function progressFor(q: { runId?: number; accountKey?: AccountKey }, tabId: number | undefined): Promise<RunProgress | null> {
  let run = q.runId ? await findRun(q.runId) : undefined;
  if (!run && q.accountKey && tabId != null) run = await accountData(q.accountKey).runs.latestForTab(tabId);
  if (!run || (q.accountKey && run.accountKey !== q.accountKey)) return null;
  return toProgress(run);
}
