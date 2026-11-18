import type { CollectionEntry } from '@/lib/cards/types';
import { CHANGE_OVERLAP_MS, FULL_READ_EVERY_MS, MAX_CHANGE_PAGES, readCollection, readCollectionChanges, refreshCollection } from '@/lib/decks/collection';
import { newAccount, resetDb } from './helpers';

const SITE = { collectionPageSize: 2 };
const DAY = 24 * 3600_000;
const T0 = Date.parse('2026-11-01T00:00:00Z');
const iso = (t: number) => new Date(t).toISOString();

const entry = (id: string, qty: number, at: number): CollectionEntry => ({
  id,
  qty,
  condition: 'nearMint',
  finish: 'nonFoil',
  lang: 'en',
  isProxy: false,
  isAlter: false,
  game: 'paper',
  updatedAt: iso(at),
  card: { id: `c-${id}`, scryfallId: '', set: 'set', setName: 'Set', setType: 'expansion', name: id, faces: [id], flavorName: '', cn: id, lang: 'en', rarity: 'common', typeLine: '', isToken: false, usd: { nonFoil: null, foil: null, etched: null } },
});

/** A fake Moxfield collection: pages by name, or most recently changed first; counts what was asked. */
function fakeMox(rows: CollectionEntry[]) {
  const asked: string[] = [];
  return {
    asked,
    rows,
    collectionPage: async (page: number, size: number, opts: { newestFirst?: boolean } = {}) => {
      asked.push(`${opts.newestFirst ? 'new' : 'name'}:${page}`);
      const sorted = [...rows].sort((a, b) => (opts.newestFirst ? b.updatedAt!.localeCompare(a.updatedAt!) : a.id.localeCompare(b.id)));
      return {
        entries: sorted.slice((page - 1) * size, page * size),
        totalResults: rows.length,
        totalPages: Math.max(1, Math.ceil(rows.length / size)),
        pageSize: size,
        totalCopies: rows.reduce((s, e) => s + e.qty, 0),
      };
    },
  };
}

describe('Collection reads: only what changed', () => {
  // Entries changed 10 minutes apart (more than the overlap that is read again).
  const GAP = 2 * CHANGE_OVERLAP_MS;
  const base = [entry('a', 1, T0), entry('b', 2, T0 + GAP), entry('c', 1, T0 + 2 * GAP), entry('d', 4, T0 + 3 * GAP), entry('e', 1, T0 + 4 * GAP)];

  it('reads newest-first pages until the snapshot, and merges the changes', async () => {
    const later = T0 + DAY;
    const mox = fakeMox([...base.filter((e) => e.id !== 'b'), entry('b', 5, later), entry('f', 1, later + 1)]);
    const r = await readCollectionChanges(SITE, mox, base);
    expect(r).toMatchObject({ mode: 'changes', changed: 2 });
    expect(mox.asked).toEqual(['new:1', 'new:2']); // page 2 starts with entries older than the snapshot
    if (r.mode !== 'changes') throw new Error();
    expect(r.entries.map((e) => [e.id, e.qty]).sort()).toEqual([
      ['a', 1],
      ['b', 5],
      ['c', 1],
      ['d', 4],
      ['e', 1],
      ['f', 1],
    ]);
  });

  it('one request when nothing changed; entries within the overlap are read again but not counted', async () => {
    const quiet = fakeMox(base);
    expect(await readCollectionChanges(SITE, quiet, base)).toMatchObject({ mode: 'changes', pages: 1, changed: 0 });
    expect(quiet.asked).toEqual(['new:1']);
    // Changes made seconds apart are all read again (same-time changes are never missed).
    const close = base.map((e, i) => entry(e.id, e.qty, T0 + i * 1000));
    expect(await readCollectionChanges(SITE, fakeMox(close.map((e) => (e.id === 'a' ? { ...e, qty: 9 } : e))), close)).toMatchObject({ mode: 'changes', changed: 1 });
  });

  it("can't tell about deletions, copies changed without a newer time, or old snapshots: every page is read", async () => {
    const deleted = fakeMox(base.slice(1));
    expect(await readCollectionChanges(SITE, deleted, base)).toMatchObject({ mode: 'none', why: expect.stringMatching(/deleted/) });
    const r = await readCollection(SITE, deleted, base);
    expect(r).toMatchObject({ mode: 'full', why: expect.stringMatching(/deleted/) });
    expect(r.entries.map((e) => e.id)).toEqual(['b', 'c', 'd', 'e']);

    const silent = fakeMox(base.map((e) => (e.id === 'a' ? { ...e, qty: 9 } : e)));
    expect(await readCollectionChanges(SITE, silent, base)).toMatchObject({ mode: 'none', why: expect.stringMatching(/copies/) });

    const old = base.map(({ updatedAt: _u, ...e }) => e);
    expect(await readCollectionChanges(SITE, fakeMox(base), old)).toMatchObject({ mode: 'none', why: expect.stringMatching(/no change times/) });
    // Read before Tithies kept the print's language: every page once, to learn it.
    const noLang = base.map((e) => ({ ...e, card: { ...e.card, lang: undefined } }));
    expect(await readCollectionChanges(SITE, fakeMox(base), noLang)).toMatchObject({ mode: 'none', why: expect.stringMatching(/no print languages/) });
  });

  it('too many changes: every page instead', async () => {
    const many = Array.from({ length: SITE.collectionPageSize * (MAX_CHANGE_PAGES + 2) }, (_, i) => entry(`n${i}`, 1, T0 + DAY + i));
    const mox = fakeMox([...base, ...many]);
    expect(await readCollectionChanges(SITE, mox, base)).toMatchObject({ mode: 'none', why: expect.stringMatching(/more than/) });
  });
});

describe('Collection snapshot refresh', () => {
  beforeEach(resetDb);

  it('every page the first time, then only changes, every page again after a week or when asked', async () => {
    const acc = await newAccount('111111', 'alice');
    const rows = [entry('a', 1, T0), entry('b', 1, T0 + 1)];
    const mox = fakeMox(rows);
    let now = T0 + DAY;
    const clock = () => now;

    let meta = await refreshCollection(SITE, acc.data, mox, { now: clock });
    expect(meta).toMatchObject({ entries: 2, fullReadAt: now, lastRead: { mode: 'full' } });

    now += DAY;
    mox.rows.push(entry('c', 3, now - 1000));
    meta = await refreshCollection(SITE, acc.data, mox, { now: clock });
    expect(meta).toMatchObject({ entries: 3, copies: 5, fullReadAt: T0 + DAY, lastRead: { mode: 'changes', changed: 1, pages: 2 } });
    expect((await acc.data.collection.list()).map((e) => e.id).sort()).toEqual(['a', 'b', 'c']);

    meta = await refreshCollection(SITE, acc.data, mox, { now: clock, full: true });
    expect(meta.lastRead).toMatchObject({ mode: 'full', why: 'asked for' });

    now += FULL_READ_EVERY_MS + 1;
    meta = await refreshCollection(SITE, acc.data, mox, { now: clock });
    expect(meta).toMatchObject({ fullReadAt: now, lastRead: { mode: 'full', why: 'a week since the last one' } });
  });
});
