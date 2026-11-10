import Dexie, { type EntityTable, type Table } from 'dexie';
import type { CacheEntry, Item, Run } from '@/features/f2f-buylist/types';
import type { DeckCardsRow, DeckRow } from '@/lib/decks/types';
import type { MoxEntry } from '@/lib/moxfield/normalize';

export interface MetaRow {
  key: string;
  value: unknown;
  updatedAt: number;
}

/** Extension-wide IndexedDB (shared by the background worker and extension pages). */
export class TithiesDB extends Dexie {
  runs!: EntityTable<Run, 'id'>;
  items!: Table<Item, [number, string]>;
  f2fCache!: EntityTable<CacheEntry, 'key'>;
  meta!: EntityTable<MetaRow, 'key'>;
  /** Moxfield decks (summaries) — see src/lib/decks. */
  decks!: EntityTable<DeckRow, 'id'>;
  /** Cards of each deck, keyed by deck id. */
  deckCards!: EntityTable<DeckCardsRow, 'deckId'>;
  /** Snapshot of the whole Moxfield collection, replaced on every read. */
  moxCollection!: EntityTable<MoxEntry, 'id'>;

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
  }
}

export const db = new TithiesDB();

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function putMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value, updatedAt: Date.now() });
}
