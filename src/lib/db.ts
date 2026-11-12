import Dexie, { type EntityTable, type Table } from 'dexie';
import type { AccountRow } from '@/lib/accounts/types';
import type { CollectionEntry } from '@/lib/cards/types';
import type { CacheEntry, Item, Run } from '@/features/f2f-buylist/types';
import type { DeckCardsRow, DeckRow } from '@/lib/decks/types';

export interface MetaRow {
  key: string;
  value: unknown;
  updatedAt: number;
}

/** A row that belongs to one account (see src/lib/accounts). */
export type Scoped<T> = T & { accountKey: string };

export interface AccountMetaRow {
  accountKey: string;
  key: string;
  value: unknown;
  updatedAt: number;
}

/**
 * Extension-wide IndexedDB (shared by the background worker and extension pages).
 *
 * Global tables: `f2fCache`, `meta` (F2F caches and the current account), `accounts`.
 * Every other table holds one account's data, keyed by `accountKey`: only the access layer in
 * src/lib/accounts/data.ts (and the Selling runner, for runs and items) may touch them. A test
 * (tests/account-scope.test.ts) enforces it.
 */
export class TithiesDB extends Dexie {
  runs!: EntityTable<Run, 'id'>;
  items!: Table<Item, [number, string]>;
  f2fCache!: EntityTable<CacheEntry, 'key'>;
  meta!: EntityTable<MetaRow, 'key'>;
  accounts!: EntityTable<AccountRow, 'key'>;
  /** Deck summaries of each account (light rows, no cards). */
  accountDecks!: Table<Scoped<DeckRow>, [string, string]>;
  /** Cards of each deck. */
  accountDeckCards!: Table<Scoped<DeckCardsRow>, [string, string]>;
  /** Snapshot of each account's whole collection, replaced on every read. */
  collectionEntries!: Table<Scoped<CollectionEntry>, [string, string]>;
  /** Per-account state: 'decks' (DecksMeta), 'collection' (CollectionMeta), 'sync' (SyncState). */
  accountMeta!: Table<AccountMetaRow, [string, string]>;

  constructor(name = 'tithies') {
    super(name);
    this.version(1).stores({
      runs: '++id, createdAt, status',
      items: '[runId+key], runId, [runId+status]',
      f2fCache: 'key, fetchedAt',
      meta: 'key',
    });
    this.version(2).stores({
      decks: 'id',
      deckCards: 'deckId',
      moxCollection: 'id',
    });
    // v3: data per account. Data saved before accounts existed has no owner, so it is dropped
    // (runs, synced decks and collection); F2F caches are kept. Dexie can't change a primary key,
    // hence new table names for decks, deck cards and the collection.
    this.version(3)
      .stores({
        runs: '++id, createdAt, status, accountKey, [accountKey+createdAt]',
        items: '[runId+key], runId, [runId+status], accountKey',
        decks: null,
        deckCards: null,
        moxCollection: null,
        accounts: 'key, type, lastUsedAt',
        accountDecks: '[accountKey+id], accountKey',
        accountDeckCards: '[accountKey+deckId], accountKey',
        collectionEntries: '[accountKey+id], accountKey',
        accountMeta: '[accountKey+key], accountKey',
      })
      .upgrade(async (tx) => {
        await tx.table('items').clear();
        await tx.table('runs').clear();
        await tx.table('meta').bulkDelete(['decks', 'moxCollection', 'moxSync']);
      });
  }
}

export const db = new TithiesDB();

/** The only keys of the global meta table: account data lives in `accountMeta`. */
export type GlobalMetaKey = 'bulkRates' | 'f2fSets' | 'currentAccount';

export async function getMeta<T>(key: GlobalMetaKey): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function putMeta(key: GlobalMetaKey, value: unknown): Promise<void> {
  await db.meta.put({ key, value, updatedAt: Date.now() });
}
