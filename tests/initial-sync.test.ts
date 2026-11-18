import { getInitialSyncDismissed, setInitialSyncDismissed } from '@/lib/accounts/data';
import { accountKey, type AccountKey, type AccountRow } from '@/lib/accounts/types';
import { db } from '@/lib/db';
import { candidateId, initialSyncCandidates, initialSyncStateOf, isSetUp, readSyncSetups, syncSetupOf, type CandidateInput, type SyncSetup } from '@/lib/decks/initial-sync';
import { newAccount, resetDb } from './helpers';

const ALICE = { userId: '111111', userName: 'alice' };
const BOB = { userId: '222222', userName: 'bob' };
const CAROL = { userId: '333333', userName: 'carol' };
const key = (id: { userId: string }) => accountKey('moxfield', id.userId);
const row = (id: { userId: string; userName: string }, lastUsedAt = 1): AccountRow => ({
  key: key(id),
  type: 'moxfield',
  userId: id.userId,
  userName: id.userName,
  addedAt: 1,
  lastUsedAt,
  lastSeenAt: 1,
});
const DONE: SyncSetup = { decksSyncedAt: 5, collectionReadAt: 6, running: false };
const NEVER: SyncSetup = { running: false };

const candidates = (p: Partial<CandidateInput>) =>
  initialSyncCandidates({ accounts: [], currentKey: null, live: {}, setups: new Map(), dismissed: new Set(), siteTypes: ['moxfield'], ...p }).map((c) => `${c.kind}:${candidateId(c)}`);

beforeEach(resetDb);

describe('Initial sync candidates', () => {
  it('a fresh install with nobody logged in: the site itself', () => {
    expect(candidates({})).toEqual(['none:none:moxfield']);
  });

  it('an account logged in that Tithies does not know', () => {
    expect(candidates({ live: { moxfield: [BOB] } })).toEqual([`unknown:${key(BOB)}`]);
    const alice = row(ALICE);
    expect(candidates({ accounts: [alice], currentKey: alice.key, live: { moxfield: [BOB] }, setups: new Map([[alice.key, DONE]]) })).toEqual([`unknown:${key(BOB)}`]);
  });

  it('the current account and the logged-in ones while never read, current first', () => {
    const [alice, bob, carol] = [row(ALICE), row(BOB), row(CAROL)];
    const setups = new Map<AccountKey, SyncSetup>([
      [alice.key, NEVER],
      [bob.key, { decksSyncedAt: 5, running: false }],
      [carol.key, NEVER],
    ]);
    // Carol is neither current nor logged in: not offered (it can't be read now anyway).
    expect(candidates({ accounts: [bob, alice, carol], currentKey: alice.key, live: { moxfield: [BOB] }, setups })).toEqual([`unsynced:${alice.key}`, `unsynced:${bob.key}`]);
  });

  it('never an account that is set up, being synced, still loading, or dismissed', () => {
    const alice = row(ALICE);
    const base = { accounts: [alice], currentKey: alice.key };
    expect(candidates({ ...base, setups: new Map([[alice.key, DONE]]) })).toEqual([]);
    expect(candidates({ ...base, setups: new Map([[alice.key, { running: true }]]) })).toEqual([]);
    expect(candidates({ ...base, setups: new Map() })).toEqual([]);
    expect(candidates({ ...base, setups: new Map([[alice.key, NEVER]]), dismissed: new Set([alice.key]) })).toEqual([]);
    expect(candidates({ ...base, setups: new Map([[alice.key, DONE]]), live: { moxfield: [BOB] }, dismissed: new Set([key(BOB)]) })).toEqual([]);
  });

  it('no "none" once an account exists or someone is logged in', () => {
    const alice = row(ALICE);
    expect(candidates({ accounts: [alice], currentKey: alice.key, setups: new Map([[alice.key, DONE]]) })).toEqual([]);
    expect(candidates({ live: { moxfield: [ALICE] }, dismissed: new Set([key(ALICE)]) })).toEqual([]);
  });

  it('a set-up account has read both its decks and its collection', () => {
    expect(isSetUp(DONE)).toBe(true);
    expect(isSetUp({ decksSyncedAt: 5 })).toBe(false);
    expect(isSetUp({ collectionReadAt: 5 })).toBe(false);
  });
});

describe('Sync setup of an account', () => {
  it('is read from its decks, collection and sync meta', async () => {
    const a = await newAccount(ALICE.userId, ALICE.userName);
    expect(await syncSetupOf(a.data)).toEqual({ decksSyncedAt: undefined, collectionReadAt: undefined, running: false });
    await a.data.write(async (w) => {
      await w.meta.put('decks', { lastSuccessAt: 10, initialSyncAt: 10 });
      await w.meta.put('sync', { status: 'running' } as never);
    });
    expect(await syncSetupOf(a.data)).toEqual({ decksSyncedAt: 10, collectionReadAt: undefined, running: true });
    await a.data.write((w) => w.collection.replace([], { fetchedAt: 20, entries: 0, copies: 0 }));
    const b = await newAccount(BOB.userId, BOB.userName);
    const setups = await readSyncSetups([a.key, b.key]);
    expect(isSetUp(setups.get(a.key)!)).toBe(true);
    expect(setups.get(b.key)).toEqual({ decksSyncedAt: undefined, collectionReadAt: undefined, running: false });
  });
});

describe('Initial sync state of one account (the Moxfield panel)', () => {
  it('is needed for an account not in Tithies or never fully read, unless dismissed; asking adds nothing', async () => {
    expect(await initialSyncStateOf(key(BOB))).toEqual({ known: false, needed: true, running: false });
    expect(await db.accounts.count()).toBe(0);
    const a = await newAccount(ALICE.userId, ALICE.userName);
    expect(await initialSyncStateOf(a.key)).toEqual({ known: true, needed: true, running: false });
    await a.data.write(async (w) => {
      await w.meta.put('decks', { lastSuccessAt: 1, initialSyncAt: 1 });
      await w.collection.replace([], { fetchedAt: 2, entries: 0, copies: 0 });
    });
    expect(await initialSyncStateOf(a.key)).toEqual({ known: true, needed: false, running: false });
    await setInitialSyncDismissed(key(BOB), true);
    expect(await initialSyncStateOf(key(BOB))).toEqual({ known: false, needed: false, running: false });
  });
});

describe('"Not now"', () => {
  it('is remembered per account, also for accounts not in Tithies yet', async () => {
    await setInitialSyncDismissed(key(ALICE), true);
    await setInitialSyncDismissed(key(ALICE), true);
    await setInitialSyncDismissed(key(BOB), true);
    expect(await getInitialSyncDismissed()).toEqual([key(ALICE), key(BOB)]);
    await setInitialSyncDismissed(key(ALICE), false);
    expect(await getInitialSyncDismissed()).toEqual([key(BOB)]);
    await setInitialSyncDismissed(key(BOB), false);
    expect(await db.meta.get('initialSyncDismissed')).toBeUndefined();
  });

  it('is forgotten with the account (it comes back as new)', async () => {
    const a = await newAccount(ALICE.userId, ALICE.userName);
    await setInitialSyncDismissed(a.key, true);
    await setInitialSyncDismissed(key(BOB), true);
    await a.data.removeAll();
    expect(await getInitialSyncDismissed()).toEqual([key(BOB)]);
  });
});
