/** Two accounts whose decks and collection rows have the same ids never see or touch each other's data. */
import type { AccountData } from '@/lib/accounts/data';
import type { AccountKey } from '@/lib/accounts/types';
import type { CollectionEntry } from '@/lib/cards/types';
import { db } from '@/lib/db';
import { refreshCollection } from '@/lib/decks/collection';
import { markDecksSeen, syncDecks } from '@/lib/decks/sync';
import type { DeckCard, DeckSummary } from '@/lib/decks/types';
import type { DeckSource } from '@/lib/sites/client';
import { normalizeDeckCards } from '@/lib/sites/moxfield/decks';
import { normalizeEntry } from '@/lib/sites/moxfield/normalize';
import { moxfieldSite } from '@/lib/sites/moxfield/provider';
import { createRun } from '@/features/f2f-buylist/runner';
import { fixture, newAccount, resetDb } from './helpers';

const CARDS: DeckCard[] = normalizeDeckCards(fixture<any>('moxfield-deck.json')).cards;
const ENTRIES: CollectionEntry[] = fixture<{ data: unknown[] }>('moxfield-page.json').data.map(normalizeEntry).filter((e): e is CollectionEntry => !!e);
const deck = (id: string, name: string): DeckSummary => ({
  id,
  publicId: `Public_${id}_xxxx`,
  name,
  format: 'commander',
  visibility: 'private',
  folderPath: '',
  lastUpdatedAt: '2026-01-01T00:00:00Z',
  createdAt: '2025-01-01T00:00:00Z',
  mainboardCount: 99,
  sideboardCount: 0,
  maybeboardCount: 0,
  commanders: [],
  publicUrl: '',
});
const source = (list: DeckSummary[]): DeckSource => ({ deckList: async () => list, deck: async () => ({ lastUpdatedAt: '', cards: CARDS }) });
const pages = (entries: CollectionEntry[]) => ({ collectionPage: async (_n: number, size: number) => ({ entries, totalResults: entries.length, totalPages: 1, pageSize: size }) });

let A: { key: AccountKey; data: AccountData };
let B: { key: AccountKey; data: AccountData };

beforeEach(async () => {
  await resetDb();
  A = await newAccount('111111', 'alice');
  B = await newAccount('222222', 'bob');
});

describe('Account isolation', () => {
  it('syncing one account leaves the other one exactly as it was', async () => {
    await syncDecks(moxfieldSite, A.data, source([deck('d1', 'Alice 1'), deck('d2', 'Alice 2')]));
    await refreshCollection(moxfieldSite, A.data, pages(ENTRIES));
    const aDecks = await A.data.decks.list();
    const aCollection = await A.data.collection.list();

    // Bob has a deck with the same id, and fewer collection rows with the same ids.
    await syncDecks(moxfieldSite, B.data, source([deck('d1', 'Bob 1')]));
    await refreshCollection(moxfieldSite, B.data, pages(ENTRIES.slice(0, 2)));

    expect(await A.data.decks.list()).toEqual(aDecks);
    expect(await A.data.collection.list()).toEqual(aCollection);
    expect((await B.data.decks.list()).map((d) => d.name)).toEqual(['Bob 1']);
    expect(await B.data.collection.count()).toBe(2);
    expect((await A.data.decks.get('d1'))!.name).toBe('Alice 1');
    expect((await B.data.decks.get('d1'))!.name).toBe('Bob 1');

    // Bob's next sync drops his deck d1: alice's d1 stays.
    await syncDecks(moxfieldSite, B.data, source([deck('d9', 'Bob 9')]));
    expect((await A.data.decks.get('d1'))!.name).toBe('Alice 1');
    expect(await A.data.deckCards.get('d1')).toBeDefined();
  });

  it('marking decks seen, clearing and measuring stay within one account', async () => {
    await syncDecks(moxfieldSite, A.data, source([deck('d1', 'A')]));
    await syncDecks(moxfieldSite, B.data, source([deck('d1', 'B')]));
    await syncDecks(moxfieldSite, A.data, source([deck('d1', 'A'), deck('d2', 'A new')]));
    await syncDecks(moxfieldSite, B.data, source([deck('d1', 'B'), deck('d2', 'B new')]));
    await markDecksSeen(A.data);
    expect((await A.data.decks.get('d2'))!.isNew).toBe(false);
    expect((await B.data.decks.get('d2'))!.isNew).toBe(true);

    const bSize = (await B.data.measure()).decks;
    await A.data.clear(['decks']);
    expect(await A.data.decks.count()).toBe(0);
    expect(await B.data.decks.count()).toBe(2);
    expect((await B.data.measure()).decks).toBe(bSize);
  });

  it("lists each account's runs only, and finds a tab's latest run per account", async () => {
    const src = (tabId: number) => ({ url: 'u', pageUrl: 'p', query: {}, summary: '', tabId });
    const a1 = await createRun(A.key, src(7), ENTRIES, 0.3);
    const b1 = await createRun(B.key, src(7), ENTRIES, 0.3);
    const a2 = await createRun(A.key, src(8), ENTRIES, 0.3);
    expect((await A.data.runs.list()).map((r) => r.id)).toEqual([a2.runId, a1.runId]);
    expect((await B.data.runs.list()).map((r) => r.id)).toEqual([b1.runId]);
    // Same tab, two accounts: each account's newest run from it.
    expect((await A.data.runs.latestForTab(7))?.id).toBe(a1.runId);
    expect((await B.data.runs.latestForTab(7))?.id).toBe(b1.runId);
    expect(await A.data.items.count()).toBe(2 * (await db.items.where('runId').equals(a1.runId).count()));
  });

  it('forgetting an account removes all of its data, and only its data', async () => {
    await syncDecks(moxfieldSite, A.data, source([deck('d1', 'A')]));
    await refreshCollection(moxfieldSite, A.data, pages(ENTRIES));
    await createRun(A.key, { url: 'u', pageUrl: 'p', query: {}, summary: '' }, ENTRIES, 0.3);
    await syncDecks(moxfieldSite, B.data, source([deck('d1', 'B')]));
    await A.data.removeAll();
    for (const t of [db.accountDecks, db.accountDeckCards, db.collectionEntries, db.accountMeta, db.runs, db.items]) {
      expect(await t.where('accountKey').equals(A.key).count()).toBe(0);
    }
    expect(await db.accounts.get(A.key)).toBeUndefined();
    expect(await B.data.decks.count()).toBe(1);
    // Nothing can be written for it any more.
    await expect(A.data.write((w) => w.decks.putMany([deck('d5', 'late') as never]))).rejects.toThrow('removed from Tithies');
  });
});
