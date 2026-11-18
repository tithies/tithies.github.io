/**
 * Selling checks of the whole collection, started from the dashboard: the collection is read in
 * the background by the account's sync job (alone, no decks), and the run waits for it, then gets
 * its paper, non-proxy cards.
 */
import { findRun, itemsOfRun } from '@/lib/accounts/data';
import type { AccountKey } from '@/lib/accounts/types';
import type { CollectionEntry } from '@/lib/cards/types';
import { db } from '@/lib/db';
import { AccountSyncJob } from '@/lib/decks/job';
import { moxfieldSite } from '@/lib/sites/moxfield/provider';
import { TabTransport } from '@/lib/sites/tab-transport';
import type { SiteResult } from '@/lib/sites/types';
import { controlRun, endInterruptedCollectionRuns } from '@/features/f2f-buylist/runner';
import { startCollectionRun } from '@/features/f2f-buylist/start';
import { isSellable } from '@/lib/cards/prints';
import { ALICE, BOB, FakeTabs } from './fake-tabs';
import { newAccount, resetDb } from './helpers';

const entry = (id: string, extra: Partial<CollectionEntry> = {}): CollectionEntry => ({
  id,
  qty: 2,
  condition: 'nearMint',
  finish: 'nonFoil',
  lang: 'en',
  isProxy: false,
  isAlter: false,
  game: 'paper',
  updatedAt: '2026-11-18T12:00:00Z',
  card: { id, scryfallId: '', set: 'dmu', setName: 'Dominaria United', setType: 'expansion', name: `Card ${id}`, faces: [`Card ${id}`], flavorName: '', cn: id, lang: 'en', rarity: 'rare', typeLine: 'Creature', isToken: false, usd: { nonFoil: 1, foil: null, etched: null } },
  ...extra,
});

const ENTRIES: CollectionEntry[] = [
  entry('1'),
  entry('2', { finish: 'foil', qty: 1 }),
  entry('3', { isProxy: true }),
  entry('4', { game: 'mtgo' }),
  entry('5', { game: undefined }),
];

const fast = { intervalMs: 0, jitterMs: 0, maxIntervalMs: 0, rateLimitWaitsMs: [], errorWaitsMs: [], sleep: async () => {} };

/** A Moxfield tab answering the collection in one page; `gate` holds the answer back. */
function moxTabs(gate?: Promise<void>) {
  const port = new FakeTabs();
  port.tabs = [{ id: 1, active: true, account: ALICE }];
  port.answer = async (_as, { req }): Promise<SiteResult> => {
    if (req.kind !== 'collection') throw new Error(`unexpected ${req.kind}`);
    await gate;
    return { ok: true, kind: 'collection', entries: ENTRIES, totalResults: ENTRIES.length, totalPages: 1, pageSize: req.pageSize, totalCopies: 9 };
  };
  return port;
}

const newJob = (port: FakeTabs) =>
  new AccountSyncJob(moxfieldSite, {
    createTransport: ({ expect, ...ctl }) => new TabTransport(moxfieldSite, { ...ctl, expect, authWaitMs: 30, pollMs: 5, reloadSettleMs: 0 }, port),
    clientOptions: fast,
  });

let key: AccountKey;
beforeEach(async () => {
  await resetDb();
  key = (await newAccount(ALICE.userId, ALICE.userName)).key;
});

describe('Selling check of the whole collection', () => {
  it('keeps paper, non-proxy copies', () => {
    expect(ENTRIES.filter(isSellable).map((e) => e.id)).toEqual(['1', '2', '5']);
  });

  it('reads the collection alone, then the run gets its paper, non-proxy cards and waits for its turn', async () => {
    const port = moxTabs();
    let queued = 0;
    const { result, done } = await startCollectionRun('moxfield', key, { sync: newJob(port), creditBonus: 0.3, onQueued: () => queued++ });
    if (!result.ok) throw new Error(result.error);
    expect(result.accountKey).toBe(key);
    await done;

    const run = (await findRun(result.runId))!;
    expect(run).toMatchObject({ accountKey: key, status: 'queued', creditBonus: 0.3, source: { wholeCollection: true, summary: 'Whole collection', url: '' } });
    expect(run.totals).toMatchObject({ entries: 3, prints: 3, copies: 5 });
    expect((await itemsOfRun(result.runId)).map((i) => i.cn).sort()).toEqual(['1', '2', '5']);
    expect(queued).toBe(1);
    // No deck was read: only the collection.
    expect(port.calls.map((c) => c.call.req.kind)).toEqual(['collection']);
    expect(await db.collectionEntries.count()).toBe(ENTRIES.length);
  });

  it('waits for the read: the run says so meanwhile, and a cancel stops the read and the run', async () => {
    let open!: () => void;
    const port = moxTabs(new Promise<void>((r) => (open = r)));
    const job = newJob(port);
    let queued = 0;
    const { result, done } = await startCollectionRun('moxfield', key, { sync: job, creditBonus: 0.3, onQueued: () => queued++ });
    if (!result.ok) throw new Error(result.error);
    const waiting = (await findRun(result.runId))!;
    expect(waiting).toMatchObject({ status: 'fetching_collection', collectionJobId: job.activeState?.jobId });
    expect(job.activeState).toMatchObject({ withDecks: false, withCollection: true });

    // A whole-collection run has nothing to pause; it can be cancelled.
    expect(await controlRun(result.runId, 'pause')).toBe(false);
    expect(await controlRun(result.runId, 'cancel')).toBe(true);
    job.cancel();
    open();
    await done;
    const run = (await findRun(result.runId))!;
    expect(run.status).toBe('cancelled');
    expect(await itemsOfRun(result.runId)).toEqual([]);
    expect(queued).toBe(0);
    // Without cards, there is nothing to resume.
    expect(await controlRun(result.runId, 'resume')).toBe(false);
  });

  it('a read that fails ends the run, saying why', async () => {
    const port = moxTabs();
    port.answer = () => ({ ok: false, status: 500, code: 'http', message: 'Moxfield answered HTTP 500' });
    const { result, done } = await startCollectionRun('moxfield', key, { sync: newJob(port), creditBonus: 0.3, onQueued: () => {} });
    if (!result.ok) throw new Error(result.error);
    await done;
    const run = (await findRun(result.runId))!;
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/^Couldn't read the Moxfield collection: Moxfield answered HTTP 500/);
  });

  it('with Moxfield logged in as someone else: no run, and the answer says who', async () => {
    const port = moxTabs();
    port.tabs = [{ id: 1, active: true, account: BOB }];
    port.newTabAccount = BOB;
    const { result } = await startCollectionRun('moxfield', key, { sync: newJob(port), creditBonus: 0.3, onQueued: () => {} });
    expect(result).toMatchObject({ ok: false, code: 'wrong_account', actual: BOB });
    expect(await db.runs.count()).toBe(0);
    expect(port.calls.filter((c) => c.call.req.kind === 'collection' && c.call.expect === undefined)).toEqual([]);
  });

  it('a run still waiting when the worker restarts has lost its read: it ends', async () => {
    let open!: () => void;
    const port = moxTabs(new Promise<void>((r) => (open = r)));
    const { result } = await startCollectionRun('moxfield', key, { sync: newJob(port), creditBonus: 0.3, onQueued: () => {} });
    if (!result.ok) throw new Error(result.error);
    await endInterruptedCollectionRuns();
    expect(await findRun(result.runId)).toMatchObject({ status: 'failed', error: expect.stringMatching(/interrupted/) });
    open();
  });
});
