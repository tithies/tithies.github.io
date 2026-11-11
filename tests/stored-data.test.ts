import { browser } from 'wxt/browser';
import { db, getMeta, putMeta } from '@/lib/db';
import { META_COLLECTION, META_DECKS, META_SYNC } from '@/lib/decks/types';
import { getSettings, overlayCollapsedItem, saveSettings } from '@/lib/settings';
import { mismatchConfigItem } from '@/features/deck-mismatch/config';
import { clearStoredData, listStoredPreferences, resetAllSettings } from '@/features/settings/stored-data';

// Rows only need their keys for these tests.
const row = (v: object) => v as never;

async function fill() {
  await Promise.all([db.runs.clear(), db.items.clear(), db.f2fCache.clear(), db.meta.clear(), db.decks.clear(), db.deckCards.clear(), db.moxCollection.clear()]);
  const runId = (await db.runs.add(row({ createdAt: 1, status: 'completed' }))) as number;
  await db.items.add(row({ runId, key: 'k1', status: 'done' }));
  await db.f2fCache.add(row({ key: 'k1', fetchedAt: Date.now() }));
  await putMeta('bulkRates', { fetchedAt: 1 });
  await putMeta('f2fSets', { fetchedAt: 1, sets: ['Alpha'] });
  await db.decks.add(row({ id: 'd1' }));
  await db.deckCards.add(row({ deckId: 'd1', cards: [] }));
  await putMeta(META_DECKS, { lastSuccessAt: 1 });
  await putMeta(META_SYNC, { status: 'done' });
  await db.moxCollection.add(row({ id: 'c1' }));
  await putMeta(META_COLLECTION, { fetchedAt: 1, entries: 1, copies: 1 });
}

const counts = async () => ({
  runs: await db.runs.count(),
  items: await db.items.count(),
  f2fCache: await db.f2fCache.count(),
  bulkRates: Boolean(await getMeta('bulkRates')),
  decks: await db.decks.count(),
  deckCards: await db.deckCards.count(),
  decksMeta: Boolean(await getMeta(META_DECKS)),
  collection: await db.moxCollection.count(),
  collectionMeta: Boolean(await getMeta(META_COLLECTION)),
});

describe('Settings → Stored data', () => {
  beforeEach(fill);

  it('clears only the chosen groups', async () => {
    await clearStoredData(['f2fCache']);
    expect(await counts()).toEqual({ runs: 1, items: 1, f2fCache: 0, bulkRates: false, decks: 1, deckCards: 1, decksMeta: true, collection: 1, collectionMeta: true });

    await clearStoredData(['moxDecks']);
    expect(await counts()).toMatchObject({ runs: 1, decks: 0, deckCards: 0, decksMeta: false, collection: 1, collectionMeta: true });
    expect(await getMeta(META_SYNC)).toBeUndefined();

    await clearStoredData(['moxCollection']);
    expect(await counts()).toMatchObject({ runs: 1, items: 1, collection: 0, collectionMeta: false });
  });

  it('clears everything', async () => {
    await clearStoredData(['f2fCache', 'moxDecks', 'moxCollection', 'runs']);
    expect(await counts()).toEqual({ runs: 0, items: 0, f2fCache: 0, bulkRates: false, decks: 0, deckCards: 0, decksMeta: false, collection: 0, collectionMeta: false });
    expect(await db.meta.count()).toBe(0);
  });
});

describe('Settings → Reset settings', () => {
  it('puts every setting back to its default and keeps the data', async () => {
    await fill();
    await saveSettings({ requestIntervalMs: 5000 });
    await overlayCollapsedItem.setValue(true);
    await mismatchConfigItem.setValue({ showMissing: false, showUnassigned: true, ignoreProxies: false, ignoredBoards: [], excludedDeckIds: ['d1'] });
    expect((await listStoredPreferences()).map((p) => p.key).sort()).toEqual(['deckMismatchConfig', 'overlayCollapsed', 'settings']);

    await resetAllSettings();

    expect(await listStoredPreferences()).toEqual([]);
    expect(Object.keys(await browser.storage.local.get(null))).toEqual([]);
    expect((await getSettings()).requestIntervalMs).toBe(1500);
    expect(await overlayCollapsedItem.getValue()).toBe(false);
    expect(await db.runs.count()).toBe(1);
  });
});
