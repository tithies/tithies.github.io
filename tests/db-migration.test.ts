import { storage } from '#imports';
import Dexie from 'dexie';
import { migrateStorage } from '@/lib/accounts/migrate';
import { TithiesDB } from '@/lib/db';

/** A database as the previous Tithies left it (schema v1 + v2), filled with data. */
async function oldDatabase(name: string, withV2 = true) {
  const old = new Dexie(name);
  old.version(1).stores({ runs: '++id, createdAt, status', items: '[runId+key], runId, [runId+status]', f2fCache: 'key, fetchedAt', meta: 'key' });
  if (withV2) old.version(2).stores({ decks: 'id', deckCards: 'deckId', moxCollection: 'id' });
  await old.open();
  const runId = await old.table('runs').add({ createdAt: 1, status: 'completed' });
  await old.table('items').add({ runId, key: 'k', status: 'done' });
  await old.table('f2fCache').add({ key: 'dmu|1|foil', fetchedAt: 5 });
  await old.table('meta').bulkPut([
    { key: 'bulkRates', value: { rare: 0.07 }, updatedAt: 1 },
    { key: 'f2fSets', value: { sets: ['Alpha'] }, updatedAt: 1 },
    { key: 'decks', value: { lastSuccessAt: 1 }, updatedAt: 1 },
    { key: 'moxCollection', value: { entries: 1 }, updatedAt: 1 },
    { key: 'moxSync', value: { status: 'done' }, updatedAt: 1 },
  ]);
  if (withV2) {
    await old.table('decks').add({ id: 'd1' });
    await old.table('deckCards').add({ deckId: 'd1', cards: [] });
    await old.table('moxCollection').add({ id: 'c1' });
  }
  old.close();
}

describe('Database upgrade to per-account data (v3)', () => {
  for (const [label, withV2] of [['v2', true], ['v1', false]] as const) {
    it(`drops data that has no account and keeps the F2F caches (from ${label})`, async () => {
      const name = `migration-${label}`;
      await oldDatabase(name, withV2);
      const db = new TithiesDB(name);
      await db.open();
      expect(db.verno).toBe(3);
      expect(db.tables.map((t) => t.name).sort()).toEqual(
        ['accountDeckCards', 'accountDecks', 'accountMeta', 'accounts', 'collectionEntries', 'f2fCache', 'items', 'meta', 'runs'].sort(),
      );
      expect(await db.runs.count()).toBe(0);
      expect(await db.items.count()).toBe(0);
      expect((await db.meta.toArray()).map((m) => m.key).sort()).toEqual(['bulkRates', 'f2fSets']);
      expect(await db.f2fCache.count()).toBe(1);
      // The new compound keys work.
      await db.accountDecks.put({ accountKey: 'moxfield:1', id: 'd1' } as never);
      await db.accountDecks.put({ accountKey: 'moxfield:2', id: 'd1' } as never);
      expect(await db.accountDecks.where('accountKey').equals('moxfield:1').count()).toBe(1);
      db.close();
      await Dexie.delete(name);
    });
  }

  it('removes the old global Mismatches options from extension storage, keeping settings', async () => {
    await storage.setItem('local:deckMismatchConfig', { excludedDeckIds: ['d1'] });
    await storage.setItem('local:settings', { batchSize: 30 });
    await migrateStorage();
    await migrateStorage(); // idempotent
    expect(await storage.getItem('local:deckMismatchConfig')).toBeNull();
    expect(await storage.getItem('local:settings')).toEqual({ batchSize: 30 });
  });
});
