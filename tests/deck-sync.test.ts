import { db } from '@/lib/db';
import { refreshCollection } from '@/lib/decks/collection';
import { AccountSyncJob, type SyncTransport } from '@/lib/decks/job';
import { isDeckStale, markDecksSeen, syncDecks } from '@/lib/decks/sync';
import type { AccountData } from '@/lib/accounts/data';
import type { AccountKey } from '@/lib/accounts/types';
import { SiteAuthError, SiteNotFoundError, type DeckSource } from '@/lib/sites/client';
import { moxfieldSite } from '@/lib/sites/moxfield/provider';
import { siteFail, type SiteIdentity, type SiteRequest, type SiteResult } from '@/lib/sites/types';
import type { DeckCard, DeckSummary } from '@/lib/decks/types';
import { DECK_CARDS_VERSION, normalizeDeckCards } from '@/lib/sites/moxfield/decks';
import type { CollectionEntry } from '@/lib/cards/types';
import { normalizeEntry } from '@/lib/sites/moxfield/normalize';
import { clearCaches } from '@/features/f2f-buylist/runner';
import { fixture, newAccount, resetDb } from './helpers';

const deckJson = fixture<any>('moxfield-deck.json');
const CARDS: DeckCard[] = normalizeDeckCards(deckJson).cards;
const page = fixture<{ data: any[] }>('moxfield-page.json');

const summary = (id: string, updated = '2026-01-01T00:00:00Z', folderPath = 'Collection'): DeckSummary => ({
  id,
  publicId: `Public_${id}_xxxx`,
  name: `Deck ${id}`,
  format: 'commander',
  visibility: 'unlisted',
  folderPath,
  lastUpdatedAt: updated,
  createdAt: '2025-01-01T00:00:00Z',
  mainboardCount: 99,
  sideboardCount: 0,
  maybeboardCount: 0,
  commanders: [],
  publicUrl: `https://moxfield.com/decks/Public_${id}_xxxx`,
});

/** Fake Moxfield: a deck list and per-deck answers; records what was asked. */
class FakeMox implements DeckSource {
  list: DeckSummary[] = [];
  asked: string[] = [];
  fail = new Map<string, Error>();
  async deckList() {
    this.asked.push('list');
    return this.list.map((d) => ({ ...d }));
  }
  async deck(publicId: string) {
    this.asked.push(publicId);
    const err = this.fail.get(publicId);
    if (err) throw err;
    return { lastUpdatedAt: '', cards: CARDS };
  }
}

let A: AccountData;
let ALICE: SiteIdentity;
let KEY: AccountKey;

async function reset() {
  await resetDb();
  const a = await newAccount('111111', 'alice');
  A = a.data;
  ALICE = a.identity;
  KEY = a.key;
}

describe('Deck sync', () => {
  beforeEach(reset);

  it('first sync reads the list and every deck, marking nothing as new', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a'), summary('b'), summary('c')];
    const res = await syncDecks(moxfieldSite, A, mox);
    expect(mox.asked).toEqual(['list', 'Public_a_xxxx', 'Public_b_xxxx', 'Public_c_xxxx']);
    expect(res).toMatchObject({ total: 3, added: 3, changed: 0, removed: 0, fetched: 3, failed: [] });
    const rows = await A.decks.list();
    expect(rows.every((d) => !d.isNew && !isDeckStale(d, DECK_CARDS_VERSION))).toBe(true);
    expect(rows[0].cardCount).toBe(CARDS.reduce((s, c) => s + c.qty, 0));
    expect((await A.deckCards.get('a'))!.cards).toHaveLength(CARDS.length);
    expect((await A.meta.get('decks'))!.lastSuccessAt).toBeGreaterThan(0);
  });

  it('later syncs only read new and changed decks, and drop deleted ones', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a'), summary('b'), summary('c')];
    await syncDecks(moxfieldSite, A, mox);

    mox.asked = [];
    expect(await syncDecks(moxfieldSite, A, mox)).toMatchObject({ fetched: 0, added: 0 });
    expect(mox.asked).toEqual(['list']);

    mox.asked = [];
    mox.list = [summary('a'), summary('b', '2026-02-02T00:00:00Z'), summary('d')]; // b changed, c deleted, d new
    const res = await syncDecks(moxfieldSite, A, mox);
    expect(mox.asked).toEqual(['list', 'Public_d_xxxx', 'Public_b_xxxx']); // new decks first
    expect(res).toMatchObject({ total: 3, added: 1, changed: 1, removed: 1, fetched: 2 });
    expect(await A.decks.get('c')).toBeUndefined();
    expect(await A.deckCards.get('c')).toBeUndefined();
    expect((await A.decks.get('d'))!.isNew).toBe(true);
    expect((await A.decks.get('b'))!.isNew).toBe(false);
    await markDecksSeen(A);
    expect((await A.decks.get('d'))!.isNew).toBe(false);
  });

  it('keeps finished decks when a sync stops midway, and resumes with the rest', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a'), summary('b'), summary('c')];
    mox.fail.set('Public_b_xxxx', new SiteAuthError('log in', 401, 'no_auth'));
    await expect(syncDecks(moxfieldSite, A, mox)).rejects.toBeInstanceOf(SiteAuthError);
    expect((await A.deckCards.get('a'))).toBeDefined();
    expect(await A.meta.get('decks')).toBeUndefined();

    mox.fail.clear();
    mox.asked = [];
    await syncDecks(moxfieldSite, A, mox);
    expect(mox.asked).toEqual(['list', 'Public_b_xxxx', 'Public_c_xxxx']);
    // Still the first successful sync: nothing is "new".
    expect((await A.decks.list()).some((d) => d.isNew)).toBe(false);
  });

  it('records per-deck errors, deletes 404 decks, and keeps the cache on an empty list', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a'), summary('b'), summary('c')];
    mox.fail.set('Public_a_xxxx', new Error('weird answer'));
    mox.fail.set('Public_b_xxxx', new SiteNotFoundError('gone', 404, 'not_found'));
    const res = await syncDecks(moxfieldSite, A, mox);
    expect(res.failed).toEqual([{ id: 'a', name: 'Deck a', error: 'weird answer' }]);
    expect(res.removed).toBe(1);
    expect((await A.decks.get('a'))!.error).toBe('weird answer');
    expect(isDeckStale((await A.decks.get('a'))!, DECK_CARDS_VERSION)).toBe(true);
    expect(await A.decks.get('b')).toBeUndefined();

    mox.list = [];
    await expect(syncDecks(moxfieldSite, A, mox)).rejects.toThrow(/empty deck list/);
    expect(await A.decks.count()).toBe(2);
  });

  it('re-reads every deck when the card format version changes', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a'), summary('b')];
    await syncDecks(moxfieldSite, A, mox);
    await A.write((w) => w.decks.update('a', { cardsV: DECK_CARDS_VERSION - 1 }));
    mox.asked = [];
    await syncDecks(moxfieldSite, A, mox);
    expect(mox.asked).toEqual(['list', 'Public_a_xxxx']);
  });

  it('survives "Clear F2F cache"', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a')];
    await syncDecks(moxfieldSite, A, mox);
    await clearCaches();
    expect(await A.decks.count()).toBe(1);
    expect(await A.meta.get('decks')).toBeDefined();
  });
});

describe('Collection snapshot', () => {
  beforeEach(reset);

  it('reads every page and keeps each row once', async () => {
    const entries = page.data.map(normalizeEntry).filter((e): e is CollectionEntry => e !== null);
    const half = Math.ceil(entries.length / 2);
    const pages = [entries.slice(0, half), [...entries.slice(half), entries[0]]];
    const asked: number[] = [];
    const meta = await refreshCollection(moxfieldSite, A, {
      collectionPage: async (n: number, size: number) => {
        asked.push(n);
        return { entries: pages[n - 1], totalResults: entries.length, totalPages: 2, pageSize: size };
      },
    });
    expect(asked).toEqual([1, 2]);
    expect(meta.entries).toBe(entries.length);
    expect(await A.collection.count()).toBe(entries.length);
    expect((await A.meta.get('collection'))!.entries).toBe(entries.length);
  });
});

describe('AccountSyncJob', () => {
  beforeEach(reset);

  /** Transport answering like a Moxfield tab, from a fake list + the deck fixture + the collection fixture. */
  function fakeTransport(opts: { list: DeckSummary[]; gate?: Promise<void>; deckAnswer?: SiteResult; as?: SiteIdentity }) {
    const calls: SiteRequest[] = [];
    let released = 0;
    const as = () => opts.as ?? ALICE;
    const transport: SyncTransport = {
      call: async (req) => {
        calls.push(req);
        if (req.kind === 'deckList') {
          await opts.gate;
          return { ok: true, kind: 'deckList', decks: opts.list, as: as() };
        }
        if (req.kind === 'deck') return opts.deckAnswer ? { ...opts.deckAnswer, as: as() } : { ok: true, kind: 'deck', lastUpdatedAt: '', cards: CARDS, as: as() };
        const entries = page.data.map(normalizeEntry).filter((e): e is CollectionEntry => e !== null);
        return { ok: true, kind: 'collection', entries, totalResults: entries.length, totalPages: 1, pageSize: 5000, as: as() };
      },
      connect: async () => ({ ok: true, identity: as() }),
      get identity() {
        return as();
      },
      release: async () => {
        released++;
      },
    };
    return { transport, calls, released: () => released };
  }

  const fast = { intervalMs: 0, jitterMs: 0, sleep: async () => {} };

  it('answers at once, then syncs decks and the collection in the background', async () => {
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const t = fakeTransport({ list: [summary('a'), summary('b')], gate });
    const active: boolean[] = [];
    const job = new AccountSyncJob(moxfieldSite, { createTransport: () => t.transport, onActiveChange: (a) => active.push(a), clientOptions: fast });

    const first = await job.start({ accountKey: KEY, collection: false });
    expect(first).toMatchObject({ ok: true, alreadyRunning: false, accountKey: KEY });
    if (!first.ok) throw new Error('not started');
    expect((await A.meta.get('sync'))!.status).toBe('running');
    // A "Find mismatches" while the deck sync runs joins it and adds the collection step.
    expect(await job.start({ accountKey: KEY, collection: true })).toEqual({ ok: true, jobId: first.jobId, accountKey: KEY, alreadyRunning: true });
    open();
    await job.finished;

    const state = (await A.meta.get('sync'))!;
    expect(state).toMatchObject({ jobId: first.jobId, status: 'done', phase: 'done', withCollection: true, requests: 4 });
    expect(state.decks).toMatchObject({ total: 2, fetched: 2 });
    expect(t.calls.map((c) => c.kind)).toEqual(['deckList', 'deck', 'deck', 'collection']);
    expect(await A.collection.count()).toBeGreaterThan(0);
    expect(t.released()).toBe(1);
    expect(active).toEqual([true, false]);
  });

  it('reports errors and cancellation', async () => {
    const auth = fakeTransport({ list: [summary('a')], deckAnswer: siteFail(401, 'no_auth', 'Log in to Moxfield') });
    const job = new AccountSyncJob(moxfieldSite, { createTransport: () => auth.transport, clientOptions: fast });
    await job.start({ accountKey: KEY, collection: true });
    await job.finished;
    expect(await A.meta.get('sync')).toMatchObject({ status: 'error', error: 'Log in to Moxfield' });

    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const slow = fakeTransport({ list: [summary('a')], gate });
    const job2 = new AccountSyncJob(moxfieldSite, { createTransport: () => slow.transport, clientOptions: fast });
    await job2.start({ accountKey: KEY, collection: false });
    expect(job2.cancel()).toBe(true);
    open();
    await job2.finished;
    expect((await A.meta.get('sync'))!.status).toBe('cancelled');
  });

  it('marks a job left running by a previous worker as interrupted', async () => {
    await A.write((w) => w.meta.put('sync', { jobId: 'old', accountKey: KEY, status: 'running', phase: 'decks', withCollection: false, done: 3, total: 9, startedAt: 1, heartbeatAt: 1, requests: 4 }));
    await new AccountSyncJob(moxfieldSite, { createTransport: () => fakeTransport({ list: [] }).transport }).markStale();
    expect((await A.meta.get('sync'))!.status).toBe('interrupted');
  });
});
