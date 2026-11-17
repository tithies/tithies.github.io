import Papa from 'papaparse';
import { getOp, opCalls } from '@/lib/changes/log';
import type { ChangeOp, OverallProgress } from '@/lib/changes/types';
import { db } from '@/lib/db';
import type { CollectionEntry, Finish } from '@/lib/cards/types';
import { ExportJob, type StartExportRequest } from '@/lib/export/job';
import { afterRead, beforeRead, mergeItems, planExport, previewRead, stateCovers, type PlanContext } from '@/lib/export/plan';
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
  updatedAt: '2026-01-01T00:00:00.000Z',
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
    read: { kind: 'collection' },
    entries: [entry('Sol Ring', 'c21', '263', 2, 'nonFoil', 'b1'), entry('Island', 'dsk', '279', 10), entry('Opt', 'xln', '65', 1, 'foil', 'b1')],
    totals: { entries: 3, copies: 13 },
    readAt: 1,
  });
  const exportList = [item('Sol Ring', 'c21', '263', 1), item('Sol Ring', 'c21', '263', 2), item('Llanowar Elves', 'dom', '168', 4, 'foil'), item('Zero', 'x', '1', 0)];

  it('merges the export by print and drops empty items', () => {
    expect(mergeItems(exportList).map((i) => [i.key, i.qty])).toEqual([
      ['dom|168|foil', 4],
      ['c21|263|nonFoil', 3],
    ]);
  });

  it('a new binder: created, then filled', () => {
    const p = planExport({ accountKey: A_KEY, kind: 'newBinder', name: ' To buy ', visibility: 'private' }, exportList, state(), ctx());
    expect(p).toMatchObject({ targetLabel: 'the new binder “To buy”', add: { prints: 2, copies: 7 }, before: 0, after: 7, writes: 2, remove: { entries: [] } });
    expect(p.blocked).toBeUndefined();
    expect(p.steps[0]).toMatch(/Create the private binder “To buy”/);
    const dup = planExport({ accountKey: A_KEY, kind: 'newBinder', name: 'trade', visibility: 'private' }, exportList, state(), ctx());
    expect(dup.warnings.map((w) => w.text).join()).toMatch(/already has a binder named/);
  });

  it('replacing a binder deletes its entries (collection cards) first', () => {
    const p = planExport({ accountKey: A_KEY, kind: 'binder', binderId: 'b1', mode: 'replace' }, exportList, state(), ctx());
    expect(p.remove.entries.map((e) => [e.name, e.qty, e.binderId])).toEqual([
      ['Sol Ring', 2, 'b1'],
      ['Opt', 1, 'b1'],
    ]);
    expect(p).toMatchObject({ before: 3, after: 7, writes: 2, remove: { copies: 3, wholeCollection: false } });
    expect(p.warnings[0]).toMatchObject({ level: 'danger' });
    const add = planExport({ accountKey: A_KEY, kind: 'binder', binderId: 'b1', mode: 'add' }, exportList, state(), ctx());
    expect(add).toMatchObject({ before: 3, after: 10, writes: 1, remove: { entries: [] } });
    expect(planExport({ accountKey: A_KEY, kind: 'binder', binderId: 'gone', mode: 'add' }, exportList, state(), ctx()).blocked).toMatch(/isn't on alice/);
  });

  it('replacing the collection deletes all of it, binders included', () => {
    const p = planExport({ accountKey: A_KEY, kind: 'collection', mode: 'replace' }, exportList, state(), ctx());
    expect(p).toMatchObject({ before: 13, after: 7, writes: 2, remove: { copies: 13, wholeCollection: true } });
    expect(p.remove.entries).toHaveLength(3);
    expect(planExport({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, exportList, state(), ctx())).toMatchObject({ before: 13, after: 20, writes: 1 });
    expect(planExport({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, [], state(), ctx()).blocked).toMatch(/Nothing to export/);
  });

  it('reads only what each target needs, at each step', () => {
    const nb: ExportTarget = { accountKey: A_KEY, kind: 'newBinder', name: 'X', visibility: 'private' };
    const b: ExportTarget = { accountKey: A_KEY, kind: 'binder', binderId: 'b1', mode: 'replace' };
    const add: ExportTarget = { accountKey: A_KEY, kind: 'collection', mode: 'add' };
    const rep: ExportTarget = { accountKey: A_KEY, kind: 'collection', mode: 'replace' };
    expect([nb, b, add, rep].map(previewRead)).toEqual([{ kind: 'binders' }, { kind: 'binder', binderId: 'b1' }, { kind: 'totals' }, { kind: 'collection' }]);
    expect([nb, b, add, rep].map(beforeRead)).toEqual([{ kind: 'binders' }, { kind: 'binder', binderId: 'b1' }, { kind: 'collection' }, { kind: 'collection' }]);
    expect(afterRead(nb, 'new1')).toEqual({ kind: 'binder', binderId: 'new1' });
    expect(afterRead(add, null)).toEqual({ kind: 'collection' });
    const binderOnly: TargetState = { binders: [BINDER], read: { kind: 'binders' }, entries: [], totals: null, readAt: 0 };
    expect(stateCovers(binderOnly, previewRead(nb))).toBe(true);
    expect(stateCovers(binderOnly, previewRead(b))).toBe(false);
    expect(planExport(b, exportList, binderOnly, ctx()).blocked).toMatch(/Read alice's binder first/);
    // The collection's totals are enough to preview an add; its copies come from them.
    const totals: TargetState = { ...binderOnly, read: { kind: 'totals' }, totals: { entries: 4010, copies: 5431 } };
    const p = planExport(add, exportList, totals, ctx({ limits: { importRows: 500, removeEntries: 1000, pageSize: 100 } }));
    expect(p).toMatchObject({ before: 5431, after: 5438 });
    // 1 binder list + every page before (no saved snapshot) + the check reads only the new entries.
    expect(p.reads).toBe(1 + 41 + 1);
    // With a recent snapshot, before is only its changes too.
    expect(planExport(add, exportList, totals, ctx({ savedCollection: true, limits: { importRows: 500, removeEntries: 1000, pageSize: 100 } })).reads).toBe(3);
    const nbPlan = planExport(nb, exportList, binderOnly, ctx({ limits: { importRows: 500, removeEntries: 1000, pageSize: 100 } }));
    expect(nbPlan.reads).toBe(2);
  });

  it('warns when the target is the compared account', () => {
    const p = planExport({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, exportList, state(), ctx({ sourceAccountKey: A_KEY }));
    expect(p.warnings.map((w) => w.text).join()).toMatch(/account you're comparing/);
    expect(planExport({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, exportList, state(), ctx({ sourceAccountKey: 'moxfield:9' as never })).warnings).toEqual([]);
  });

  it("the digest changes when what the export depends on changes, not otherwise", () => {
    const t: ExportTarget = { accountKey: A_KEY, kind: 'binder', binderId: 'b1', mode: 'replace' };
    const s = state();
    const d = planExport(t, exportList, s, ctx()).digest;
    expect(planExport(t, exportList, { ...s, readAt: 99 }, ctx()).digest).toBe(d);
    // An unrelated entry outside the binder doesn't matter for a binder replace.
    expect(planExport(t, exportList, { ...s, entries: [...s.entries, entry('Forest', 'dsk', '286', 1)] }, ctx()).digest).toBe(d);
    expect(planExport(t, exportList, { ...s, entries: [...s.entries, entry('Bolt', 'lea', '161', 1, 'nonFoil', 'b1')] }, ctx()).digest).not.toBe(d);
    expect(planExport(t, exportList.slice(1), s, ctx()).digest).not.toBe(d);
  });
});

describe('Export verification', () => {
  const plan = (target: ExportTarget, items: ExportItem[], before: CollectionEntry[]) =>
    planExport(target, items, { binders: [BINDER], read: { kind: 'collection' }, entries: before, totals: null, readAt: 0 }, ctx());

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

  it('a collection replace expects only the exported cards', () => {
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
  /** Collection pages read: 'collection', or 'binder:<id>'. */
  reads: string[] = [];
  /** The binder search answers 404 (the job then reads the whole collection). */
  binderSearchFails = false;
  /** Imports this card as another print (a mismatch the check must catch). */
  misprint?: { from: string; to: { set: string; cn: string } };
  failOn?: (op: SiteMutation) => SiteResult | null;
  private n = 0;

  answer = (_as: unknown, { req }: { req: { kind: string; op?: SiteMutation; pageNumber?: number; pageSize?: number; publicId?: string } }): SiteResult => {
    if (req.kind === 'binders') return { ok: true, kind: 'binders', binders: [...this.binders] };
    if (req.kind === 'collection' || req.kind === 'binderPage') {
      const binder = req.kind === 'binderPage' ? this.binders.find((b) => b.publicId === req.publicId) : null;
      if (req.kind === 'binderPage' && (!binder || this.binderSearchFails)) return { ok: false, status: 404, code: 'http', message: 'Moxfield answered HTTP 404' };
      const newestFirst = (req as { newestFirst?: boolean }).newestFirst === true;
      this.reads.push(binder ? `binder:${binder.id}` : newestFirst ? 'collection:changes' : 'collection');
      // Like Moxfield: a binder search lists entries without their binder; the answer names it once.
      const rows = binder
        ? this.entries.filter((e) => e.binderId === binder.id).map(({ binderId: _b, ...e }) => ({ ...e, binderId: binder.id }))
        : newestFirst
          ? [...this.entries].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
          : this.entries;
      return {
        ok: true,
        kind: req.kind,
        entries: req.pageNumber === 1 ? rows.map((e) => ({ ...e })) : [],
        totalResults: rows.length,
        totalPages: 1,
        pageSize: 5000,
        totalCopies: rows.reduce((s, e) => s + e.qty, 0),
      };
    }
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
          this.entries.push({ ...entry(r.Name, set, cn, Number(r.Count), finish, op.binderId), updatedAt: new Date(Date.UTC(2026, 10, 16) + ++this.n * 1000).toISOString() });
        }
        const count = rows.reduce((s, r) => s + Number(r.Count), 0);
        return { ok: true, kind: 'mutate', status: 200, response: `{"isSuccessful":true,"totalImportedCount":${count},"errors":[]}`, imported: { ok: true, count, errors: [] } };
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
    const read = await job.readTarget(accountKey, previewRead(target));
    if (!read.ok) throw new Error(read.error);
    const plan = planExport(target, items, read.state, { sourceAccountKey: null, targetName: 'alice', limits: { importRows: 500, removeEntries: 1000, pageSize: 5000 } });
    change?.();
    const req: StartExportRequest = { target, items, digest: plan.digest, sourceAccountKey: null, source: 'test', estimate: plan.requests };
    const res = await job.start(req);
    if (!res.ok) throw new Error(res.error);
    await job.finished;
    const op = (await getOp(res.opId))!;
    return { op, details: op.details as ExportDetails, calls: await opCalls(res.opId) };
  }

  const TO_EXPORT = [item('Sol Ring', 'c21', '263', 2), item('Llanowar Elves', 'dom', '168', 1, 'foil')];

  it('creates a new binder, imports the export into it, and checks every copy', async () => {
    const { acc, mox, job } = await setup();
    mox.entries = [entry('Island', 'dsk', '279', 10)];
    const { op, details, calls } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'newBinder', name: 'To buy', visibility: 'private' }, TO_EXPORT);
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
    expect(details.imported).toEqual({ count: 3, errors: [], failed: 0 });
    expect(details.binder).toMatchObject({ id: 'nb1', name: 'To buy' });
    // Never the whole collection: the binder list, then only the new binder's cards.
    expect(mox.reads).toEqual(['binder:nb1']);
    expect(details.verify!.scope).toBe('binder');
  });

  it('replaces a binder: its entries are removed, the export imported into it', async () => {
    const { acc, mox, job } = await setup();
    mox.binders = [BINDER];
    const old = entry('Opt', 'xln', '65', 4, 'nonFoil', 'b1');
    mox.entries = [old, entry('Island', 'dsk', '279', 10)];
    const { op, details } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'binder', binderId: 'b1', mode: 'replace' }, TO_EXPORT);
    expect(op.status).toBe('done');
    expect(mox.writes).toMatchObject([{ op: 'bulkRemove', entryIds: [old.id] }, { op: 'importCsv', binderId: 'b1' }]);
    expect(details.removed).toMatchObject([{ entryId: old.id, name: 'Opt', qty: 4 }]);
    expect(details.verify!.ok).toBe(true);
    // Preview, before and after: only the binder's cards.
    expect(mox.reads).toEqual(['binder:b1', 'binder:b1', 'binder:b1']);
  });

  it("falls back to the whole collection when the binder search fails, and still checks only the binder", async () => {
    const { acc, mox, job } = await setup();
    mox.binders = [BINDER];
    mox.binderSearchFails = true;
    mox.entries = [entry('Opt', 'xln', '65', 4, 'nonFoil', 'b1'), entry('Island', 'dsk', '279', 10)];
    const { op, details } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'binder', binderId: 'b1', mode: 'add' }, TO_EXPORT);
    expect(op.status).toBe('done');
    expect(mox.reads).toEqual(['collection', 'collection', 'collection']);
    expect(details).toMatchObject({ before: 4, after: 7, verify: { ok: true, scope: 'binder' } });
  });

  it('replaces the whole collection', async () => {
    const { acc, mox, job } = await setup();
    mox.entries = [entry('Island', 'dsk', '279', 10)];
    const { op, details } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'collection', mode: 'replace' }, TO_EXPORT);
    expect(mox.writes.map((w) => w.op)).toEqual(['deleteCollection', 'importCsv']);
    expect(mox.writes[1]).not.toHaveProperty('binderId');
    expect(op.status).toBe('done');
    expect(details).toMatchObject({ wholeCollection: true, before: 10, after: 3, verify: { ok: true } });
  });

  it('adds to the collection and checks it by reading only the new entries', async () => {
    const { acc, mox, job } = await setup();
    mox.entries = [entry('Island', 'dsk', '279', 10), entry('Opt', 'xln', '65', 2)];
    const { op, details } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'collection', mode: 'add' }, TO_EXPORT);
    expect(op.status).toBe('done');
    expect(details.verify).toMatchObject({ ok: true, scope: 'collection', expectedCopies: 3, foundCopies: 3 });
    // Preview: its size (1 page); before: every page (no snapshot saved yet); check: newest first, only the changes.
    expect(mox.reads).toEqual(['collection', 'collection', 'collection:changes']);
  });

  it('reports one progress over every step: it only grows, and ends at what was read and sent', async () => {
    const { acc, mox, job } = await setup();
    mox.entries = [entry('Island', 'dsk', '279', 10), entry('Opt', 'xln', '65', 2)];
    const seen: OverallProgress[] = [];
    // Dexie hands the hook the whole object the first time, then only the fields that changed ("overall.done").
    const hook = (changes: object, _key: unknown, obj: ChangeOp) => {
      const mods = changes as Record<string, unknown>;
      const keys = Object.keys(mods).filter((k) => k === 'overall' || k.startsWith('overall.'));
      if (!keys.length) return;
      const o = { ...obj.overall, ...(mods.overall as OverallProgress | undefined) } as Record<string, unknown>;
      for (const k of keys) if (k !== 'overall') o[k.slice('overall.'.length)] = mods[k];
      seen.push(o as unknown as OverallProgress);
    };
    db.changeOps.hook('updating', hook);
    try {
      const { op } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'collection', mode: 'add' }, TO_EXPORT);
      // Before: 1 page; 1 change (the import); the check: 1 page (only the changes).
      expect(op.overall).toEqual({ done: 3, total: 3, step: 3, steps: 3 });
    } finally {
      db.changeOps.hook('updating').unsubscribe(hook);
    }
    expect(seen.length).toBeGreaterThan(3);
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i].done).toBeGreaterThanOrEqual(seen[i - 1].done);
      expect(seen[i].step).toBeGreaterThanOrEqual(seen[i - 1].step);
    }
    for (const o of seen) expect(o.done).toBeLessThanOrEqual(o.total);
    expect(seen.map((o) => o.step)).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it('a deletion by someone else during the export makes the check read every page, and shows it', async () => {
    const { acc, mox, job } = await setup();
    const opt = entry('Opt', 'xln', '65', 2);
    mox.entries = [entry('Island', 'dsk', '279', 10), opt];
    mox.failOn = (op) => {
      if (op.op === 'importCsv') mox.entries = mox.entries.filter((e) => e !== opt);
      return null;
    };
    const { details } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'collection', mode: 'add' }, TO_EXPORT);
    expect(mox.reads.slice(-2)).toEqual(['collection:changes', 'collection']);
    expect(details.verify).toMatchObject({ ok: false, otherChanged: [{ name: 'Opt', expected: 2, found: 0 }] });
  });

  it('reports a card Moxfield imported as another print', async () => {
    const { acc, mox, job } = await setup();
    mox.misprint = { from: 'Sol Ring', to: { set: 'cmr', cn: '472' } };
    const { op, details } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'collection', mode: 'add' }, TO_EXPORT);
    expect(op).toMatchObject({ status: 'done', phase: 'Done, with differences (see below)' });
    expect(details.verify).toMatchObject({ ok: false, short: [{ key: 'c21|263|nonFoil' }], extra: [{ key: 'cmr|472|nonFoil' }] });
  });

  it('changes nothing when the target changed since the preview', async () => {
    const { acc, mox, job } = await setup();
    mox.binders = [BINDER];
    mox.entries = [entry('Opt', 'xln', '65', 4, 'nonFoil', 'b1')];
    const { op, calls } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'binder', binderId: 'b1', mode: 'replace' }, TO_EXPORT, () =>
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
    const res = await job.start({ target: { accountKey: acc.key, kind: 'collection', mode: 'add' }, items: TO_EXPORT, digest: 'x', sourceAccountKey: null, source: 't' });
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
    const { op, details, calls } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'newBinder', name: 'X', visibility: 'private' }, TO_EXPORT);
    expect(op).toMatchObject({ status: 'failed', unknownCalls: 1 });
    expect(op.error).toMatch(/doesn't know whether Moxfield made the change/);
    expect(calls.map((c) => c.outcome)).toEqual(['ok', 'unknown']);
    expect(mox.writes.map((w) => w.op)).toEqual(['createBinder', 'importCsv']);
    // The collection was read again afterwards: nothing of the export is there.
    expect(details.verify).toMatchObject({ ok: false, foundCopies: 0 });
  });

  it('shares the site with the sync: one job at a time', async () => {
    const { acc, job, lock } = await setup();
    lock.tryAcquire('sync');
    expect(await job.readTarget(acc.key as never)).toMatchObject({ ok: false, code: 'busy', error: expect.stringMatching(/syncing/) });
    expect(await job.start({ target: { accountKey: acc.key, kind: 'collection', mode: 'add' }, items: TO_EXPORT, digest: 'x', sourceAccountKey: null, source: 't' })).toMatchObject({
      ok: false,
      code: 'busy',
    });
    lock.release('sync');
    expect((await job.readTarget(acc.key as never)).ok).toBe(true);
    expect(lock.heldBy).toBeNull();
  });

  it('refuses malformed items', async () => {
    const { acc, job } = await setup();
    const bad = [[], [{ ...TO_EXPORT[0], qty: 0 }], [{ ...TO_EXPORT[0], finish: 'gold' }], [{ ...TO_EXPORT[0], set: '' }], 'x'];
    for (const items of bad) {
      expect(await job.start({ target: { accountKey: acc.key, kind: 'collection', mode: 'add' }, items: items as never, digest: 'x', sourceAccountKey: null, source: 't' })).toMatchObject({
        ok: false,
        code: 'bad_request',
      });
    }
  });
});

describe('Export list', () => {
  it('adds new prints only, sets quantities, removes and clears', async () => {
    const { exportListReducer, exportListTotals, MAX_EXPORT_QTY } = await import('@/lib/export/list');
    let s = exportListReducer(new Map(), { type: 'add', items: [item('Sol Ring', 'c21', '263', 2), item('Opt', 'xln', '65', 0)] });
    expect([...s.keys()]).toEqual(['c21|263|nonFoil']);
    s = exportListReducer(s, { type: 'setQty', key: 'c21|263|nonFoil', qty: 5 });
    // Already in the list: adding again keeps the quantity chosen.
    s = exportListReducer(s, { type: 'add', items: [item('Sol Ring', 'c21', '263', 2), item('Island', 'dsk', '279', 3)] });
    expect(exportListTotals(s)).toEqual({ prints: 2, copies: 8 });
    expect(exportListReducer(s, { type: 'setQty', key: 'dsk|279|nonFoil', qty: 99999 }).get('dsk|279|nonFoil')!.qty).toBe(MAX_EXPORT_QTY);
    expect(exportListReducer(s, { type: 'setQty', key: 'dsk|279|nonFoil', qty: 0 }).has('dsk|279|nonFoil')).toBe(false);
    expect(exportListReducer(s, { type: 'remove', keys: ['nope'] })).toBe(s);
    expect(exportListReducer(s, { type: 'remove', keys: ['c21|263|nonFoil'] }).size).toBe(1);
    expect(exportListReducer(s, { type: 'clear' }).size).toBe(0);
  });
});
