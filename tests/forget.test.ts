import { storage } from '#imports';
import { getCurrentAccount, listAccounts, type AccountData } from '@/lib/accounts/data';
import { forgetAccount } from '@/lib/accounts/forget';
import type { AccountKey } from '@/lib/accounts/types';
import { db } from '@/lib/db';
import { SessionRegistry } from '@/lib/sites/sessions';
import { mismatchConfigKey } from '@/features/deck-mismatch/config';
import { accountOfPreference } from '@/features/settings/stored-data';
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
  await storage.setItem(mismatchConfigKey(acc.key), { excludedDeckIds: ['d1'] });
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
    expect(await storage.getItem(mismatchConfigKey(A.key))).toBeNull();
    // Bob is untouched, and is now the current account.
    expect(await B.data.decks.count()).toBe(1);
    expect(await B.data.runs.count()).toBe(1);
    expect(await storage.getItem(mismatchConfigKey(B.key))).not.toBeNull();
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
    expect(accountOfPreference('deckMismatchConfig:moxfield:111111')).toBe('moxfield:111111');
    expect(accountOfPreference('settings')).toBeNull();
  });
});
