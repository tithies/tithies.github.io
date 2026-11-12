/**
 * The account access layer: the only module that reads or writes per-account tables (the Selling
 * runner also writes runs/items it already owns). Everything goes through `accountData(key)`,
 * whose reads only ever see that account's rows and whose writes only happen in `write`, a
 * transaction that refuses to run once the account has been forgotten. Mixing accounts would
 * take a deliberate detour; tests/account-scope.test.ts checks nobody else touches the tables.
 */
import Dexie from 'dexie';
import type { CollectionEntry } from '@/lib/cards/types';
import { db, getMeta } from '@/lib/db';
import type { AccountMetaMap, CollectionMeta, DeckCardsRow, DeckRow } from '@/lib/decks/types';
import type { SiteIdentity, SiteType } from '@/lib/sites/types';
import type { Item, Run } from '@/features/f2f-buylist/types';
import { accountKey, type AccountKey, type AccountRow } from './types';

/** The account was forgotten while something was still working for it. */
export class AccountGoneError extends Error {
  constructor() {
    super('This account was removed from Tithies meanwhile.');
    this.name = 'AccountGoneError';
  }
}

// ---------------------------------------------------------------------------------------------
// Accounts and the current account

export const listAccounts = (): Promise<AccountRow[]> => db.accounts.toArray();
export const getAccount = (key: string): Promise<AccountRow | undefined> => db.accounts.get(key as AccountKey);
export const getStoredCurrentKey = (): Promise<AccountKey | undefined> => getMeta<AccountKey>('currentAccount');

/** The current account: the stored one, else the most recently used, else none. */
export function resolveCurrent(accounts: readonly AccountRow[], stored: string | undefined): AccountRow | null {
  if (stored) {
    const a = accounts.find((x) => x.key === stored);
    if (a) return a;
  }
  return accounts.reduce<AccountRow | null>((best, a) => (!best || a.lastUsedAt > best.lastUsedAt ? a : best), null);
}

export async function getCurrentAccount(): Promise<AccountRow | null> {
  const [accounts, stored] = await Promise.all([listAccounts(), getStoredCurrentKey()]);
  return resolveCurrent(accounts, stored);
}

/**
 * Tithies is about to act as this site account (a run started from the site's page, a sync, the
 * user choosing "Switch to"): adds it when new, keeps its username current, and makes it the
 * current account. This is the only way accounts are added.
 */
export async function addAccountFromAction(type: SiteType, identity: SiteIdentity, now = Date.now()): Promise<AccountRow> {
  const key = accountKey(type, identity.userId);
  return db.transaction('rw', db.accounts, db.meta, async () => {
    const old = await db.accounts.get(key);
    const row: AccountRow = old
      ? { ...old, userName: identity.userName, lastUsedAt: now, lastSeenAt: now }
      : { key, type, userId: identity.userId, userName: identity.userName, addedAt: now, lastUsedAt: now, lastSeenAt: now };
    await db.accounts.put(row);
    await db.meta.put({ key: 'currentAccount', value: key, updatedAt: now });
    return row;
  });
}

/** Makes a known account the current one. False when there's no such account. */
export async function setCurrentAccount(key: AccountKey, now = Date.now()): Promise<boolean> {
  return db.transaction('rw', db.accounts, db.meta, async () => {
    if (!(await db.accounts.update(key, { lastUsedAt: now }))) return false;
    await db.meta.put({ key: 'currentAccount', value: key, updatedAt: now });
    return true;
  });
}

export async function setNickname(key: AccountKey, nickname: string | null): Promise<void> {
  const v = nickname?.trim().slice(0, 40);
  await db.accounts.update(key, { nickname: v || undefined });
}

// ---------------------------------------------------------------------------------------------
// Runs by id (a run says which account it belongs to)

export const findRun = (runId: number): Promise<Run | undefined> => db.runs.get(runId);
export const itemsOfRun = (runId: number): Promise<Item[]> => db.items.where('runId').equals(runId).toArray();

// ---------------------------------------------------------------------------------------------
// One account's data

export type AccountDataGroup = 'decks' | 'collection' | 'runs';
export const ACCOUNT_DATA_GROUPS: AccountDataGroup[] = ['decks', 'collection', 'runs'];

const ACTIVE_RUN = new Set(['running', 'queued']);

/** The tables `write` locks (plus the accounts table, to check the account still exists). */
const scopedTables = () => [db.accounts, db.meta, db.accountDecks, db.accountDeckCards, db.collectionEntries, db.accountMeta, db.runs, db.items];

/** Writes for one account; only handed out inside `AccountData.write`. */
export class AccountWriter {
  constructor(readonly key: AccountKey) {}

  readonly decks = {
    putMany: (rows: DeckRow[]) => db.accountDecks.bulkPut(rows.map((r) => ({ ...r, accountKey: this.key }))),
    update: (id: string, patch: Partial<DeckRow>) => db.accountDecks.update([this.key, id], patch),
    /** Removes the decks and their cards. */
    remove: async (ids: string[]) => {
      if (!ids.length) return;
      const keys = ids.map((id): [string, string] => [this.key, id]);
      await db.accountDecks.bulkDelete(keys);
      await db.accountDeckCards.bulkDelete(keys);
    },
  };

  readonly deckCards = {
    put: (row: DeckCardsRow) => db.accountDeckCards.put({ ...row, accountKey: this.key }),
  };

  readonly collection = {
    /** The whole snapshot at once: the old one goes, the new one and its meta come in. */
    replace: async (entries: CollectionEntry[], meta: CollectionMeta) => {
      await db.collectionEntries.where('accountKey').equals(this.key).delete();
      await db.collectionEntries.bulkPut(entries.map((e) => ({ ...e, accountKey: this.key })));
      await this.meta.put('collection', meta);
    },
  };

  readonly meta = {
    put: <K extends keyof AccountMetaMap>(k: K, value: AccountMetaMap[K]) => db.accountMeta.put({ accountKey: this.key, key: k, value, updatedAt: Date.now() }),
    remove: (...keys: (keyof AccountMetaMap)[]) => db.accountMeta.bulkDelete(keys.map((k): [string, string] => [this.key, k])),
  };
}

export class AccountData {
  private writer: AccountWriter;

  constructor(readonly key: AccountKey) {
    this.writer = new AccountWriter(key);
  }

  readonly decks = {
    list: (): Promise<DeckRow[]> => db.accountDecks.where('accountKey').equals(this.key).toArray(),
    get: (id: string): Promise<DeckRow | undefined> => db.accountDecks.get([this.key, id]),
    bulkGet: async (ids: string[]): Promise<DeckRow[]> =>
      (await db.accountDecks.bulkGet(ids.map((id): [string, string] => [this.key, id]))).filter((d): d is NonNullable<typeof d> => !!d),
    count: () => db.accountDecks.where('accountKey').equals(this.key).count(),
  };

  readonly deckCards = {
    list: (): Promise<DeckCardsRow[]> => db.accountDeckCards.where('accountKey').equals(this.key).toArray(),
    get: (deckId: string): Promise<DeckCardsRow | undefined> => db.accountDeckCards.get([this.key, deckId]),
    count: () => db.accountDeckCards.where('accountKey').equals(this.key).count(),
  };

  readonly collection = {
    list: (): Promise<CollectionEntry[]> => db.collectionEntries.where('accountKey').equals(this.key).toArray(),
    count: () => db.collectionEntries.where('accountKey').equals(this.key).count(),
  };

  readonly meta = {
    get: async <K extends keyof AccountMetaMap>(k: K): Promise<AccountMetaMap[K] | undefined> =>
      (await db.accountMeta.get([this.key, k]))?.value as AccountMetaMap[K] | undefined,
  };

  readonly runs = {
    /** Newest first. */
    list: (): Promise<Run[]> =>
      db.runs.where('[accountKey+createdAt]').between([this.key, Dexie.minKey], [this.key, Dexie.maxKey]).reverse().toArray(),
    activeIds: async (): Promise<number[]> =>
      (await db.runs.where('accountKey').equals(this.key).filter((r) => ACTIVE_RUN.has(r.status)).primaryKeys()) as number[],
    /** The newest run started from that browser tab. */
    latestForTab: async (tabId: number): Promise<Run | undefined> => (await this.runs.list()).find((r) => r.source.tabId === tabId),
    count: () => db.runs.where('accountKey').equals(this.key).count(),
  };

  readonly items = {
    count: () => db.items.where('accountKey').equals(this.key).count(),
  };

  /**
   * Every write for this account happens here, in one transaction over the account's tables.
   * Refuses (AccountGoneError) once the account has been forgotten, so nothing still running for
   * it can write rows nobody owns. Only await Dexie calls inside `fn` (never a network request).
   */
  write<T>(fn: (w: AccountWriter) => Promise<T>): Promise<T> {
    return db.transaction('rw', scopedTables(), async () => {
      if (!(await db.accounts.get(this.key))) throw new AccountGoneError();
      return fn(this.writer);
    });
  }

  /** Empties some of this account's data (active runs must have been cancelled first). */
  async clear(groups: Iterable<AccountDataGroup>): Promise<void> {
    const g = new Set(groups);
    await db.transaction('rw', scopedTables(), async () => {
      if (g.has('decks')) {
        await db.accountDecks.where('accountKey').equals(this.key).delete();
        await db.accountDeckCards.where('accountKey').equals(this.key).delete();
        await this.writer.meta.remove('decks', 'sync');
      }
      if (g.has('collection')) {
        await db.collectionEntries.where('accountKey').equals(this.key).delete();
        await this.writer.meta.remove('collection');
      }
      if (g.has('runs')) {
        await db.items.where('accountKey').equals(this.key).delete();
        await db.runs.where('accountKey').equals(this.key).delete();
      }
    });
  }

  /** What each group weighs (its rows as JSON, close to what IndexedDB stores). Reads every row. */
  async measure(): Promise<Record<AccountDataGroup, number>> {
    const size = (v: unknown) => JSON.stringify(v)?.length ?? 0;
    const sum = async (rows: Promise<unknown[]>) => (await rows).reduce<number>((s, r) => s + size(r), 0);
    const metaSize = async (...keys: (keyof AccountMetaMap)[]) => sum(db.accountMeta.bulkGet(keys.map((k): [string, string] => [this.key, k])).then((r) => r.filter(Boolean)));
    const [decks, cards, decksMeta, collection, collectionMeta, runs, items] = await Promise.all([
      sum(this.decks.list()),
      sum(this.deckCards.list()),
      metaSize('decks', 'sync'),
      sum(this.collection.list()),
      metaSize('collection'),
      sum(db.runs.where('accountKey').equals(this.key).toArray()),
      sum(db.items.where('accountKey').equals(this.key).toArray()),
    ]);
    return { decks: decks + cards + decksMeta, collection: collection + collectionMeta, runs: runs + items };
  }

  /** Forgets the account: all its rows, then the account itself (and the current-account pointer if it was it). */
  async removeAll(): Promise<void> {
    await db.transaction('rw', scopedTables(), async () => {
      await this.clear(ACCOUNT_DATA_GROUPS);
      await db.accountMeta.where('accountKey').equals(this.key).delete();
      await db.accounts.delete(this.key);
      if ((await db.meta.get('currentAccount'))?.value === this.key) await db.meta.delete('currentAccount');
    });
  }
}

export const accountData = (key: AccountKey): AccountData => new AccountData(key);
