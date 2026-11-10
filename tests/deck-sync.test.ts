import { db, getMeta } from '@/lib/db';
import { refreshCollection } from '@/lib/decks/collection';
import { MoxfieldSyncJob, type SyncTransport } from '@/lib/decks/job';
import { isDeckStale, markDecksSeen, syncDecks } from '@/lib/decks/sync';
import { META_DECKS, META_SYNC, type DecksMeta, type MoxSyncState } from '@/lib/decks/types';
import { moxFail, type MoxApiRequest, type MoxApiResult } from '@/lib/moxfield/api';
import { MoxAuthError, MoxNotFoundError, type DeckSource } from '@/lib/moxfield/client';
import { DECK_CARDS_VERSION, normalizeDeckCards, type DeckCard, type DeckSummary } from '@/lib/moxfield/decks';
import { normalizeEntry, type MoxEntry } from '@/lib/moxfield/normalize';
import { clearCaches } from '@/features/f2f-buylist/runner';
import { fixture } from './helpers';

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

async function reset() {
  await Promise.all([db.decks.clear(), db.deckCards.clear(), db.moxCollection.clear(), db.meta.clear()]);
}

describe('Deck sync', () => {
  beforeEach(reset);

  it('first sync reads the list and every deck, marking nothing as new', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a'), summary('b'), summary('c')];
    const res = await syncDecks(mox);
    expect(mox.asked).toEqual(['list', 'Public_a_xxxx', 'Public_b_xxxx', 'Public_c_xxxx']);
    expect(res).toMatchObject({ total: 3, added: 3, changed: 0, removed: 0, fetched: 3, failed: [] });
    const rows = await db.decks.toArray();
    expect(rows.every((d) => !d.isNew && !isDeckStale(d))).toBe(true);
    expect(rows[0].cardCount).toBe(CARDS.reduce((s, c) => s + c.qty, 0));
    expect((await db.deckCards.get('a'))!.cards).toHaveLength(CARDS.length);
    expect((await getMeta<DecksMeta>(META_DECKS))!.lastSuccessAt).toBeGreaterThan(0);
  });

  it('later syncs only read new and changed decks, and drop deleted ones', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a'), summary('b'), summary('c')];
    await syncDecks(mox);

    mox.asked = [];
    expect(await syncDecks(mox)).toMatchObject({ fetched: 0, added: 0 });
    expect(mox.asked).toEqual(['list']);

    mox.asked = [];
    mox.list = [summary('a'), summary('b', '2026-02-02T00:00:00Z'), summary('d')]; // b changed, c deleted, d new
    const res = await syncDecks(mox);
    expect(mox.asked).toEqual(['list', 'Public_d_xxxx', 'Public_b_xxxx']); // new decks first
    expect(res).toMatchObject({ total: 3, added: 1, changed: 1, removed: 1, fetched: 2 });
    expect(await db.decks.get('c')).toBeUndefined();
    expect(await db.deckCards.get('c')).toBeUndefined();
    expect((await db.decks.get('d'))!.isNew).toBe(true);
    expect((await db.decks.get('b'))!.isNew).toBe(false);
    await markDecksSeen();
    expect((await db.decks.get('d'))!.isNew).toBe(false);
  });

  it('keeps finished decks when a sync stops midway, and resumes with the rest', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a'), summary('b'), summary('c')];
    mox.fail.set('Public_b_xxxx', new MoxAuthError('log in', 401, 'no_auth'));
    await expect(syncDecks(mox)).rejects.toBeInstanceOf(MoxAuthError);
    expect((await db.deckCards.get('a'))).toBeDefined();
    expect(await getMeta(META_DECKS)).toBeUndefined();

    mox.fail.clear();
    mox.asked = [];
    await syncDecks(mox);
    expect(mox.asked).toEqual(['list', 'Public_b_xxxx', 'Public_c_xxxx']);
    // Still the first successful sync: nothing is "new".
    expect((await db.decks.toArray()).some((d) => d.isNew)).toBe(false);
  });

  it('records per-deck errors, deletes 404 decks, and keeps the cache on an empty list', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a'), summary('b'), summary('c')];
    mox.fail.set('Public_a_xxxx', new Error('weird answer'));
    mox.fail.set('Public_b_xxxx', new MoxNotFoundError('gone', 404, 'not_found'));
    const res = await syncDecks(mox);
    expect(res.failed).toEqual([{ id: 'a', name: 'Deck a', error: 'weird answer' }]);
    expect(res.removed).toBe(1);
    expect((await db.decks.get('a'))!.error).toBe('weird answer');
    expect(isDeckStale((await db.decks.get('a'))!)).toBe(true);
    expect(await db.decks.get('b')).toBeUndefined();

    mox.list = [];
    await expect(syncDecks(mox)).rejects.toThrow(/empty deck list/);
    expect(await db.decks.count()).toBe(2);
  });

  it('re-reads every deck when the card format version changes', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a'), summary('b')];
    await syncDecks(mox);
    await db.decks.update('a', { cardsV: DECK_CARDS_VERSION - 1 });
    mox.asked = [];
    await syncDecks(mox);
    expect(mox.asked).toEqual(['list', 'Public_a_xxxx']);
  });

  it('survives "Clear F2F cache"', async () => {
    const mox = new FakeMox();
    mox.list = [summary('a')];
    await syncDecks(mox);
    await clearCaches();
    expect(await db.decks.count()).toBe(1);
    expect(await getMeta(META_DECKS)).toBeDefined();
  });
});

describe('Collection snapshot', () => {
  beforeEach(reset);

  it('reads every page and keeps each row once', async () => {
    const entries = page.data.map(normalizeEntry).filter((e): e is MoxEntry => e !== null);
    const half = Math.ceil(entries.length / 2);
    const pages = [entries.slice(0, half), [...entries.slice(half), entries[0]]];
    const asked: number[] = [];
    const meta = await refreshCollection({
      collectionPage: async (n: number, size: number) => {
        asked.push(n);
        return { entries: pages[n - 1], totalResults: entries.length, totalPages: 2, pageSize: size };
      },
    });
    expect(asked).toEqual([1, 2]);
    expect(meta.entries).toBe(entries.length);
    expect(await db.moxCollection.count()).toBe(entries.length);
  });
});

describe('MoxfieldSyncJob', () => {
  beforeEach(reset);

  /** Transport answering like a Moxfield tab, from a fake list + the deck fixture + the collection fixture. */
  function fakeTransport(opts: { list: DeckSummary[]; gate?: Promise<void>; deckAnswer?: MoxApiResult }) {
    const calls: MoxApiRequest[] = [];
    let released = 0;
    const transport: SyncTransport = {
      call: async (req) => {
        calls.push(req);
        if (req.kind === 'deckList') {
          await opts.gate;
          return { ok: true, kind: 'deckList', decks: opts.list };
        }
        if (req.kind === 'deck') return opts.deckAnswer ?? { ok: true, kind: 'deck', lastUpdatedAt: '', cards: CARDS };
        const entries = page.data.map(normalizeEntry).filter((e): e is MoxEntry => e !== null);
        return { ok: true, kind: 'collection', entries, totalResults: entries.length, totalPages: 1, pageSize: 5000 };
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
    const job = new MoxfieldSyncJob({ createTransport: () => t.transport, onActiveChange: (a) => active.push(a), clientOptions: fast });

    const first = await job.start({ collection: false });
    expect(first.alreadyRunning).toBe(false);
    expect((await getMeta<MoxSyncState>(META_SYNC))!.status).toBe('running');
    // A "Find mismatches" while the deck sync runs joins it and adds the collection step.
    expect(await job.start({ collection: true })).toEqual({ jobId: first.jobId, alreadyRunning: true });
    open();
    await job.finished;

    const state = (await getMeta<MoxSyncState>(META_SYNC))!;
    expect(state).toMatchObject({ jobId: first.jobId, status: 'done', phase: 'done', withCollection: true, requests: 4 });
    expect(state.decks).toMatchObject({ total: 2, fetched: 2 });
    expect(t.calls.map((c) => c.kind)).toEqual(['deckList', 'deck', 'deck', 'collection']);
    expect(await db.moxCollection.count()).toBeGreaterThan(0);
    expect(t.released()).toBe(1);
    expect(active).toEqual([true, false]);
  });

  it('reports errors and cancellation', async () => {
    const auth = fakeTransport({ list: [summary('a')], deckAnswer: moxFail(401, 'no_auth', 'Log in to Moxfield') });
    const job = new MoxfieldSyncJob({ createTransport: () => auth.transport, clientOptions: fast });
    await job.start({ collection: true });
    await job.finished;
    expect(await getMeta<MoxSyncState>(META_SYNC)).toMatchObject({ status: 'error', error: 'Log in to Moxfield' });

    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const slow = fakeTransport({ list: [summary('a')], gate });
    const job2 = new MoxfieldSyncJob({ createTransport: () => slow.transport, clientOptions: fast });
    await job2.start({ collection: false });
    expect(job2.cancel()).toBe(true);
    open();
    await job2.finished;
    expect((await getMeta<MoxSyncState>(META_SYNC))!.status).toBe('cancelled');
  });

  it('marks a job left running by a previous worker as interrupted', async () => {
    await db.meta.put({ key: META_SYNC, value: { jobId: 'old', status: 'running', phase: 'decks', withCollection: false, done: 3, total: 9, startedAt: 1, heartbeatAt: 1, requests: 4 }, updatedAt: 1 });
    await new MoxfieldSyncJob({ createTransport: () => fakeTransport({ list: [] }).transport }).markStale();
    expect((await getMeta<MoxSyncState>(META_SYNC))!.status).toBe('interrupted');
  });
});
