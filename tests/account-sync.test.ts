/**
 * The whole sync stack against fake Moxfield tabs whose login changes: AccountSyncJob → TabTransport
 * → SiteClient → syncDecks / refreshCollection → the account access layer. Nothing read as another
 * account may ever be written into (or delete anything from) the account being synced.
 */
import { getCurrentAccount, listAccounts, type AccountData } from '@/lib/accounts/data';
import type { AccountKey } from '@/lib/accounts/types';
import type { CollectionEntry } from '@/lib/cards/types';
import { db } from '@/lib/db';
import { AccountSyncJob } from '@/lib/decks/job';
import type { DeckCard, DeckSummary } from '@/lib/decks/types';
import { normalizeDeckCards } from '@/lib/sites/moxfield/decks';
import { normalizeEntry } from '@/lib/sites/moxfield/normalize';
import { moxfieldSite } from '@/lib/sites/moxfield/provider';
import { TabTransport } from '@/lib/sites/tab-transport';
import { siteFail, type SiteApiCall, type SiteIdentity, type SiteResult } from '@/lib/sites/types';
import { ALICE, BOB, FakeTabs } from './fake-tabs';
import { fixture, newAccount, resetDb } from './helpers';

const CARDS: DeckCard[] = normalizeDeckCards(fixture<any>('moxfield-deck.json')).cards;
const ENTRIES: CollectionEntry[] = fixture<{ data: unknown[] }>('moxfield-page.json').data.map(normalizeEntry).filter((e): e is CollectionEntry => !!e);

const summary = (id: string, updated = '2026-01-01T00:00:00Z'): DeckSummary => ({
  id,
  publicId: `Public_${id}_xxxx`,
  name: `Deck ${id}`,
  format: 'commander',
  visibility: 'private',
  folderPath: '',
  lastUpdatedAt: updated,
  createdAt: '2025-01-01T00:00:00Z',
  mainboardCount: 99,
  sideboardCount: 0,
  maybeboardCount: 0,
  commanders: [],
  publicUrl: `https://moxfield.com/decks/Public_${id}_xxxx`,
});
const DECKS: Record<string, DeckSummary[]> = {
  [ALICE.userId]: ['a', 'b', 'c', 'd', 'e'].map((id) => summary(id)),
  // Bob's decks have the same ids: only the account keeps them apart.
  [BOB.userId]: ['a', 'x'].map((id) => summary(id, '2026-03-03T00:00:00Z')),
};

const publicIdOf = (call: SiteApiCall) => (call.req.kind === 'deck' ? call.req.publicId : null);

/** Fake Moxfield tabs answering each account with its own decks and collection. */
function moxTabs(account: SiteIdentity | null = ALICE) {
  const port = new FakeTabs();
  port.tabs = [{ id: 1, active: true, account }];
  port.answer = (as, { req }): SiteResult => {
    if (req.kind === 'deckList') return { ok: true, kind: 'deckList', decks: DECKS[as.userId] ?? [] };
    if (req.kind === 'deck') return { ok: true, kind: 'deck', lastUpdatedAt: '', cards: CARDS };
    const half = Math.ceil(ENTRIES.length / 2);
    const entries = as.userId === ALICE.userId ? (req.pageNumber === 1 ? ENTRIES.slice(0, half) : ENTRIES.slice(half)) : ENTRIES.slice(0, 1);
    return { ok: true, kind: 'collection', entries, totalResults: ENTRIES.length, totalPages: 2, pageSize: req.pageSize };
  };
  return port;
}

const fast = { intervalMs: 0, jitterMs: 0, maxIntervalMs: 0, rateLimitWaitsMs: [], errorWaitsMs: [], sleep: async () => {} };
const newJob = (port: FakeTabs) =>
  new AccountSyncJob(moxfieldSite, {
    createTransport: ({ expect, ...ctl }) => new TabTransport(moxfieldSite, { ...ctl, expect, authWaitMs: 30, pollMs: 5, reloadSettleMs: 0 }, port),
    clientOptions: fast,
  });

async function sync(port: FakeTabs, key: AccountKey | null, collection = false) {
  const job = newJob(port);
  const res = await job.start({ accountKey: key, collection });
  await job.finished;
  return res;
}

let A: { key: AccountKey; data: AccountData };

beforeEach(async () => {
  await resetDb();
  A = await newAccount(ALICE.userId, ALICE.userName);
});

const deckIds = async (data: AccountData) => (await data.decks.list()).map((d) => d.id).sort();
const cardIds = async (data: AccountData) => (await data.deckCards.list()).map((d) => d.deckId).sort();

describe('Sync as an account, with the site logged in as another', () => {
  it('stops before any request when the site is logged in as someone else', async () => {
    const port = moxTabs(BOB);
    expect(await sync(port, A.key)).toMatchObject({ ok: true, accountKey: A.key });
    expect(port.calls).toEqual([]);
    expect(port.created).toEqual([]); // a new tab would be logged in as bob too
    expect(await A.data.decks.count()).toBe(0);
    expect(await A.data.meta.get('sync')).toMatchObject({ status: 'error', code: 'wrong_account', actual: BOB, error: 'Moxfield is logged in as bob. Log in as alice on Moxfield, then try again.' });
  });

  it('a deck list answered as someone else deletes nothing', async () => {
    const port = moxTabs();
    await sync(port, A.key);
    expect(await deckIds(A.data)).toEqual(['a', 'b', 'c', 'd', 'e']);
    for (const buggy of [false, true]) {
      // The tab logs in as bob right as the list is asked for (a buggy page even sends it as bob).
      port.tabs[0].account = ALICE;
      port.tabs[0].ignoresExpect = buggy;
      port.onCall = (call, tab) => {
        if (call.req.kind === 'deckList') tab.account = BOB;
      };
      await sync(port, A.key);
      expect(await deckIds(A.data)).toEqual(['a', 'b', 'c', 'd', 'e']);
      expect(await A.data.meta.get('sync')).toMatchObject({ status: 'error', code: 'wrong_account', actual: BOB });
    }
  });

  it('a login change mid-sync keeps what was read, deletes nothing, and the next sync resumes', async () => {
    const port = moxTabs();
    port.onCall = (call, tab) => {
      if (publicIdOf(call) === 'Public_c_xxxx') tab.account = BOB;
    };
    await sync(port, A.key);
    expect(await cardIds(A.data)).toEqual(['a', 'b']);
    expect(await deckIds(A.data)).toEqual(['a', 'b', 'c', 'd', 'e']);
    const state = await A.data.meta.get('sync');
    expect(state).toMatchObject({ status: 'error', code: 'wrong_account', actual: BOB, error: 'Moxfield is now logged in as bob, so the sync stopped. What was read before is kept.' });

    // Back as alice: only the decks left are read.
    port.tabs[0].account = ALICE;
    port.onCall = () => {};
    port.calls = [];
    await sync(port, A.key);
    expect(port.calls.map((c) => publicIdOf(c.call) ?? c.call.req.kind)).toEqual(['deckList', 'Public_c_xxxx', 'Public_d_xxxx', 'Public_e_xxxx']);
    expect(await cardIds(A.data)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('a 404 answered as someone else is not "deck deleted"; a 404 as the account is', async () => {
    const port = moxTabs();
    port.tabs[0].ignoresExpect = true; // the page sends it as whoever is logged in
    const notFound = port.answer;
    port.answer = (as, call, tab) => (publicIdOf(call) === 'Public_c_xxxx' ? siteFail(404, 'http', 'Moxfield answered HTTP 404') : notFound(as, call, tab));
    port.onCall = (call, tab) => {
      if (publicIdOf(call) === 'Public_c_xxxx') tab.account = BOB;
    };
    await sync(port, A.key);
    expect(await deckIds(A.data)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(await A.data.meta.get('sync')).toMatchObject({ code: 'wrong_account', actual: BOB });

    // The same 404 as alice: c really is gone.
    port.tabs[0].account = ALICE;
    port.onCall = () => {};
    await sync(port, A.key);
    expect(await deckIds(A.data)).toEqual(['a', 'b', 'd', 'e']);
    expect(await A.data.meta.get('sync')).toMatchObject({ status: 'done' });
  });

  it('a collection answered (even partly) as someone else leaves the previous snapshot as is', async () => {
    const port = moxTabs();
    await sync(port, A.key, true);
    const before = await A.data.meta.get('collection');
    expect(before?.entries).toBe(ENTRIES.length);
    port.tabs[0].ignoresExpect = true;
    for (const switchAtPage of [1, 2]) {
      port.tabs[0].account = ALICE;
      port.onCall = (call, tab) => {
        if (call.req.kind === 'collection' && call.req.pageNumber === switchAtPage) tab.account = BOB;
      };
      await sync(port, A.key, true);
      expect(await A.data.meta.get('collection')).toEqual(before);
      expect(await A.data.collection.count()).toBe(ENTRIES.length);
      expect(await A.data.meta.get('sync')).toMatchObject({ status: 'error', code: 'wrong_account' });
    }
  });

  it("never trusts a tab that doesn't say who answered", async () => {
    const port = moxTabs();
    const call = port.call.bind(port);
    port.call = async (tabId, c) => {
      const { as: _as, ...res } = await call(tabId, c);
      return res as SiteResult;
    };
    await sync(port, A.key);
    expect(await A.data.decks.count()).toBe(0);
    expect(await A.data.meta.get('sync')).toMatchObject({ status: 'error', error: expect.stringContaining('older version of Tithies') });
  });
});

describe('Sync jobs and accounts', () => {
  it("a sync for another account waits for the running one", async () => {
    const port = moxTabs();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    port.onCall = async (call) => {
      if (call.req.kind === 'deckList') await gate;
    };
    const B = await newAccount(BOB.userId, BOB.userName);
    const job = newJob(port);
    expect(await job.start({ accountKey: A.key, collection: false })).toMatchObject({ ok: true });
    expect(await job.start({ accountKey: B.key, collection: false })).toMatchObject({ ok: false, code: 'busy', busyWith: A.key });
    // The same account (or "no account") joins it.
    expect(await job.start({ accountKey: null, collection: true })).toMatchObject({ ok: true, alreadyRunning: true, accountKey: A.key });
    open();
    await job.finished;
    expect(await B.data.decks.count()).toBe(0);
  });

  it('an account forgotten mid-sync gets nothing written', async () => {
    const port = moxTabs();
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    port.onCall = async (call) => {
      if (publicIdOf(call) === 'Public_b_xxxx') await gate;
    };
    const job = newJob(port);
    await job.start({ accountKey: A.key, collection: true });
    await new Promise((r) => setTimeout(r, 20));
    await A.data.removeAll();
    open();
    await job.finished;
    for (const t of [db.accountDecks, db.accountDeckCards, db.collectionEntries, db.accountMeta]) {
      expect(await t.where('accountKey').equals(A.key).count()).toBe(0);
    }
    expect(await listAccounts()).toEqual([]);
  });

  it('a first sync with no account adopts the logged-in one and makes it current', async () => {
    await resetDb();
    const port = moxTabs(BOB);
    const res = await sync(port, null);
    expect(res).toMatchObject({ ok: true, accountKey: 'moxfield:222222' });
    expect((await getCurrentAccount())?.userName).toBe('bob');
    expect((await listAccounts()).map((a) => a.key)).toEqual(['moxfield:222222']);
    // Every request was bound to bob once he was found.
    expect(port.calls.every((c) => c.call.expect === BOB.userId)).toBe(true);
    expect(await db.accountDecks.where('accountKey').equals('moxfield:222222').count()).toBe(2);
  });

  it('a first sync with nobody logged in adds no account', async () => {
    await resetDb();
    const port = moxTabs(null);
    port.tabs = [];
    expect(await sync(port, null)).toMatchObject({ ok: false, code: 'no_tab' });
    expect(await listAccounts()).toEqual([]);
  });
});
