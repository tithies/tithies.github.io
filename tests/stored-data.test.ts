import { storage } from '#imports';
import { browser } from 'wxt/browser';
import type { AccountData } from '@/lib/accounts/data';
import type { AccountKey } from '@/lib/accounts/types';
import { db, getMeta, putMeta } from '@/lib/db';
import { getSettings, overlayCollapsedItem, saveSettings } from '@/lib/settings';
import { mismatchConfigKey } from '@/features/deck-mismatch/config';
import { clearStoredData, listStoredPreferences, measureStoredData, resetAllSettings } from '@/features/settings/stored-data';
import { newAccount, resetDb } from './helpers';

// Rows only need their keys for these tests.
const row = (v: object) => v as never;

let A: { key: AccountKey; data: AccountData };
let B: { key: AccountKey; data: AccountData };

/** Same data for two accounts (identical deck and collection ids), plus the shared F2F cache. */
async function fill() {
  await resetDb();
  A = await newAccount('111111', 'alice');
  B = await newAccount('222222', 'bob');
  for (const acc of [A, B]) {
    const runId = (await db.runs.add(row({ accountKey: acc.key, createdAt: 1, status: 'completed' }))) as number;
    await db.items.add(row({ runId, accountKey: acc.key, key: 'k1', status: 'done' }));
    await acc.data.write(async (w) => {
      await w.decks.putMany([row({ id: 'd1' })]);
      await w.deckCards.put(row({ deckId: 'd1', cards: [] }));
      await w.meta.put('decks', { lastSuccessAt: 1 });
      await w.meta.put('sync', row({ status: 'done' }));
      await w.collection.replace([row({ id: 'c1', qty: 1 })], { fetchedAt: 1, entries: 1, copies: 1 });
    });
  }
  await db.f2fCache.add(row({ key: 'k1', fetchedAt: Date.now() }));
  await putMeta('bulkRates', { fetchedAt: 1 });
  await putMeta('f2fSets', { fetchedAt: 1, sets: ['Alpha'] });
}

const counts = async (data: AccountData) => ({
  runs: await data.runs.count(),
  items: await data.items.count(),
  decks: await data.decks.count(),
  deckCards: await data.deckCards.count(),
  decksMeta: Boolean(await data.meta.get('decks')),
  collection: await data.collection.count(),
  collectionMeta: Boolean(await data.meta.get('collection')),
});
const full = { runs: 1, items: 1, decks: 1, deckCards: 1, decksMeta: true, collection: 1, collectionMeta: true };

describe('Settings → Stored data', () => {
  beforeEach(fill);

  it("clears only the chosen groups, of the chosen account only", async () => {
    await clearStoredData(['f2fCache'], A.key);
    expect(await db.f2fCache.count()).toBe(0);
    expect(await getMeta('bulkRates')).toBeUndefined();
    expect(await counts(A.data)).toEqual(full);

    await clearStoredData(['decks'], A.key);
    expect(await counts(A.data)).toMatchObject({ runs: 1, decks: 0, deckCards: 0, decksMeta: false, collection: 1, collectionMeta: true });
    expect(await A.data.meta.get('sync')).toBeUndefined();

    await clearStoredData(['collection'], A.key);
    expect(await counts(A.data)).toMatchObject({ runs: 1, items: 1, collection: 0, collectionMeta: false });

    // The other account is untouched.
    expect(await counts(B.data)).toEqual(full);
  });

  it('measures each group, down to zero once cleared', async () => {
    const before = await measureStoredData(A.key);
    expect(Object.values(before).every((bytes) => bytes > 0)).toBe(true);
    await clearStoredData(['decks'], A.key);
    const after = await measureStoredData(A.key);
    expect(after.decks).toBe(0);
    expect(after.f2fCache).toBe(before.f2fCache);
    expect((await measureStoredData(B.key)).decks).toBe(before.decks);
  });

  it('clears everything of an account', async () => {
    await clearStoredData(['f2fCache', 'decks', 'collection', 'runs'], A.key);
    expect(await measureStoredData(A.key)).toEqual({ f2fCache: 0, decks: 0, collection: 0, runs: 0 });
    expect(await counts(A.data)).toEqual({ runs: 0, items: 0, decks: 0, deckCards: 0, decksMeta: false, collection: 0, collectionMeta: false });
    expect(await counts(B.data)).toEqual(full);
    // Only the current-account pointer is left in the global meta table.
    expect((await db.meta.toArray()).map((m) => m.key)).toEqual(['currentAccount']);
  });
});

describe('Settings → Reset settings', () => {
  it('puts every setting back to its default and keeps the data', async () => {
    await fill();
    await saveSettings({ requestIntervalMs: 5000 });
    await overlayCollapsedItem.setValue(true);
    await storage.setItem(mismatchConfigKey(A.key), { showMissing: false, showUnassigned: true, ignoreProxies: false, ignoredBoards: [], excludedDeckIds: ['d1'] });
    const prefs = await listStoredPreferences();
    expect(prefs.map((p) => p.key).sort()).toEqual([`deckMismatchConfig:${A.key}`, 'overlayCollapsed', 'settings']);
    expect(prefs.find((p) => p.key.startsWith('deckMismatchConfig:'))!.label).toMatch(/^Mismatches page options of one account/);

    await resetAllSettings();

    expect(await listStoredPreferences()).toEqual([]);
    expect(Object.keys(await browser.storage.local.get(null))).toEqual([]);
    expect((await getSettings()).requestIntervalMs).toBe(1500);
    expect(await overlayCollapsedItem.getValue()).toBe(false);
    // Data, accounts and the current account are not settings.
    expect(await db.runs.count()).toBe(2);
    expect(await db.accounts.count()).toBe(2);
    expect(await getMeta('currentAccount')).toBe(B.key);
  });
});
