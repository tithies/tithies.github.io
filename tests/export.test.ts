import Papa from 'papaparse';
import { getOp, opCalls } from '@/lib/changes/log';
import type { CollectionEntry, Finish } from '@/lib/cards/types';
import { ExportJob, type StartExportRequest } from '@/lib/export/job';
import { mergeItems, planExport, type PlanContext } from '@/lib/export/plan';
import type { ExportDetails, ExportItem, ExportTarget, TargetState } from '@/lib/export/types';
import { verifyExport } from '@/lib/export/verify';
import { SiteLock } from '@/lib/sites/lock';
import { moxfieldSite } from '@/lib/sites/moxfield/provider';
import { TabTransport } from '@/lib/sites/tab-transport';
import type { SiteBinder, SiteMutation, SiteResult } from '@/lib/sites/types';
import { ALICE, BOB, FakeTabs } from './fake-tabs';
import { newAccount, resetDb } from './helpers';

const card = (name: string, set: string, cn: string) => ({
  id: `${set}-${cn}`,
  scryfallId: '',
  set,
  setName: set.toUpperCase(),
  setType: 'expansion',
  name,
  faces: [name],
  flavorName: '',
  cn,
  rarity: 'rare',
  typeLine: '',
  isToken: false,
  usd: { nonFoil: null, foil: null, etched: null },
});
let seq = 0;
const entry = (name: string, set: string, cn: string, qty: number, finish: Finish = 'nonFoil', binderId?: string): CollectionEntry => ({
  id: `e${++seq}`,
  qty,
  condition: 'nearMint',
  finish,
  lang: 'en',
  isProxy: false,
  isAlter: false,
  game: 'paper',
  ...(binderId ? { binderId } : {}),
  card: card(name, set, cn),
});
const item = (name: string, set: string, cn: string, qty: number, finish: Finish = 'nonFoil'): ExportItem => ({
  key: `${set}|${cn}|${finish}`,
  cardId: `${set}-${cn}`,
  scryfallId: '',
  name,
  set,
  setName: set.toUpperCase(),
  cn,
  finish,
  qty,
});

const A_KEY = 'moxfield:111111' as never;
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({ sourceAccountKey: null, targetName: 'alice', limits: { importRows: 2, removeEntries: 2, pageSize: 5000 }, ...over });
const BINDER: SiteBinder = { id: 'b1', publicId: 'pb1', name: 'Trade', visibility: 'private' };

describe('Export plan', () => {
  const state = (): TargetState => ({
    binders: [BINDER],
    entries: [entry('Sol Ring', 'c21', '263', 2, 'nonFoil', 'b1'), entry('Island', 'dsk', '279', 10), entry('Opt', 'xln', '65', 1, 'foil', 'b1')],
    readAt: 1,
  });
  const cart = [item('Sol Ring', 'c21', '263', 1), item('Sol Ring', 'c21', '263', 2), item('Llanowar Elves', 'dom', '168', 4, 'foil'), item('Zero', 'x', '1', 0)];

  it('merges the cart by print and drops empty items', () => {
    expect(mergeItems(cart).map((i) => [i.key, i.qty])).toEqual([
      ['dom|168|foil', 4],
      ['c21|263|nonFoil', 3],
    ]);
  });

  it('a new binder: created, then filled', () => {
    const p = planExport({ accountKey: A_KEY, kind: 'newBinder', name: ' To buy ', visibility: 'private' }, cart, state(), ctx());
    expect(p).toMatchObject({ targetLabel: 'the new binder “To buy”', add: { prints: 2, copies: 7 }, before: 0, after: 7, writes: 2, remove: { entries: [] } });
    expect(p.blocked).toBeUndefined();
    expect(p.steps[0]).toMatch(/Create the private binder “To buy”/);
    const dup = planExport({ accountKey: A_KEY, kind: 'newBinder', name: 'trade', visibility: 'private' }, cart, state(), ctx());
    expect(dup.warnings.map((w) => w.text).join()).toMatch(/already has a binder named/);
  });

  it('replacing a binder deletes its entries (collection cards) first', () => {
    const p = planExport({ accountKey: A_KEY, kind: 'binder', binderId: 'b1', mode: 'replace' }, cart, state(), ctx());
    expect(p.remove.entries.map((e) => [e.name, e.qty, e.binderId])).toEqual([
      ['Sol Ring', 2, 'b1'],
      ['Opt', 1, 'b1'],
    ]);
    expect(p).toMatchObject({ before: 3, after: 7, writes: 2, remove: { copies: 3, wholeCollection: false } });
    expect(p.warnings[0]).toMatchObject({ level: 'danger' });
    const add = planExport({ accountKey: A_KEY, kind: 'binder', binderId: 'b1', mode: 'add' }, cart, state(), ctx());
    expect(add).toMatchObject({ before: 3, after: 10, writes: 1, remove: { entries: [] } });
    expect(planExport({ accountKey: A_KEY, kind: 'binder', binderId: 'gone', mode: 'add' }, cart, state(), ctx()).blocked).toMatch(/isn't on alice/);
  });

  it('replacing the collection deletes all of it, binders included', () => {
    const p = planExport({ accountKey: A_KEY, kind: 'collection', mode: 'replace' }, cart, state(), ctx());
    expect(p).toMatchObject({ before: 13, after: 7, writes: 2, remove: { copies: 13, wholeCollection: true } });
    expect(p.remove.entries).toHaveLength(3);
    expect(planExport({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, cart, state(), ctx())).toMatchObject({ before: 13, after: 20, writes: 1 });
    expect(planExport({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, [], state(), ctx()).blocked).toMatch(/empty/);
  });

  it('warns when the target is the compared account', () => {
    const p = planExport({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, cart, state(), ctx({ sourceAccountKey: A_KEY }));
    expect(p.warnings.map((w) => w.text).join()).toMatch(/account you're comparing/);
    expect(planExport({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, cart, state(), ctx({ sourceAccountKey: 'moxfield:9' as never })).warnings).toEqual([]);
  });

  it("the digest changes when what the export depends on changes, not otherwise", () => {
    const t: ExportTarget = { accountKey: A_KEY, kind: 'binder', binderId: 'b1', mode: 'replace' };
    const s = state();
    const d = planExport(t, cart, s, ctx()).digest;
    expect(planExport(t, cart, { ...s, readAt: 99 }, ctx()).digest).toBe(d);
    // An unrelated entry outside the binder doesn't matter for a binder replace.
    expect(planExport(t, cart, { ...s, entries: [...s.entries, entry('Forest', 'dsk', '286', 1)] }, ctx()).digest).toBe(d);
    expect(planExport(t, cart, { ...s, entries: [...s.entries, entry('Bolt', 'lea', '161', 1, 'nonFoil', 'b1')] }, ctx()).digest).not.toBe(d);
    expect(planExport(t, cart.slice(1), s, ctx()).digest).not.toBe(d);
  });
});

describe('Export verification', () => {
  const plan = (target: ExportTarget, items: ExportItem[], before: CollectionEntry[]) => planExport(target, items, { binders: [BINDER], entries: before, readAt: 0 }, ctx());

  it('all added, nothing else changed', () => {
    const before = [entry('Island', 'dsk', '279', 10)];
    const p = plan({ accountKey: A_KEY, kind: 'binder', binderId: 'b1', mode: 'add' }, [item('Sol Ring', 'c21', '263', 2)], before);
    const after = [...before, entry('Sol Ring', 'c21', '263', 1, 'nonFoil', 'b1'), entry('Sol Ring', 'c21', '263', 1, 'nonFoil', 'b1')];
    expect(verifyExport(p, before, after, 'b1')).toMatchObject({ ok: true, expectedCopies: 2, foundCopies: 2, short: [], extra: [], otherChanged: [] });
  });

  it('a card imported as another print is one short and one extra', () => {
    const p = plan({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, [item('Sol Ring', 'c21', '263', 1)], []);
    const v = verifyExport(p, [], [entry('Sol Ring', 'cmr', '472', 1)], null);
    expect(v.ok).toBe(false);
    expect(v.short).toMatchObject([{ key: 'c21|263|nonFoil', expected: 1, found: 0 }]);
    expect(v.extra).toMatchObject([{ key: 'cmr|472|nonFoil', expected: 0, found: 1 }]);
  });

  it('notices other prints that changed, and what a replace failed to delete', () => {
    const island = entry('Island', 'dsk', '279', 10);
    const sol = entry('Sol Ring', 'c21', '263', 2, 'nonFoil', 'b1');
    const p = plan({ accountKey: A_KEY, kind: 'binder', binderId: 'b1', mode: 'replace' }, [item('Opt', 'xln', '65', 1)], [island, sol]);
    const v = verifyExport(p, [island, sol], [{ ...island, qty: 9 }, sol, entry('Opt', 'xln', '65', 1, 'nonFoil', 'b1')], 'b1');
    expect(v.short).toEqual([]);
    expect(v.otherChanged.map((d) => [d.name, d.expected, d.found, d.outside ?? false])).toEqual([
      ['Island', 10, 9, true],
      ['Sol Ring', 0, 2, false],
    ]);
  });

  it('a collection replace expects only the cart', () => {
    const before = [entry('Island', 'dsk', '279', 10), entry('Opt', 'xln', '65', 1, 'nonFoil', 'b1')];
    const p = plan({ accountKey: A_KEY, kind: 'collection', mode: 'replace' }, [item('Opt', 'xln', '65', 2)], before);
    expect(verifyExport(p, before, [entry('Opt', 'xln', '65', 2)], null).ok).toBe(true);
    expect(verifyExport(p, before, [entry('Opt', 'xln', '65', 2), entry('Island', 'dsk', '279', 10)], null).otherChanged).toHaveLength(1);
  });
});

/** A fake Moxfield account: binders and a collection, changed by the writes like the real site would. */
class FakeMox {
  binders: SiteBinder[] = [];
  entries: CollectionEntry[] = [];
  writes: SiteMutation[] = [];
  /** Imports this card as another print (a mismatch the check must catch). */
  misprint?: { from: string; to: { set: string; cn: string } };
  failOn?: (op: SiteMutation) => SiteResult | null;
  private n = 0;

  answer = (_as: unknown, { req }: { req: { kind: string; op?: SiteMutation; pageNumber?: number; pageSize?: number } }): SiteResult => {
    if (req.kind === 'binders') return { ok: true, kind: 'binders', binders: [...this.binders] };
    if (req.kind === 'collection') return { ok: true, kind: 'collection', entries: req.pageNumber === 1 ? this.entries.map((e) => ({ ...e })) : [], totalResults: this.entries.length, totalPages: 1, pageSize: 5000 };
    if (req.kind !== 'mutate' || !req.op) throw new Error(`unexpected ${req.kind}`);
    const op = req.op;
    this.writes.push(op);
    const fail = this.failOn?.(op);
    if (fail) return fail;
    switch (op.op) {
      case 'createBinder': {
        const b = { id: `nb${++this.n}`, publicId: `pnb${this.n}`, name: op.name, visibility: op.visibility };
        this.binders.push(b);
        return { ok: true, kind: 'mutate', status: 200, response: JSON.stringify(b), binder: b };
      }
      case 'bulkRemove':
        this.entries = this.entries.filter((e) => !op.entryIds.includes(e.id));
        return { ok: true, kind: 'mutate', status: 200, response: '' };
      case 'deleteCollection':
        this.entries = [];
        return { ok: true, kind: 'mutate', status: 200, response: '' };
      case 'importCsv': {
        const rows = Papa.parse<Record<string, string>>(op.csv, { header: true, skipEmptyLines: true }).data;
        for (const r of rows) {
          let { Edition: set, 'Collector Number': cn } = r;
          if (this.misprint && r.Name === this.misprint.from) ({ set, cn } = this.misprint.to);
          const finish = (r.Foil || 'nonFoil') as Finish;
          this.entries.push(entry(r.Name, set, cn, Number(r.Count), finish, op.binderId));
        }
        return { ok: true, kind: 'mutate', status: 200, response: `{"imported":${rows.length}}` };
      }
    }
  };
}

describe('Export job', () => {
  beforeEach(resetDb);

  async function setup(account = ALICE, loggedIn = ALICE) {
    const acc = await newAccount(account.userId, account.userName);
    const mox = new FakeMox();
    const port = new FakeTabs();
    port.tabs = [{ id: 1, active: true, account: loggedIn }];
    port.answer = mox.answer as never;
    const lock = new SiteLock();
    const job = new ExportJob(moxfieldSite, {
      createTransport: ({ expect, ...ctl }) => new TabTransport(moxfieldSite, { ...ctl, expect, authWaitMs: 30, pollMs: 5, reloadSettleMs: 0 }, port),
      clientOptions: async () => ({ intervalMs: 0, jitterMs: 0, maxIntervalMs: 0, rateLimitWaitsMs: [], errorWaitsMs: [], sleep: async () => {} }),
      lock,
    });
    return { acc, mox, port, job, lock };
  }

  /** Preview then export, like the dialog. */
  async function exportWith(job: ExportJob, accountKey: never, target: ExportTarget, items: ExportItem[], change?: () => void) {
    const read = await job.readTarget(accountKey);
    if (!read.ok) throw new Error(read.error);
    const plan = planExport(target, items, read.state, { sourceAccountKey: null, targetName: 'alice', limits: { importRows: 500, removeEntries: 1000, pageSize: 5000 } });
    change?.();
    const req: StartExportRequest = { target, items, digest: plan.digest, sourceAccountKey: null, source: 'test' };
    const res = await job.start(req);
    if (!res.ok) throw new Error(res.error);
    await job.finished;
    const op = (await getOp(res.opId))!;
    return { op, details: op.details as ExportDetails, calls: await opCalls(res.opId) };
  }

  const CART = [item('Sol Ring', 'c21', '263', 2), item('Llanowar Elves', 'dom', '168', 1, 'foil')];

  it('creates a new binder, imports the cart into it, and checks every copy', async () => {
    const { acc, mox, job } = await setup();
    mox.entries = [entry('Island', 'dsk', '279', 10)];
    const { op, details, calls } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'newBinder', name: 'To buy', visibility: 'private' }, CART);
    expect(op).toMatchObject({ status: 'done', calls: 2, unknownCalls: 0 });
    expect(op.title).toBe('Export 3 copies (2 prints) to the new binder “To buy”');
    expect(mox.writes.map((w) => w.op)).toEqual(['createBinder', 'importCsv']);
    expect(mox.writes[1]).toMatchObject({ binderId: 'nb1' });
    expect(calls.map((c) => [c.method, c.outcome])).toEqual([
      ['POST', 'ok'],
      ['POST', 'ok'],
    ]);
    expect(calls[1].body).toContain('"2","2","Sol Ring","c21","Near Mint","English","","","","263","False","False",""');
    expect(details.verify).toMatchObject({ ok: true, expectedCopies: 3, foundCopies: 3 });
    expect(details.binder).toMatchObject({ id: 'nb1', name: 'To buy' });
  });

  it('replaces a binder: its entries are removed, the cart imported into it', async () => {
    const { acc, mox, job } = await setup();
    mox.binders = [BINDER];
    const old = entry('Opt', 'xln', '65', 4, 'nonFoil', 'b1');
    mox.entries = [old, entry('Island', 'dsk', '279', 10)];
    const { op, details } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'binder', binderId: 'b1', mode: 'replace' }, CART);
    expect(op.status).toBe('done');
    expect(mox.writes).toMatchObject([{ op: 'bulkRemove', entryIds: [old.id] }, { op: 'importCsv', binderId: 'b1' }]);
    expect(details.removed).toMatchObject([{ entryId: old.id, name: 'Opt', qty: 4 }]);
    expect(details.verify!.ok).toBe(true);
  });

  it('replaces the whole collection', async () => {
    const { acc, mox, job } = await setup();
    mox.entries = [entry('Island', 'dsk', '279', 10)];
    const { op, details } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'collection', mode: 'replace' }, CART);
    expect(mox.writes.map((w) => w.op)).toEqual(['deleteCollection', 'importCsv']);
    expect(mox.writes[1]).not.toHaveProperty('binderId');
    expect(op.status).toBe('done');
    expect(details).toMatchObject({ wholeCollection: true, before: 10, after: 3, verify: { ok: true } });
  });

  it('reports a card Moxfield imported as another print', async () => {
    const { acc, mox, job } = await setup();
    mox.misprint = { from: 'Sol Ring', to: { set: 'cmr', cn: '472' } };
    const { op, details } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'collection', mode: 'add' }, CART);
    expect(op).toMatchObject({ status: 'done', phase: 'Done, with differences (see below)' });
    expect(details.verify).toMatchObject({ ok: false, short: [{ key: 'c21|263|nonFoil' }], extra: [{ key: 'cmr|472|nonFoil' }] });
  });

  it('changes nothing when the target changed since the preview', async () => {
    const { acc, mox, job } = await setup();
    mox.binders = [BINDER];
    mox.entries = [entry('Opt', 'xln', '65', 4, 'nonFoil', 'b1')];
    const { op, calls } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'binder', binderId: 'b1', mode: 'replace' }, CART, () =>
      mox.entries.push(entry('Bolt', 'lea', '161', 1, 'nonFoil', 'b1')),
    );
    expect(op).toMatchObject({ status: 'failed', calls: 0 });
    expect(op.error).toMatch(/changed since the preview/);
    expect(mox.writes).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('never makes a change as another account', async () => {
    const { acc, mox, job } = await setup(ALICE, BOB);
    expect(await job.readTarget(acc.key as never)).toMatchObject({ ok: false, code: 'wrong_account' });
    const res = await job.start({ target: { accountKey: acc.key, kind: 'collection', mode: 'add' }, items: CART, digest: 'x', sourceAccountKey: null, source: 't' });
    expect(res.ok).toBe(true);
    await job.finished;
    const op = (await getOp((res as { opId: number }).opId))!;
    expect(op.status).toBe('failed');
    expect(op.error).toMatch(/logged in as bob.*before changing anything/);
    expect(mox.writes).toEqual([]);
  });

  it('stops at a write with an unknown outcome, never sends it again, and checks what was made', async () => {
    const { acc, mox, job } = await setup();
    mox.failOn = (op) => (op.op === 'importCsv' ? { ok: false, status: 502, code: 'http', message: 'Moxfield answered HTTP 502' } : null);
    const { op, details, calls } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'newBinder', name: 'X', visibility: 'private' }, CART);
    expect(op).toMatchObject({ status: 'failed', unknownCalls: 1 });
    expect(op.error).toMatch(/doesn't know whether Moxfield made the change/);
    expect(calls.map((c) => c.outcome)).toEqual(['ok', 'unknown']);
    expect(mox.writes.map((w) => w.op)).toEqual(['createBinder', 'importCsv']);
    // The collection was read again afterwards: nothing of the cart is there.
    expect(details.verify).toMatchObject({ ok: false, foundCopies: 0 });
  });

  it('shares the site with the sync: one job at a time', async () => {
    const { acc, job, lock } = await setup();
    lock.tryAcquire('sync');
    expect(await job.readTarget(acc.key as never)).toMatchObject({ ok: false, code: 'busy', error: expect.stringMatching(/syncing/) });
    expect(await job.start({ target: { accountKey: acc.key, kind: 'collection', mode: 'add' }, items: CART, digest: 'x', sourceAccountKey: null, source: 't' })).toMatchObject({
      ok: false,
      code: 'busy',
    });
    lock.release('sync');
    expect((await job.readTarget(acc.key as never)).ok).toBe(true);
    expect(lock.heldBy).toBeNull();
  });

  it('refuses malformed items', async () => {
    const { acc, job } = await setup();
    const bad = [[], [{ ...CART[0], qty: 0 }], [{ ...CART[0], finish: 'gold' }], [{ ...CART[0], set: '' }], 'x'];
    for (const items of bad) {
      expect(await job.start({ target: { accountKey: acc.key, kind: 'collection', mode: 'add' }, items: items as never, digest: 'x', sourceAccountKey: null, source: 't' })).toMatchObject({
        ok: false,
        code: 'bad_request',
      });
    }
  });
});

describe('Export cart', () => {
  it('adds new prints only, sets quantities, removes and clears', async () => {
    const { cartReducer, cartTotals, MAX_CART_QTY } = await import('@/lib/export/cart');
    let s = cartReducer(new Map(), { type: 'add', items: [item('Sol Ring', 'c21', '263', 2), item('Opt', 'xln', '65', 0)] });
    expect([...s.keys()]).toEqual(['c21|263|nonFoil']);
    s = cartReducer(s, { type: 'setQty', key: 'c21|263|nonFoil', qty: 5 });
    // Already in the cart: adding again keeps the quantity chosen.
    s = cartReducer(s, { type: 'add', items: [item('Sol Ring', 'c21', '263', 2), item('Island', 'dsk', '279', 3)] });
    expect(cartTotals(s)).toEqual({ prints: 2, copies: 8 });
    expect(cartReducer(s, { type: 'setQty', key: 'dsk|279|nonFoil', qty: 99999 }).get('dsk|279|nonFoil')!.qty).toBe(MAX_CART_QTY);
    expect(cartReducer(s, { type: 'setQty', key: 'dsk|279|nonFoil', qty: 0 }).has('dsk|279|nonFoil')).toBe(false);
    expect(cartReducer(s, { type: 'remove', keys: ['nope'] })).toBe(s);
    expect(cartReducer(s, { type: 'remove', keys: ['c21|263|nonFoil'] }).size).toBe(1);
    expect(cartReducer(s, { type: 'clear' }).size).toBe(0);
  });
});
