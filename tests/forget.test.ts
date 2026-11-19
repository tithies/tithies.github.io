import { storage } from '#imports';
import { getCurrentAccount, listAccounts, type AccountData } from '@/lib/accounts/data';
import { forgetAccount, removeAllData } from '@/lib/accounts/forget';
import { browser } from 'wxt/browser';
import type { AccountKey } from '@/lib/accounts/types';
import { db } from '@/lib/db';
import { SessionRegistry } from '@/lib/sites/sessions';
import { comparisonConfigKey } from '@/features/collection-comparison/config';
import { sellingDeckFilterKey } from '@/features/f2f-buylist/deck-filter';
import { accountOfPreference } from '@/features/settings/stored-data';
import { MODEL_KEY, scannerDb } from '@/features/scanner/store';
import { newAccount, resetDb } from './helpers';

const row = (v: object) => v as never;

let A: { key: AccountKey; data: AccountData };
let B: { key: AccountKey; data: AccountData };

async function fill(acc: { key: AccountKey; data: AccountData }, status = 'completed') {
  const runId = (await db.runs.add(row({ accountKey: acc.key, createdAt: Date.now(), status }))) as number;
  await db.items.add(row({ runId, accountKey: acc.key, key: 'k1', status: 'done' }));
  await acc.data.write(async (w) => {
    await w.decks.putMany([row({ id: 'd1' })]);
    await w.meta.put('sync', row({ status: 'running' }));
    await w.collection.replace([row({ id: 'c1', qty: 1 })], { fetchedAt: 1, entries: 1, copies: 1 });
  });
  await storage.setItem(comparisonConfigKey(acc.key), { excludedDeckIds: ['d1'] });
  await storage.setItem(sellingDeckFilterKey(acc.key), { enabled: true });
  return runId;
}

beforeEach(async () => {
  await resetDb();
  B = await newAccount('222222', 'bob');
  A = await newAccount('111111', 'alice'); // current
});

describe('Forget account', () => {
  it('stops what works for it first, then removes all of it and only it', async () => {
    const runId = await fill(A, 'running');
    await fill(B);
    const order: string[] = [];
    let finishSync!: () => void;
    const syncDone = new Promise<void>((r) => (finishSync = r));
    const job = {
      activeAccountKey: A.key,
      cancel: () => {
        order.push('cancel sync');
        setTimeout(finishSync, 10);
        return true;
      },
      get finished() {
        return syncDone.then(() => void order.push('sync finished'));
      },
    };
    const otherJob = { activeAccountKey: B.key, cancel: () => (order.push('cancel B!'), true), finished: Promise.resolve() };

    await forgetAccount(A.key, {
      stopRuns: async (ids) => void order.push(`stop runs ${ids.join(',')}`),
      syncJobs: [job, otherJob],
      removeStorage: async (keys) => {
        order.push('storage');
        for (const k of keys) await storage.removeItem(k as `local:${string}`);
      },
    });

    expect(order).toEqual([`stop runs ${runId}`, 'cancel sync', 'sync finished', 'storage']);
    for (const t of [db.accountDecks, db.accountDeckCards, db.collectionEntries, db.accountMeta, db.runs, db.items]) {
      expect(await t.where('accountKey').equals(A.key).count()).toBe(0);
    }
    expect(await storage.getItem(comparisonConfigKey(A.key))).toBeNull();
    expect(await storage.getItem(sellingDeckFilterKey(A.key))).toBeNull();
    // Bob is untouched, and is now the current account.
    expect(await B.data.decks.count()).toBe(1);
    expect(await B.data.runs.count()).toBe(1);
    expect(await storage.getItem(comparisonConfigKey(B.key))).not.toBeNull();
    expect(await storage.getItem(sellingDeckFilterKey(B.key))).not.toBeNull();
    expect((await listAccounts()).map((a) => a.key)).toEqual([B.key]);
    expect((await getCurrentAccount())?.key).toBe(B.key);
  });

  it('a tab still logged in as the forgotten account does not bring it back', async () => {
    await forgetAccount(A.key, { stopRuns: async () => {}, syncJobs: [], removeStorage: async () => {} });
    const store = { value: [] as never[], getValue: async () => store.value, setValue: async (v: never[]) => void (store.value = v) };
    await new SessionRegistry(store as never).report({ tabId: 1, type: 'moxfield', hasAuth: true, identity: { userId: '111111', userName: 'alice' } });
    expect(await db.accounts.get(A.key)).toBeUndefined();
  });

  it('finds the account of per-account preferences', () => {
    expect(accountOfPreference('collectionComparison:moxfield:111111')).toBe('moxfield:111111');
    expect(accountOfPreference('sellingDeckFilter:moxfield:111111')).toBe('moxfield:111111');
    expect(accountOfPreference('settings')).toBeNull();
  });
});

describe('Remove all data', () => {
  it('stops every job first, then empties every table and the extension storage', async () => {
    const runA = await fill(A, 'running');
    const runB = await fill(B, 'queued');
    await fill(A);
    await db.f2fCache.add(row({ key: 'x', fetchedAt: 1 }));
    await db.meta.put({ key: 'bulkRates', value: {}, updatedAt: 1 });
    await db.changeOps.add(row({ accountKey: A.key, status: 'done', startedAt: 1 }));
    await scannerDb.refs.add(row({ scryfallId: 's1', modelKey: MODEL_KEY }));
    await storage.setItem('local:settings', { batchSize: 30 });
    const order: string[] = [];
    const job = (name: string) => ({
      cancel: () => (order.push(`cancel ${name}`), true),
      get finished() {
        return Promise.resolve().then(() => void order.push(`${name} finished`));
      },
    });

    await removeAllData({
      stopRuns: async (ids) => void order.push(`stop runs ${[...ids].sort().join(',')}`),
      jobs: [job('sync'), job('export')],
      clearStorage: async () => {
        order.push('storage');
        await browser.storage.local.clear();
      },
    });

    expect(order).toEqual([`stop runs ${[runA, runB].sort().join(',')}`, 'cancel sync', 'sync finished', 'cancel export', 'export finished', 'storage']);
    for (const t of db.tables) expect(await t.count()).toBe(0);
    expect(await scannerDb.refs.count()).toBe(0);
    expect(await listAccounts()).toEqual([]);
    expect(await getCurrentAccount()).toBeNull();
    expect(Object.keys(await browser.storage.local.get(null))).toEqual([]);
  });
});
