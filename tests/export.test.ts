import Papa from 'papaparse';
import { clearChangeLogOf, getOp, markStaleOps, opCalls, startOps } from '@/lib/changes/log';
import type { ChangeOp } from '@/lib/changes/types';
import type { OverallProgress } from '@/lib/progress';
import { db } from '@/lib/db';
import type { CollectionEntry, Finish } from '@/lib/cards/types';
import { batchIssues, runOrder } from '@/lib/export/batch';
import { ExportJob, type StartExportRequest, type StartExportsRequest } from '@/lib/export/job';
import { afterRead, beforeRead, mergeItems, planExport, previewRead, stateCovers, type PlanContext } from '@/lib/export/plan';
import type { ExportDetails, ExportItem, ExportTarget, TargetState } from '@/lib/export/types';
import { verifyExport } from '@/lib/export/verify';
import { SiteLock } from '@/lib/sites/lock';
import { moxfieldSite } from '@/lib/sites/moxfield/provider';
import { moxfieldExporter } from '@/lib/sites/moxfield/export';
import { MOX_LANGUAGES } from '@/lib/sites/moxfield/languages';
import { TabTransport } from '@/lib/sites/tab-transport';
import type { SiteBinder, SiteMutation, SiteResult } from '@/lib/sites/types';
import type { DeckCard, DeckFolder, DeckSummary } from '@/lib/decks/types';
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
  lang: 'en',
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

  it('plans one write per print in another language than English, and says why', () => {
    const fr = { ...item('Suspend', 'mh2', '68', 1), cardId: '1MR1a', lang: 'fr', printLang: 'fr' };
    const p = planExport({ accountKey: A_KEY, kind: 'newBinder', name: 'x', visibility: 'private' }, [...exportList, fr], state(), ctx({ limits: { ...moxfieldExporter.limits } }));
    expect(p.writes).toBe(1 + 1 + 1); // the binder, one CSV import, the French print
    expect(p.steps.join('\n')).toMatch(/1 print in another language than English one by one, to keep their exact print/);
    // Without a card id it can only go through the CSV.
    expect(moxfieldExporter.importItems([{ ...fr, cardId: '' }], null).map((w) => w.op)).toEqual(['importCsv']);
  });

  it('keeps languages apart when merging, and writes each one in the CSV', () => {
    const fr = { ...item('Sol Ring', 'c21', '263', 1), key: 'c21|263|nonFoil|fr', lang: 'fr' };
    const merged = mergeItems([item('Sol Ring', 'c21', '263', 2), fr, { ...fr, key: 'other', qty: 2 }]);
    expect(merged.map((i) => [i.key, i.lang ?? 'en', i.qty])).toEqual([
      ['c21|263|nonFoil|en', 'en', 2],
      ['c21|263|nonFoil|fr', 'fr', 3],
    ]);
    const [write] = moxfieldExporter.importItems([...merged, { ...fr, key: 'zhs', lang: 'zhs', qty: 1 }], null);
    const rows = Papa.parse<string[]>((write as { csv: string }).csv.trim()).data.slice(1);
    expect(rows.map((r) => r[5])).toEqual(['English', 'French', 'Simplified Chinese']);
  });

  it('merges the export by print and drops empty items', () => {
    expect(mergeItems(exportList).map((i) => [i.key, i.qty])).toEqual([
      ['dom|168|foil|en', 4],
      ['c21|263|nonFoil|en', 3],
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

  it('the digest depends only on what the target read of the binders (an export to another binder just before changes nothing)', () => {
    const s = state();
    const more: TargetState = { ...s, binders: [...s.binders, { id: 'b9', publicId: 'pb9', name: 'Other', visibility: 'private' }] };
    const binderAdd: ExportTarget = { accountKey: A_KEY, kind: 'binder', binderId: 'b1', mode: 'add' };
    const newBinder: ExportTarget = { accountKey: A_KEY, kind: 'newBinder', name: 'Wish', visibility: 'private' };
    for (const t of [binderAdd, { ...binderAdd, mode: 'replace' }, { accountKey: A_KEY, kind: 'collection', mode: 'add' }, newBinder] as ExportTarget[]) {
      expect(planExport(t, exportList, more, ctx()).digest).toBe(planExport(t, exportList, s, ctx()).digest);
    }
    // A binder of the new one's name appeared (the preview didn't warn about it).
    const named: TargetState = { ...s, binders: [...s.binders, { ...BINDER, id: 'b8', name: ' wish ' }] };
    expect(planExport(newBinder, exportList, named, ctx()).digest).not.toBe(planExport(newBinder, exportList, s, ctx()).digest);
    // The binder was renamed (its name is what a replace has the user type).
    const renamed: TargetState = { ...s, binders: [{ ...BINDER, name: 'Trades' }] };
    expect(planExport(binderAdd, exportList, renamed, ctx()).digest).not.toBe(planExport(binderAdd, exportList, s, ctx()).digest);
    // The same target, built in another order.
    expect(planExport({ mode: 'add', binderId: 'b1', kind: 'binder', accountKey: A_KEY }, exportList, s, ctx()).digest).toBe(planExport(binderAdd, exportList, s, ctx()).digest);
  });
});

describe('Export to several targets: rules', () => {
  const B_KEY = 'moxfield:222222' as never;
  const nb = (name: string, accountKey = A_KEY): ExportTarget => ({ accountKey, kind: 'newBinder', name, visibility: 'private' });
  const coll = (mode: 'add' | 'replace', accountKey = A_KEY): ExportTarget => ({ accountKey, kind: 'collection', mode });
  const binder = (binderId: string, mode: 'add' | 'replace' = 'add'): ExportTarget => ({ accountKey: A_KEY, kind: 'binder', binderId, mode });
  const errors = (ts: ExportTarget[]) => batchIssues(ts).filter((i) => i.level === 'error').map((i) => i.index);

  it('refuses the same destination twice, and a whole-collection replace with another target on its account', () => {
    expect(errors([coll('add'), coll('add')])).toEqual([1]);
    expect(errors([binder('b1'), binder('b1', 'replace')])).toEqual([1]);
    expect(errors([nb('Trade'), nb(' trade ')])).toEqual([1]);
    expect(errors([nb('Trade'), nb('Trade', B_KEY)])).toEqual([]);
    expect(errors([coll('replace'), nb('X')])).toEqual([0, 1]);
    expect(errors([coll('replace'), coll('add', B_KEY)])).toEqual([]);
    expect(errors(Array.from({ length: 11 }, (_, i) => nb(`n${i}`, `moxfield:${i + 1}` as never)))).toEqual([10]);
  });

  it('warns when two targets share an account: its collection gets the cards once per target', () => {
    expect(batchIssues([nb('X'), coll('add')])).toEqual([{ index: 1, level: 'warning', text: expect.stringMatching(/Target 1 is on the same account/) }]);
    expect(batchIssues([nb('X'), nb('Y', B_KEY)])).toEqual([]);
  });

  it('exports binder replaces first, the others in the list order', () => {
    expect(runOrder([nb('X'), binder('b1', 'replace'), coll('add'), binder('b2', 'replace'), binder('b3')])).toEqual([1, 3, 0, 2, 4]);
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

  it("checks the print's language too: a French print imported as the English one is one short and one extra", () => {
    const fr = { ...item('Suspend', 'mh2', '68', 1), lang: 'fr', printLang: 'fr' };
    const p = plan({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, [fr], []);
    const exact = { ...entry('Suspend', 'mh2', '68', 1), lang: 'fr', card: { ...card('Suspend', 'mh2', '68'), lang: 'fr' } };
    expect(verifyExport(p, [], [exact], null).ok).toBe(true);
    // What Moxfield's CSV import makes of it: Language French, but the English print.
    const v = verifyExport(p, [], [{ ...exact, card: { ...exact.card, lang: 'en' } }], null);
    expect(v.short).toMatchObject([{ key: 'mh2|68|nonFoil|fr', lang: 'fr', printLang: 'fr' }]);
    expect(v.extra).toMatchObject([{ key: 'mh2|68|nonFoil|fr|en', lang: 'fr', printLang: 'en' }]);
  });

  it('checks the language too: a card imported in another language is one short and one extra', () => {
    // Language French on the English print (like WOC #70 Mantle of the Ancients).
    const fr = { ...item('Suspend', 'mh2', '68', 1), lang: 'fr', printLang: 'en' };
    const p = plan({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, [fr], []);
    const french = { ...entry('Suspend', 'mh2', '68', 1), lang: 'fr' };
    expect(verifyExport(p, [], [french], null)).toMatchObject({ ok: true, expectedCopies: 1, foundCopies: 1 });
    const v = verifyExport(p, [], [entry('Suspend', 'mh2', '68', 1)], null);
    expect(v.short).toMatchObject([{ key: 'mh2|68|nonFoil|fr|en', lang: 'fr', printLang: 'en', expected: 1, found: 0 }]);
    expect(v.extra).toMatchObject([{ key: 'mh2|68|nonFoil|en', lang: 'en', expected: 0, found: 1 }]);
  });

  it('a card imported as another print is one short and one extra', () => {
    const p = plan({ accountKey: A_KEY, kind: 'collection', mode: 'add' }, [item('Sol Ring', 'c21', '263', 1)], []);
    const v = verifyExport(p, [], [entry('Sol Ring', 'cmr', '472', 1)], null);
    expect(v.ok).toBe(false);
    expect(v.short).toMatchObject([{ key: 'c21|263|nonFoil|en', expected: 1, found: 0 }]);
    expect(v.extra).toMatchObject([{ key: 'cmr|472|nonFoil|en', expected: 0, found: 1 }]);
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

interface FakeDeck {
  id: string;
  publicId: string;
  name: string;
  folderId?: string;
  version: number;
  lastUpdatedAt: string;
  cards: DeckCard[];
  tooBig?: boolean;
}
const deckCard = (name: string, set: string, cn: string, qty: number, board = 'mainboard', finish: Finish = 'nonFoil'): DeckCard => ({
  board,
  qty,
  finish,
  isProxy: false,
  isAlter: false,
  card: card(name, set, cn),
});
/** Adds copies to a deck board (one row per print + finish + card object, like Moxfield). */
function addDeckCard(d: { cards: DeckCard[] }, c: DeckCard) {
  const same = d.cards.find((x) => x.board === c.board && x.card.set === c.card.set && x.card.cn === c.card.cn && x.finish === c.finish && x.card.id === c.card.id);
  if (same) same.qty += c.qty;
  else d.cards.push(c);
}

/** A fake Moxfield account: binders, a collection, decks and folders, changed by the writes like the real site would. */
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
  /** Moxfield's card objects by id, for addCard (one per print and language). */
  catalog = new Map<string, { name: string; set: string; cn: string; lang: string }>();
  failOn?: (op: SiteMutation) => SiteResult | null;
  /** Decks (with every board's cards) and deck folders. */
  decks: FakeDeck[] = [];
  folders: DeckFolder[] = [];
  /** Deck reads ('deck:<publicId>'). */
  deckReads: string[] = [];
  /** A created deck's answer says its id and version (Moxfield's create may only say its publicId). */
  createSaysVersion = false;
  private n = 0;

  private deckChanged(d: FakeDeck) {
    d.version++;
    d.lastUpdatedAt = new Date(Date.UTC(2026, 10, 24) + ++this.n * 1000).toISOString();
  }

  /** Moxfield's deck import text, one line each ("2 Sol Ring (C21) 263 *F*"), into the mainboard. */
  private importText(d: FakeDeck, text: string) {
    for (const line of text.split('\n').filter(Boolean)) {
      const m = /^(\d+) (.+) \(([A-Z0-9]+)\) (\S+?)( \*F\*| \*E\*)?$/.exec(line);
      if (!m) throw new Error(`bad line ${line}`);
      let [set, cn] = [m[3].toLowerCase(), m[4]];
      if (this.misprint && m[2] === this.misprint.from) ({ set, cn } = this.misprint.to);
      const finish: Finish = m[5] === ' *F*' ? 'foil' : m[5] === ' *E*' ? 'etched' : 'nonFoil';
      addDeckCard(d, deckCard(m[2], set, cn, Number(m[1]), 'mainboard', finish));
    }
  }

  deckSummary = (d: FakeDeck): DeckSummary => {
    const count = (b: string) => d.cards.filter((c) => c.board === b).reduce((s, c) => s + c.qty, 0);
    const folder = this.folders.find((f) => f.id === d.folderId);
    return {
      id: d.id,
      publicId: d.publicId,
      name: d.name,
      format: 'none',
      visibility: 'private',
      folderPath: folder?.path ?? '',
      ...(folder ? { folderId: folder.id } : {}),
      lastUpdatedAt: d.lastUpdatedAt,
      createdAt: '',
      mainboardCount: count('mainboard'),
      sideboardCount: count('sideboard'),
      maybeboardCount: count('maybeboard'),
      commanders: [],
      publicUrl: '',
    };
  };

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
    if (req.kind === 'deckList') return { ok: true, kind: 'deckList', decks: this.decks.map(this.deckSummary) };
    if (req.kind === 'deckFolders') return { ok: true, kind: 'deckFolders', folders: [...this.folders], totalPages: 1 };
    if (req.kind === 'deck') {
      const d = this.decks.find((x) => x.publicId === req.publicId);
      if (!d) return { ok: false, status: 404, code: 'http', message: 'Moxfield answered HTTP 404' };
      this.deckReads.push(`deck:${d.publicId}`);
      return { ok: true, kind: 'deck', lastUpdatedAt: d.lastUpdatedAt, cards: d.cards.map((c) => ({ ...c, card: { ...c.card } })), id: d.id, version: d.version, ...(d.tooBig ? { tooBig: true } : {}) };
    }
    if (req.kind !== 'mutate' || !req.op) throw new Error(`unexpected ${req.kind}`);
    const op = req.op;
    this.writes.push(op);
    const fail = this.failOn?.(op);
    if (fail) return fail;
    const deckOf = (o: { deckId: string; publicId: string; version: number }): FakeDeck | SiteResult => {
      const d = this.decks.find((x) => x.id === o.deckId && x.publicId === o.publicId);
      if (!d) return { ok: false, status: 404, code: 'http', message: 'Moxfield answered HTTP 404' };
      // Like an editor that checks the version it was sent.
      if (d.version !== o.version) return { ok: false, status: 409, code: 'http', message: 'Moxfield answered HTTP 409' };
      return d;
    };
    switch (op.op) {
      case 'createDeckFolder': {
        const f = { id: `fo${++this.n}`, path: op.name };
        this.folders.push(f);
        return { ok: true, kind: 'mutate', status: 200, response: JSON.stringify({ id: f.id, name: f.path }), folder: f };
      }
      case 'createDeck': {
        const d: FakeDeck = { id: `dk${++this.n}`, publicId: `pubdeck${this.n}`, name: op.name, folderId: op.folderId, version: 0, lastUpdatedAt: '', cards: [] };
        this.importText(d, op.importText);
        this.deckChanged(d);
        this.decks.push(d);
        return { ok: true, kind: 'mutate', status: 200, response: '{}', deck: this.createSaysVersion ? { id: d.id, publicId: d.publicId, version: d.version } : { publicId: d.publicId } };
      }
      case 'importDeck': {
        const d = deckOf(op);
        if ('ok' in d) return d;
        this.importText(d, op.importText);
        this.deckChanged(d);
        return { ok: true, kind: 'mutate', status: 200, response: '{}', deck: { id: d.id, publicId: d.publicId, version: d.version } };
      }
      case 'addDeckCard': {
        const d = deckOf(op);
        if ('ok' in d) return d;
        const c = this.catalog.get(op.cardId);
        if (!c) return { ok: false, status: 400, code: 'http', message: 'Moxfield answered HTTP 400' };
        const dc = deckCard(c.name, c.set, c.cn, op.quantity, 'mainboard', op.finish);
        addDeckCard(d, { ...dc, card: { ...dc.card, id: op.cardId, lang: c.lang } });
        this.deckChanged(d);
        // This answer doesn't say the new version: the next change reads the deck first.
        return { ok: true, kind: 'mutate', status: 200, response: '{}', deck: {}, imported: { ok: true, count: op.quantity, errors: [] } };
      }
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
          // Like Moxfield: the Language column sets the Language field, but the print is the English one.
          const lang = MOX_LANGUAGES.find((l) => l.name === r.Language)?.code ?? 'en';
          this.entries.push({ ...entry(r.Name, set, cn, Number(r.Count), finish, op.binderId), lang, updatedAt: new Date(Date.UTC(2026, 10, 16) + ++this.n * 1000).toISOString() });
        }
        const count = rows.reduce((s, r) => s + Number(r.Count), 0);
        return { ok: true, kind: 'mutate', status: 200, response: `{"isSuccessful":true,"totalImportedCount":${count},"errors":[]}`, imported: { ok: true, count, errors: [] } };
      }
      case 'addCard': {
        const c = this.catalog.get(op.cardId);
        if (!c) return { ok: false, status: 400, code: 'http', message: 'Moxfield answered HTTP 400' };
        const lang = MOX_LANGUAGES.find((l) => l.id === op.languageId)!.code;
        const e = entry(c.name, c.set, c.cn, op.quantity, op.finish, op.binderId);
        this.entries.push({ ...e, lang, card: { ...e.card, id: op.cardId, lang: c.lang }, updatedAt: new Date(Date.UTC(2026, 10, 16) + ++this.n * 1000).toISOString() });
        return { ok: true, kind: 'mutate', status: 200, response: '{}', imported: { ok: true, count: op.quantity, errors: [] } };
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
    const plan = planExport(target, items, read.state, { sourceAccountKey: null, targetName: 'alice', limits: { ...moxfieldExporter.limits, pageSize: 5000 } });
    change?.();
    const req: StartExportRequest = { target, items, digest: plan.digest, sourceAccountKey: null, source: 'test', estimate: plan.requests };
    const res = await job.start(req);
    if (!res.ok) throw new Error(res.error);
    await job.finished;
    const op = (await getOp(res.opId))!;
    return { op, details: op.details as ExportDetails, calls: await opCalls(res.opId) };
  }

  const TO_EXPORT = [item('Sol Ring', 'c21', '263', 2), item('Llanowar Elves', 'dom', '168', 1, 'foil')];

  it("adds a print in another language by its card id: Moxfield's CSV import would pick the English print", async () => {
    const { acc, mox, job } = await setup();
    mox.catalog.set('1MR1a', { name: 'Suspend', set: 'mh2', cn: '68', lang: 'fr' });
    const french = { ...item('Suspend', 'mh2', '68', 2), cardId: '1MR1a', lang: 'fr', printLang: 'fr' };
    // Language French on the English print (Moxfield has no French one): the CSV import keeps it as it is.
    const mantle = { ...item('Mantle of the Ancients', 'woc', '70', 1), lang: 'fr', printLang: 'en' };
    const { op, details } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'newBinder', name: 'Langs', visibility: 'private' }, [...TO_EXPORT, french, mantle]);
    expect(op.status).toBe('done');
    expect(mox.writes.map((w) => w.op)).toEqual(['createBinder', 'importCsv', 'addCard']);
    expect(mox.writes[2]).toEqual({ site: 'moxfield', op: 'addCard', cardId: '1MR1a', quantity: 2, finish: 'nonFoil', languageId: 'kAVXO', binderId: 'nb1' });
    const csv = (mox.writes[1] as { csv: string }).csv;
    expect(csv).toContain('"Mantle of the Ancients","woc","Near Mint","French"');
    expect(csv).not.toContain('Suspend');
    expect(details.imported).toMatchObject({ count: 6, failed: 0 });
    expect(details.verify).toMatchObject({ ok: true, expectedCopies: 6, foundCopies: 6 });
    expect(mox.entries.find((e) => e.card.name === 'Suspend')).toMatchObject({ lang: 'fr', card: { id: '1MR1a', lang: 'fr' } });
    expect(op.details).toMatchObject({ add: { prints: 4, copies: 6 } });
  });

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
    expect(details.verify).toMatchObject({ ok: false, short: [{ key: 'c21|263|nonFoil|en' }], extra: [{ key: 'cmr|472|nonFoil|en' }] });
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

  describe('several targets', () => {
    /** Reads and plans every target before starting, like the dialog, then the request that starts them all. */
    async function previewAll(job: ExportJob, targets: ExportTarget[], items = TO_EXPORT): Promise<StartExportsRequest> {
      const exports: StartExportsRequest['exports'] = [];
      for (const target of targets) {
        const read = await job.readTarget(target.accountKey as never, previewRead(target));
        if (!read.ok) throw new Error(read.error);
        const plan = planExport(target, items, read.state, { sourceAccountKey: null, targetName: 'x', limits: { ...moxfieldExporter.limits, pageSize: 5000 } });
        exports.push({ target, digest: plan.digest, estimate: plan.requests, label: plan.targetLabel });
      }
      return { items, sourceAccountKey: null, source: 'test', exports };
    }
    /** Holds the batch's first write until `open()`; `reached` resolves when it is there. */
    function gate(port: FakeTabs) {
      let open!: () => void;
      let reach!: () => void;
      const opened = new Promise<void>((r) => (open = r));
      const reached = new Promise<void>((r) => (reach = r));
      let armed = true;
      port.onCall = async (call) => {
        if (armed && call.req.kind === 'mutate') {
          armed = false;
          reach();
          await opened;
        }
      };
      return { reached, open };
    }
    const ops = (ids: number[]) => Promise.all(ids.map(async (id) => (await getOp(id))!));
    const started = async (job: ExportJob, req: StartExportsRequest) => {
      const res = await job.startMany(req);
      if (!res.ok) throw new Error(res.error);
      return res.opIds;
    };
    /** Bob too, logged in in a second tab, with his own Moxfield account. */
    async function withBob(port: FakeTabs, alice: FakeMox) {
      const bob = await newAccount(BOB.userId, BOB.userName);
      const bobMox = new FakeMox();
      port.tabs.push({ id: 2, account: BOB });
      port.answer = ((as: typeof ALICE, call: never) => (as.userId === BOB.userId ? bobMox : alice).answer(as, call)) as never;
      return { bob, bobMox };
    }

    it('makes one export per target, one after another, each with its own row, writes and check', async () => {
      const { acc, mox, port, job, lock } = await setup();
      mox.binders = [BINDER];
      mox.entries = [entry('Opt', 'xln', '65', 1)];
      // A new binder first: the binder list then changes, which must not refuse the export after it.
      const req = await previewAll(job, [
        { accountKey: acc.key, kind: 'newBinder', name: 'A', visibility: 'private' },
        { accountKey: acc.key, kind: 'collection', mode: 'add' },
      ]);
      const g = gate(port);
      const ids = await started(job, req);
      await g.reached;
      expect((await ops(ids)).map((o) => o.status)).toEqual(['running', 'queued']);
      // The site is taken until the last one ends: no preview read, no other export, no sync in between.
      expect(await job.readTarget(acc.key as never)).toMatchObject({ ok: false, code: 'busy', error: expect.stringMatching(/1 more waiting/) });
      expect(await job.startMany(req)).toMatchObject({ ok: false, code: 'busy' });
      expect(lock.tryAcquire('sync')).toBe(false);
      expect(lock.heldBy).toBe('export');
      g.open();
      await job.finished;
      const [a, b] = await ops(ids);
      expect([a.status, b.status]).toEqual(['done', 'done']);
      expect(b.startedAt).toBeGreaterThanOrEqual(a.finishedAt!);
      expect(a.title).toMatch(/to the new binder “A”/);
      expect(b.title).toMatch(/to alice's collection/);
      expect([(a.details as ExportDetails).verify?.ok, (b.details as ExportDetails).verify?.ok]).toEqual([true, true]);
      expect(mox.writes.map((w) => w.op)).toEqual(['createBinder', 'importCsv', 'importCsv']);
      expect((await opCalls(ids[0])).length).toBe(2);
      expect((await opCalls(ids[1])).length).toBe(1);
      expect(lock.heldBy).toBeNull();
    });

    it('replaces a binder after creating a new one on the same account', async () => {
      const { acc, mox, job } = await setup();
      mox.binders = [BINDER];
      mox.entries = [entry('Opt', 'xln', '65', 4, 'nonFoil', 'b1')];
      const ids = await started(
        job,
        await previewAll(job, [
          { accountKey: acc.key, kind: 'newBinder', name: 'A', visibility: 'private' },
          { accountKey: acc.key, kind: 'binder', binderId: 'b1', mode: 'replace' },
        ]),
      );
      await job.finished;
      expect((await ops(ids)).map((o) => o.status)).toEqual(['done', 'done']);
      expect(mox.entries.filter((e) => e.binderId === 'b1').map((e) => e.card.name).sort()).toEqual(['Llanowar Elves', 'Sol Ring']);
    });

    it("goes on when one fails: the others don't depend on it", async () => {
      const { acc, mox, job } = await setup();
      mox.binders = [BINDER];
      mox.entries = [entry('Opt', 'xln', '65', 4, 'nonFoil', 'b1')];
      const req = await previewAll(job, [
        { accountKey: acc.key, kind: 'binder', binderId: 'b1', mode: 'replace' },
        { accountKey: acc.key, kind: 'collection', mode: 'add' },
      ]);
      // The binder changed since its preview: that export refuses, the next one is made.
      mox.entries.push(entry('Bolt', 'lea', '161', 1, 'nonFoil', 'b1'));
      const ids = await started(job, req);
      await job.finished;
      const [a, b] = await ops(ids);
      expect(a).toMatchObject({ status: 'failed', calls: 0 });
      expect(a.error).toMatch(/changed since the preview/);
      expect(b.status).toBe('done');
      expect(mox.writes.map((w) => w.op)).toEqual(['importCsv']);
    });

    it('cancels only the export asked: the running one stops, the next still runs', async () => {
      const { acc, mox, port, job } = await setup();
      const req = await previewAll(job, [
        { accountKey: acc.key, kind: 'newBinder', name: 'A', visibility: 'private' },
        { accountKey: acc.key, kind: 'newBinder', name: 'B', visibility: 'private' },
      ]);
      const g = gate(port);
      const ids = await started(job, req);
      await g.reached;
      expect(job.cancel([ids[0]])).toBe(true);
      g.open();
      await job.finished;
      const [a, b] = await ops(ids);
      expect(a.status).toBe('cancelled');
      expect(b.status).toBe('done');
      expect(mox.writes.map((w) => (w.op === 'createBinder' ? `create ${w.name}` : w.op))).toEqual(['create A', 'create B', 'importCsv']);
    });

    it('cancels a waiting export before it starts: nothing is sent for it', async () => {
      const { acc, mox, port, job } = await setup();
      const req = await previewAll(job, [
        { accountKey: acc.key, kind: 'newBinder', name: 'A', visibility: 'private' },
        { accountKey: acc.key, kind: 'newBinder', name: 'B', visibility: 'private' },
        { accountKey: acc.key, kind: 'collection', mode: 'add' },
      ]);
      const g = gate(port);
      const ids = await started(job, req);
      await g.reached;
      expect(job.cancel([ids[1]])).toBe(true);
      await expect.poll(async () => (await getOp(ids[1]))!.status).toBe('cancelled');
      g.open();
      await job.finished;
      const [a, b, c] = await ops(ids);
      expect([a.status, b.status, c.status]).toEqual(['done', 'cancelled', 'done']);
      expect(b.error).toMatch(/before it started: nothing was changed/);
      expect(await opCalls(ids[1])).toEqual([]);
      expect(mox.binders.map((x) => x.name)).toEqual(['A']);
    });

    it('cancels them all: the running one stops, none of the waiting ones starts', async () => {
      const { acc, mox, port, job, lock } = await setup();
      const req = await previewAll(job, [
        { accountKey: acc.key, kind: 'newBinder', name: 'A', visibility: 'private' },
        { accountKey: acc.key, kind: 'newBinder', name: 'B', visibility: 'private' },
        { accountKey: acc.key, kind: 'collection', mode: 'add' },
      ]);
      const g = gate(port);
      const ids = await started(job, req);
      await g.reached;
      expect(job.cancel()).toBe(true);
      g.open();
      await job.finished;
      expect((await ops(ids)).map((o) => o.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
      expect(mox.writes.map((w) => w.op)).toEqual(['createBinder']);
      expect(lock.heldBy).toBeNull();
    });

    it('refuses the whole export, before any row, when one target is not valid', async () => {
      const { acc, job, lock } = await setup();
      const ok: StartExportsRequest['exports'][number] = { target: { accountKey: acc.key, kind: 'collection', mode: 'add' }, digest: 'x' };
      const start = (...exports: unknown[]) => job.startMany({ items: TO_EXPORT, sourceAccountKey: null, source: 't', exports: exports as never });
      expect(await start(ok, ok)).toMatchObject({ ok: false, code: 'bad_request', index: 1, error: expect.stringMatching(/same collection/) });
      expect(await start(ok, { target: { accountKey: acc.key, kind: 'binder', binderId: 'a b', mode: 'add' }, digest: 'x' })).toMatchObject({ ok: false, code: 'bad_request', index: 1 });
      expect(await start({ target: { accountKey: acc.key, kind: 'collection', mode: 'wipe' }, digest: 'x' })).toMatchObject({ ok: false, code: 'bad_request', index: 0 });
      expect(await start({ target: { accountKey: acc.key, kind: 'newBinder', name: '   ', visibility: 'private' }, digest: 'x' })).toMatchObject({ ok: false, code: 'bad_request' });
      expect(await start(ok, { target: { accountKey: 'moxfield:999', kind: 'collection', mode: 'add' }, digest: 'x' })).toMatchObject({ ok: false, code: 'no_account', index: 1 });
      expect(await start(...Array.from({ length: 11 }, () => ok))).toMatchObject({ ok: false, code: 'bad_request' });
      expect(await start()).toMatchObject({ ok: false, code: 'bad_request' });
      expect(await db.changeOps.count()).toBe(0);
      expect(lock.heldBy).toBeNull();
    });

    it('starts one of two exports asked at the same time; the other is busy', async () => {
      const { acc, job } = await setup();
      const req = await previewAll(job, [{ accountKey: acc.key, kind: 'collection', mode: 'add' }]);
      const [a, b] = await Promise.all([job.startMany(req), job.startMany(req)]);
      expect([a.ok, b.ok].sort()).toEqual([false, true]);
      expect((a.ok ? b : a) as object).toMatchObject({ code: 'busy' });
      await job.finished;
      expect(await db.changeOps.count()).toBe(1);
    });

    it('exports to several accounts, each one as itself', async () => {
      const { acc, mox, port, job } = await setup();
      const { bob, bobMox } = await withBob(port, mox);
      const ids = await started(
        job,
        await previewAll(job, [
          { accountKey: acc.key, kind: 'newBinder', name: 'A', visibility: 'private' },
          { accountKey: bob.key, kind: 'collection', mode: 'add' },
        ]),
      );
      await job.finished;
      const [a, b] = await ops(ids);
      expect([a.status, b.status]).toEqual(['done', 'done']);
      expect([a.userName, b.userName]).toEqual(['alice', 'bob']);
      expect((await opCalls(ids[0])).every((c) => c.as?.userId === ALICE.userId)).toBe(true);
      expect((await opCalls(ids[1])).every((c) => c.as?.userId === BOB.userId)).toBe(true);
      expect(mox.writes.map((w) => w.op)).toEqual(['createBinder', 'importCsv']);
      expect(bobMox.writes.map((w) => w.op)).toEqual(['importCsv']);
    });

    it("forgetting an account stops its waiting exports only: another account's export goes on", async () => {
      const { acc, mox, port, job } = await setup();
      const { bob, bobMox } = await withBob(port, mox);
      const req = await previewAll(job, [
        { accountKey: bob.key, kind: 'collection', mode: 'add' },
        { accountKey: acc.key, kind: 'newBinder', name: 'A', visibility: 'private' },
      ]);
      const g = gate(port);
      const ids = await started(job, req);
      await g.reached;
      expect(job.activeAccountKey).toBe(bob.key);
      await job.stopAccount(acc.key);
      expect((await getOp(ids[1]))!.status).toBe('cancelled');
      g.open();
      await job.finished;
      expect((await getOp(ids[0]))!.status).toBe('done');
      expect(bobMox.writes.map((w) => w.op)).toEqual(['importCsv']);
      expect(mox.writes).toEqual([]);
    });

    it('skips a waiting export whose row was deleted (its account forgotten, the log cleared)', async () => {
      const { acc, mox, port, job } = await setup();
      const { bob, bobMox } = await withBob(port, mox);
      const req = await previewAll(job, [
        { accountKey: bob.key, kind: 'collection', mode: 'add' },
        { accountKey: acc.key, kind: 'collection', mode: 'add' },
      ]);
      const g = gate(port);
      const ids = await started(job, req);
      await g.reached;
      await clearChangeLogOf(acc.key);
      g.open();
      await job.finished;
      expect((await getOp(ids[0]))!.status).toBe('done');
      expect(await getOp(ids[1])).toBeUndefined();
      expect(bobMox.writes.length).toBe(1);
      expect(mox.writes).toEqual([]);
    });

    it('a worker that died mid-batch: the running export is interrupted, the waiting ones never started', async () => {
      const { acc } = await setup();
      const row = { site: 'moxfield', accountKey: acc.key, userName: 'alice', kind: 'export', title: 't', source: 's', details: {} } as const;
      const ids = await startOps([row, row]);
      await markStaleOps();
      const [a, b] = await ops(ids);
      expect([a.status, b.status]).toEqual(['interrupted', 'interrupted']);
      expect(a.error).toMatch(/while this was running/);
      expect(b.error).toMatch(/Not started.*Nothing was changed/);
      expect(b.finishedAt).toBeTypeOf('number');
    });
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

const LIMITS = { ...moxfieldExporter.limits, pageSize: 5000 };
const gitem = (name: string, set: string, cn: string, qty: number, group: NonNullable<ExportItem['group']>): ExportItem => ({ ...item(name, set, cn, qty), group });
const FF = (rarity: string, colors = 'R') => ({ set: 'fin', setName: 'Final Fantasy', rarity, colors });
const BLB = { set: 'blb', setName: 'Bloomburrow', rarity: 'rare', colors: 'W' };
const GROUPED = [gitem('Cloud', 'fin', '1', 2, FF('mythic')), gitem('Tifa', 'fin', '2', 3, FF('rare')), gitem('Aerith', 'fic', '3', 1, FF('rare', 'WG')), gitem('Mabel', 'blb', '4', 4, BLB)];

describe('Deck export plan', () => {
  const dctx = (over: Partial<PlanContext> = {}): PlanContext => ({ sourceAccountKey: null, targetName: 'alice', limits: LIMITS, ...over });
  const FOLDER: DeckFolder = { id: 'fo1', path: 'Collection' };
  const summary = (over: Partial<DeckSummary> = {}): DeckSummary => ({
    id: 'd1',
    publicId: 'pd1',
    name: 'Spare',
    format: 'none',
    visibility: 'private',
    folderPath: '',
    lastUpdatedAt: 't1',
    createdAt: '',
    mainboardCount: 0,
    sideboardCount: 0,
    maybeboardCount: 0,
    commanders: [],
    publicUrl: '',
    ...over,
  });
  const dstate = (decks: DeckSummary[] = [], cards: Record<string, DeckCard[]> = {}, tooBig = false): TargetState => ({
    binders: [],
    read: { kind: 'decks', publicIds: Object.keys(cards) },
    entries: [],
    totals: null,
    decks,
    folders: [FOLDER],
    deckCards: Object.fromEntries(Object.entries(cards).map(([k, c]) => [k, { id: 'd1', version: 3, lastUpdatedAt: 't1', tooBig, cards: c }])),
    readAt: 0,
  });
  const NEW_DECK: ExportTarget = { accountKey: A_KEY, kind: 'newDeck', name: 'Spare', visibility: 'private', folderId: 'fo1' };

  it('a new deck: one write with its import text; refused past 1,000 cards', () => {
    const p = planExport(NEW_DECK, [item('Sol Ring', 'c21', '263', 2), item('Opt', 'xln', '65', 1)], dstate(), dctx());
    expect(p.blocked).toBeUndefined();
    expect(previewRead(NEW_DECK)).toEqual({ kind: 'decks' });
    expect(p.decks).toEqual([expect.objectContaining({ name: 'Spare', existing: null, copies: 3, before: 0, after: 3 })]);
    expect(p.folder).toEqual({ id: 'fo1', path: 'Collection', create: false });
    expect(p.writes).toBe(1);
    expect(p.steps[0]).toBe('Create the private deck “Spare” in the folder “Collection”, with 3 copies (2 prints) in its mainboard');
    const big = planExport(NEW_DECK, [item('Island', 'dsk', '279', 1001)], dstate(), dctx());
    expect(big.blocked).toMatch(/would have 1,001 cards: a deck shows at most 1,000/);
    // A deck of that name in that folder already: a second one would be made.
    expect(planExport(NEW_DECK, [item('Opt', 'xln', '65', 1)], dstate([summary({ folderId: 'fo1', folderPath: 'Collection' })]), dctx()).warnings[0].text).toMatch(/already has a deck named “Spare”/);
    expect(planExport({ ...NEW_DECK, folderId: 'gone' }, [item('Opt', 'xln', '65', 1)], dstate(), dctx()).blocked).toMatch(/folder isn't on alice/);
  });

  it('an existing deck: adds to its mainboard (its cards stay); a deck over 1,000 cards is refused', () => {
    const t: ExportTarget = { accountKey: A_KEY, kind: 'deck', deckId: 'd1', publicId: 'pd1' };
    expect(previewRead(t)).toEqual({ kind: 'decks', publicIds: ['pd1'] });
    const cards = [deckCard('Island', 'dsk', '279', 10), deckCard('Opt', 'xln', '65', 4, 'sideboard')];
    const state = dstate([summary({ mainboardCount: 10, sideboardCount: 4 })], { pd1: cards });
    const p = planExport(t, [item('Sol Ring', 'c21', '263', 2)], state, dctx());
    expect(p.blocked).toBeUndefined();
    expect(p.remove).toEqual({ entries: [], copies: 0, wholeCollection: false });
    expect(p.decks![0]).toMatchObject({ before: 14, after: 16 });
    expect(p.steps[0]).toBe('Add 2 copies (1 print) to the mainboard of “Spare” (its cards stay)');
    // The digest changes when the deck does.
    expect(planExport(t, [item('Sol Ring', 'c21', '263', 2)], dstate([summary({ lastUpdatedAt: 't2' })], { pd1: cards }), dctx()).digest).not.toBe(p.digest);
    expect(planExport(t, [item('Sol Ring', 'c21', '263', 990)], state, dctx()).blocked).toMatch(/1,004 cards \(14 now\)/);
    expect(planExport(t, [item('Opt', 'xln', '65', 1)], dstate([summary()], { pd1: cards }, true), dctx()).blocked).toMatch(/already has more cards than a deck shows/);
    expect(planExport({ ...t, deckId: 'x' }, [item('Opt', 'xln', '65', 1)], state, dctx()).blocked).toMatch(/deck isn't on alice/);
  });

  it('a deck folder: one deck per group; in an existing folder, a group whose deck is there adds to it', () => {
    const grouping = { '': 'set', 'set:fin': 'rarity' } as const;
    const nf: ExportTarget = { accountKey: A_KEY, kind: 'newFolder', name: 'By set', parentFolderId: 'fo1', visibility: 'unlisted', grouping };
    const p = planExport(nf, GROUPED, dstate(), dctx());
    expect(p.blocked).toBeUndefined();
    expect(p.folder).toEqual({ id: null, path: 'Collection/By set', create: true });
    expect(p.decks!.map((d) => [d.name, d.copies])).toEqual([
      ['Bloomburrow', 4],
      ['Final Fantasy - Rare', 4],
      ['Final Fantasy - Mythic', 2],
    ]);
    expect(p.writes).toBe(4);
    expect(p.steps[0]).toBe('Create the folder “Collection/By set” on alice');

    const f: ExportTarget = { accountKey: A_KEY, kind: 'folder', folderId: 'fo1', visibility: 'private', grouping };
    const there = summary({ id: 'd7', publicId: 'pd7', name: 'final fantasy - rare', folderId: 'fo1', folderPath: 'Collection', mainboardCount: 996 });
    const q = planExport(f, GROUPED, dstate([there, summary({ id: 'd8', name: 'Bloomburrow' })]), dctx());
    expect(q.decks!.map((d) => [d.name, d.existing?.id ?? null])).toEqual([
      ['Bloomburrow', null],
      ['Final Fantasy - Rare', 'd7'],
      ['Final Fantasy - Mythic', null],
    ]);
    // 996 + 4 = 1,000: still fits; one more doesn't.
    expect(q.blocked).toBeUndefined();
    expect(q.decks![1]).toMatchObject({ before: 996, after: 1000 });
    const r = planExport(f, GROUPED, dstate([{ ...there, mainboardCount: 997 }]), dctx());
    expect(r.blocked).toMatch(/^“Final Fantasy - Rare” would have 1,001 cards \(997 now\): a deck shows at most 1,000\. Split them into more groups/);
  });

  it('refuses a folder Moxfield would not take, or cards without their groups', () => {
    const nf: ExportTarget = { accountKey: A_KEY, kind: 'newFolder', name: 'Final Fantasy: Rares', parentFolderId: null, visibility: 'private', grouping: { '': 'set' } };
    expect(planExport(nf, GROUPED, dstate(), dctx()).blocked).toMatch(/letters, numbers, spaces and hyphens/);
    expect(planExport({ ...nf, name: 'collection' }, GROUPED, dstate(), dctx()).blocked).toMatch(/already has a folder “collection”/);
    expect(planExport({ ...nf, name: 'Spares' }, [item('Opt', 'xln', '65', 1)], dstate(), dctx()).blocked).toMatch(/set, rarity and color identity/);
    const many = Array.from({ length: 101 }, (_, i) => gitem(`C${i}`, `s${i}`, '1', 1, { set: `s${i}`, setName: `Set ${i}`, rarity: 'rare', colors: 'R' }));
    expect(planExport({ ...nf, name: 'Spares' }, many, dstate(), dctx()).blocked).toMatch(/101 decks: at most 100/);
  });
});

describe('Deck export job', () => {
  beforeEach(resetDb);
  const TO_DECK = [item('Sol Ring', 'c21', '263', 2), item('Llanowar Elves', 'dom', '168', 1, 'foil')];

  async function setup() {
    const acc = await newAccount(ALICE.userId, ALICE.userName);
    const mox = new FakeMox();
    const port = new FakeTabs();
    port.tabs = [{ id: 1, active: true, account: ALICE }];
    port.answer = mox.answer as never;
    const job = new ExportJob(moxfieldSite, {
      createTransport: ({ expect, ...ctl }) => new TabTransport(moxfieldSite, { ...ctl, expect, authWaitMs: 30, pollMs: 5, reloadSettleMs: 0 }, port),
      clientOptions: async () => ({ intervalMs: 0, jitterMs: 0, maxIntervalMs: 0, rateLimitWaitsMs: [], errorWaitsMs: [], sleep: async () => {} }),
      lock: new SiteLock(),
    });
    return { acc, mox, job };
  }

  async function exportWith(job: ExportJob, accountKey: never, target: ExportTarget, items: ExportItem[], change?: () => void) {
    const read = await job.readTarget(accountKey, previewRead(target));
    if (!read.ok) throw new Error(read.error);
    const plan = planExport(target, items, read.state, { sourceAccountKey: null, targetName: 'alice', limits: LIMITS });
    expect(plan.blocked).toBeUndefined();
    change?.();
    const res = await job.start({ target, items: plan.items, digest: plan.digest, sourceAccountKey: null, source: 'test', estimate: plan.requests, label: plan.targetLabel });
    if (!res.ok) throw new Error(res.error);
    await job.finished;
    const op = (await getOp(res.opId))!;
    return { op, details: op.details as ExportDetails, calls: await opCalls(res.opId), plan };
  }

  const mainboard = (d: FakeDeck) =>
    d.cards
      .filter((c) => c.board === 'mainboard')
      .map((c) => `${c.qty} ${c.card.name} ${c.card.set} ${c.finish}${c.card.lang !== 'en' ? ` ${c.card.lang}` : ''}`)
      .sort();

  it('creates a deck in a folder: English prints by import text, another language by its card id; then checks it', async () => {
    const { acc, mox, job } = await setup();
    mox.folders = [{ id: 'fo1', path: 'Collection' }];
    mox.catalog.set('frOpt', { name: 'Opt', set: 'xln', cn: '65', lang: 'fr' });
    const fr: ExportItem = { ...item('Opt', 'xln', '65', 2), key: 'xln|65|nonFoil|fr', cardId: 'frOpt', lang: 'fr', printLang: 'fr' };
    const { op, details, calls } = await exportWith(job, acc.key as never, { accountKey: acc.key, kind: 'newDeck', name: 'Spares', visibility: 'private', folderId: 'fo1' }, [...TO_DECK, fr]);
    expect(op.error).toBeUndefined();
    expect(op.status).toBe('done');
    expect(mox.writes.map((w) => w.op)).toEqual(['createDeck', 'addDeckCard']);
    expect(mox.writes[0]).toMatchObject({ name: 'Spares', folderId: 'fo1', importText: '1 Llanowar Elves (DOM) 168 *F*\n2 Sol Ring (C21) 263' });
    const deck = mox.decks[0];
    expect(mainboard(deck)).toEqual(['1 Llanowar Elves dom foil', '2 Opt xln nonFoil fr', '2 Sol Ring c21 nonFoil']);
    // The creation didn't say the deck's version: it was read before adding by card id, with its headers.
    expect(calls[1].headers).toEqual({ 'x-public-deck-id': deck.publicId, 'x-deck-version': '1' });
    expect(details.decks).toEqual([{ name: 'Spares', publicId: deck.publicId, created: true }]);
    expect(details.verify).toMatchObject({ ok: true, scope: 'decks', expectedCopies: 5, foundCopies: 5 });
  });

  it('adds to an existing deck: its cards and other boards stay, the version read before is sent', async () => {
    const { acc, mox, job } = await setup();
    mox.decks = [{ id: 'dk9', publicId: 'pubdeck9', name: 'Main', version: 5, lastUpdatedAt: 't0', cards: [deckCard('Island', 'dsk', '279', 10), deckCard('Opt', 'xln', '65', 1, 'sideboard')] }];
    const t: ExportTarget = { accountKey: acc.key, kind: 'deck', deckId: 'dk9', publicId: 'pubdeck9' };
    const added = await exportWith(job, acc.key as never, t, [...TO_DECK, item('Island', 'dsk', '279', 2)]);
    expect(added.op.status).toBe('done');
    expect(mox.writes[0]).toMatchObject({ op: 'importDeck', version: 5 });
    expect(mainboard(mox.decks[0])).toEqual(['1 Llanowar Elves dom foil', '12 Island dsk nonFoil', '2 Sol Ring c21 nonFoil']);
    expect(mox.decks[0].cards.filter((c) => c.board === 'sideboard')).toHaveLength(1);
    expect(added.calls[0].headers).toEqual({ 'x-public-deck-id': 'pubdeck9', 'x-deck-version': '5' });
    expect(added.details.verify).toMatchObject({ ok: true, expectedCopies: 15 });
    // A sideboard card gone meanwhile shows in the check.
    mox.failOn = (op) => (op.op === 'importDeck' ? ((mox.decks[0].cards = mox.decks[0].cards.filter((c) => c.board !== 'sideboard')), null) : null);
    const again = await exportWith(job, acc.key as never, t, [item('Opt', 'xln', '65', 1)]);
    expect(again.details.verify).toMatchObject({ ok: false, otherChanged: [expect.objectContaining({ name: 'Opt', board: 'sideboard', outside: true, expected: 1, found: 0 })] });
  });

  it('a new folder: one deck per group, each split its own way, all checked', async () => {
    const { acc, mox, job } = await setup();
    const t: ExportTarget = { accountKey: acc.key, kind: 'newFolder', name: 'By set', parentFolderId: null, visibility: 'private', grouping: { '': 'set', 'set:fin': 'rarity' } };
    const { op, details } = await exportWith(job, acc.key as never, t, GROUPED);
    expect(op.status).toBe('done');
    expect(mox.writes.map((w) => w.op)).toEqual(['createDeckFolder', 'createDeck', 'createDeck', 'createDeck']);
    expect(mox.folders).toEqual([{ id: expect.any(String), path: 'By set' }]);
    expect(mox.decks.map((d) => [d.name, d.folderId === mox.folders[0].id, mainboard(d)])).toEqual([
      ['Bloomburrow', true, ['4 Mabel blb nonFoil']],
      ['Final Fantasy - Rare', true, ['1 Aerith fic nonFoil', '3 Tifa fin nonFoil']],
      ['Final Fantasy - Mythic', true, ['2 Cloud fin nonFoil']],
    ]);
    expect(details.folder).toEqual({ id: mox.folders[0].id, path: 'By set' });
    expect(details.verify).toMatchObject({ ok: true, scope: 'decks', expectedCopies: 10 });
  });

  it('an existing folder: the group whose deck is there gets its cards, the others new decks', async () => {
    const { acc, mox, job } = await setup();
    mox.folders = [{ id: 'fo1', path: 'Collection' }];
    mox.decks = [{ id: 'dk1', publicId: 'pubdeck1', name: 'Bloomburrow', folderId: 'fo1', version: 2, lastUpdatedAt: 't0', cards: [deckCard('Mabel', 'blb', '4', 1)] }];
    const t: ExportTarget = { accountKey: acc.key, kind: 'folder', folderId: 'fo1', visibility: 'private', grouping: { '': 'set' } };
    const { op, details } = await exportWith(job, acc.key as never, t, GROUPED);
    expect(op.status).toBe('done');
    expect(mox.writes.map((w) => w.op)).toEqual(['importDeck', 'createDeck']);
    expect(mainboard(mox.decks[0])).toEqual(['5 Mabel blb nonFoil']);
    expect(mox.decks[1]).toMatchObject({ name: 'Final Fantasy', folderId: 'fo1' });
    expect(details.decks!.map((d) => [d.name, d.created])).toEqual([
      ['Bloomburrow', false],
      ['Final Fantasy', true],
    ]);
    expect(details.verify).toMatchObject({ ok: true });
  });

  it('refuses a deck changed since the preview; a card imported as another print shows in the check', async () => {
    const { acc, mox, job } = await setup();
    mox.decks = [{ id: 'dk9', publicId: 'pubdeck9', name: 'Main', version: 5, lastUpdatedAt: 't0', cards: [] }];
    const t: ExportTarget = { accountKey: acc.key, kind: 'deck', deckId: 'dk9', publicId: 'pubdeck9' };
    const refused = await exportWith(job, acc.key as never, t, TO_DECK, () => (mox.decks[0].lastUpdatedAt = 't1'));
    expect(refused.op.status).toBe('failed');
    expect(refused.op.error).toMatch(/decks or folders changed since the preview/);
    expect(mox.writes).toHaveLength(0);

    mox.misprint = { from: 'Sol Ring', to: { set: 'plst', cn: 'C21-263' } };
    const off = await exportWith(job, acc.key as never, t, TO_DECK);
    expect(off.op.status).toBe('done');
    expect(off.details.verify).toMatchObject({ ok: false, short: [expect.objectContaining({ name: 'Sol Ring', expected: 2, found: 0, deck: 'Main' })] });
    expect(off.details.verify!.extra).toEqual([expect.objectContaining({ set: 'plst', found: 2 })]);
  });

  it('checks the new kinds of targets it is sent', async () => {
    const { acc, job } = await setup();
    const send = (target: unknown) => job.startMany({ items: TO_DECK, sourceAccountKey: null, source: 'x', exports: [{ target: target as ExportTarget, digest: 'd' }] });
    expect(await send({ accountKey: acc.key, kind: 'newFolder', name: 'x', parentFolderId: null, visibility: 'private', grouping: { '': 'name' } })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await send({ accountKey: acc.key, kind: 'deck', deckId: '../x', publicId: 'p' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await send({ accountKey: acc.key, kind: 'newDeck', name: ' ', visibility: 'private', folderId: null })).toMatchObject({ ok: false, code: 'bad_request' });
    // Decks aren't collection cards: a collection replace goes with a deck target on the same account.
    expect(batchIssues([
      { accountKey: acc.key, kind: 'deck', deckId: 'd', publicId: 'p' },
      { accountKey: acc.key, kind: 'deck', deckId: 'd', publicId: 'p' },
      { accountKey: acc.key, kind: 'collection', mode: 'replace' },
    ])).toEqual([{ index: 1, level: 'error', text: 'Target 1 already exports to the same deck.' }]);
    expect(runOrder([
      { accountKey: acc.key, kind: 'newDeck', name: 'a', visibility: 'private', folderId: null },
      { accountKey: acc.key, kind: 'binder', binderId: 'b', mode: 'replace' },
    ])).toEqual([1, 0]);
  });
});
