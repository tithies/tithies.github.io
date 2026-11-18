/**
 * The initial sync of an account: its deck list, every deck's cards and its whole collection,
 * read once so every feature has them (later syncs only read what changed). The dashboard header
 * offers it whenever Tithies meets an account that hasn't had it; "Not now" is remembered per
 * account (see `setInitialSyncDismissed`). No React here: the background worker uses it too.
 */
import { accountData, getAccount, getInitialSyncDismissed, type AccountData } from '@/lib/accounts/data';
import { accountKey, type AccountKey, type AccountRow } from '@/lib/accounts/types';
import type { SiteIdentity, SiteType } from '@/lib/sites/types';

/** How far an account's data has been read. */
export interface SyncSetup {
  /** Last deck sync that went to the end (unset: never). */
  decksSyncedAt?: number;
  /** Last collection read (unset: never). */
  collectionReadAt?: number;
  /** A sync of the account is running now. */
  running: boolean;
}

export const isSetUp = (s: Pick<SyncSetup, 'decksSyncedAt' | 'collectionReadAt'>): boolean => !!s.decksSyncedAt && !!s.collectionReadAt;

export async function syncSetupOf(data: AccountData): Promise<SyncSetup> {
  const [decks, collection, sync] = await Promise.all([data.meta.get('decks'), data.meta.get('collection'), data.meta.get('sync')]);
  return { decksSyncedAt: decks?.lastSuccessAt, collectionReadAt: collection?.fetchedAt, running: sync?.status === 'running' };
}

export async function readSyncSetups(keys: readonly AccountKey[]): Promise<Map<AccountKey, SyncSetup>> {
  const setups = await Promise.all(keys.map((k) => syncSetupOf(accountData(k))));
  return new Map(keys.map((k, i) => [k, setups[i]]));
}

/** Where one account stands (the Moxfield panel asks it): in Tithies, synced, offered (not dismissed). */
export interface InitialSyncState {
  known: boolean;
  /** Its decks or collection were never read, and the user didn't say "Not now". */
  needed: boolean;
  /** A sync of it runs now. */
  running: boolean;
}

export async function initialSyncStateOf(key: AccountKey): Promise<InitialSyncState> {
  const [account, dismissed] = await Promise.all([getAccount(key), getInitialSyncDismissed()]);
  if (!account) return { known: false, needed: !dismissed.includes(key), running: false };
  const setup = await syncSetupOf(accountData(key));
  return { known: true, needed: !isSetUp(setup) && !dismissed.includes(key), running: setup.running };
}

/** An account the header offers to read for the first time. */
export type InitialSyncCandidate =
  /** Logged in on the site in an open tab, not in Tithies yet. */
  | { kind: 'unknown'; type: SiteType; key: AccountKey; identity: SiteIdentity }
  /** In Tithies (current, or logged in now), its decks or collection never read. */
  | { kind: 'unsynced'; type: SiteType; key: AccountKey; account: AccountRow; setup: SyncSetup }
  /** No account at all yet: whoever is logged in on the site. */
  | { kind: 'none'; type: SiteType; key: null };

export interface CandidateInput {
  accounts: readonly AccountRow[];
  currentKey: AccountKey | null;
  /** Accounts logged in on each site right now (open tabs). */
  live: Partial<Record<SiteType, readonly SiteIdentity[]>>;
  /** Accounts missing here are still loading: not offered yet. */
  setups: ReadonlyMap<AccountKey, SyncSetup>;
  dismissed: ReadonlySet<string>;
  siteTypes: readonly SiteType[];
}

/**
 * What the header offers, most relevant first: the current account when it was never read, the
 * accounts logged in that Tithies doesn't know, the other logged-in accounts never read; with no
 * account and nobody logged in, the site itself. Never an account whose sync runs, or that the
 * user said "Not now" to.
 */
export function initialSyncCandidates({ accounts, currentKey, live, setups, dismissed, siteTypes }: CandidateInput): InitialSyncCandidate[] {
  const known = new Set(accounts.map((a) => a.key));
  const liveKeys = new Set(siteTypes.flatMap((type) => (live[type] ?? []).map((id) => accountKey(type, id.userId))));
  const unsynced = (a: AccountRow): InitialSyncCandidate[] => {
    const setup = setups.get(a.key);
    return !setup || setup.running || isSetUp(setup) || dismissed.has(a.key) ? [] : [{ kind: 'unsynced', type: a.type, key: a.key, account: a, setup }];
  };
  const current = accounts.find((a) => a.key === currentKey);
  const out: InitialSyncCandidate[] = current ? unsynced(current) : [];
  for (const type of siteTypes) {
    for (const identity of live[type] ?? []) {
      const key = accountKey(type, identity.userId);
      if (!known.has(key) && !dismissed.has(key)) out.push({ kind: 'unknown', type, key, identity });
    }
  }
  for (const a of accounts) if (a.key !== currentKey && liveKeys.has(a.key)) out.push(...unsynced(a));
  if (!accounts.length && !liveKeys.size) for (const type of siteTypes) out.push({ kind: 'none', type, key: null });
  return out;
}

/** Same candidate (the header's list changes under an open prompt). */
export const candidateId = (c: InitialSyncCandidate): string => c.key ?? `none:${c.type}`;
