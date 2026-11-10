import { compareDecksToCollection, type CompareOptions } from '@/features/deck-mismatch/compare';
import { DEFAULT_MISMATCH_CONFIG, parseMismatchConfig } from '@/features/deck-mismatch/config';
import { applyMismatchFilters, applyMismatchSort, mismatchFiltersFromParams, writeMismatchParams, DEFAULT_MISMATCH_SORT } from '@/features/deck-mismatch/filtering';
import type { DeckCardsRow, DeckRow } from '@/lib/decks/types';
import type { DeckCard } from '@/lib/moxfield/decks';
import type { MoxCard, MoxEntry, MoxFinish } from '@/lib/moxfield/normalize';

const card = (name: string, set: string, cn: string): MoxCard => ({
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
  typeLine: 'Creature',
  isToken: false,
  usd: { nonFoil: null, foil: null, etched: null },
});

const SOL = card('Sol Ring', 'c21', '263');
const SHEOLDRED = card('Sheoldred, the Apocalypse', 'dmu', '107');
const EZURI = card('Ezuri, Claw of Progress', '2x2', '211');
const ISLAND = card('Island', 'dsk', '279');

const dc = (c: MoxCard, qty: number, board = 'mainboard', finish: MoxFinish = 'nonFoil', isProxy = false): DeckCard => ({ board, qty, finish, isProxy, isAlter: false, card: c });
let n = 0;
const entry = (c: MoxCard, qty: number, finish: MoxFinish = 'nonFoil', extra: Partial<MoxEntry> = {}): MoxEntry => ({
  id: `e${n++}`,
  qty,
  condition: 'nearMint',
  finish,
  lang: 'en',
  isProxy: false,
  isAlter: false,
  game: 'paper',
  card: c,
  ...extra,
});

const deckRow = (id: string): DeckRow => ({
  id,
  publicId: `pub-${id}`,
  name: `Deck ${id}`,
  format: 'commander',
  visibility: 'unlisted',
  folderPath: '',
  lastUpdatedAt: 'x',
  createdAt: 'x',
  mainboardCount: 0,
  sideboardCount: 0,
  maybeboardCount: 0,
  commanders: [],
  publicUrl: '',
  firstSeenAt: 0,
  isNew: false,
  cardsUpdatedAt: 'x',
});
const cardsRow = (deckId: string, cards: DeckCard[]): DeckCardsRow => ({ deckId, v: 1, updatedAt: 'x', fetchedAt: 0, cards });

const OPTS: CompareOptions = { excludedDeckIds: [], ignoredBoards: ['maybeboard'], ignoreProxies: true };

const DECKS = [deckRow('a'), deckRow('b'), deckRow('c')];
const CARDS = [
  cardsRow('a', [dc(EZURI, 1, 'commanders'), dc(SOL, 1), dc(ISLAND, 9), dc(SHEOLDRED, 1, 'mainboard', 'foil'), dc(card('Maybe', 'm21', '1'), 1, 'maybeboard')]),
  cardsRow('b', [dc(SOL, 1), dc(card('Proxy card', 'lea', '1'), 1, 'mainboard', 'nonFoil', true), dc(card('Side card', 'neo', '5'), 2, 'sideboard')]),
  cardsRow('c', [dc(SOL, 1)]),
];
const COLLECTION = [
  entry(EZURI, 1),
  entry(SOL, 1, 'nonFoil', { lang: 'fr' }),
  entry(SOL, 1, 'nonFoil', { condition: 'lightlyPlayed' }),
  entry(ISLAND, 9),
  entry(SHEOLDRED, 1, 'nonFoil'), // owned as non-foil, deck says foil
  entry(card('Side card', 'neo', '5'), 2),
  entry(card('Binder only', 'otj', '9'), 3),
  entry(card('Proxy card', 'lea', '1'), 1, 'nonFoil', { isProxy: true }),
  entry(card('Arena card', 'otj', '10'), 1, 'nonFoil', { game: 'arena' }),
];

const byKey = <T extends { key: string }>(rows: T[], key: string) => rows.find((r) => r.key === key);

describe('compareDecksToCollection', () => {
  it('sums copies across decks and compares exact prints', () => {
    const { rows, summary } = compareDecksToCollection(DECKS, CARDS, COLLECTION, OPTS);
    // Sol Ring in 3 decks, 2 copies owned (French + LP still count).
    expect(byKey(rows, 'c21|263|nonFoil')).toMatchObject({ kind: 'missing', deckQty: 3, collectionQty: 2, diff: -1 });
    expect(byKey(rows, 'c21|263|nonFoil')!.decks.map((d) => d.deckId).sort()).toEqual(['a', 'b', 'c']);
    // Commanders count; matching prints produce no row.
    expect(byKey(rows, '2x2|211|nonFoil')).toBeUndefined();
    expect(byKey(rows, 'dsk|279|nonFoil')).toBeUndefined();
    expect(byKey(rows, 'neo|5|nonFoil')).toBeUndefined();
    // Collection-only cards.
    expect(byKey(rows, 'otj|9|nonFoil')).toMatchObject({ kind: 'unassigned', deckQty: 0, collectionQty: 3, diff: 3 });
    // Ignored: maybeboard, proxies (both sides), MTGO/Arena rows.
    expect(byKey(rows, 'm21|1|nonFoil')).toBeUndefined();
    expect(byKey(rows, 'lea|1|nonFoil')).toBeUndefined();
    expect(byKey(rows, 'otj|10|nonFoil')).toBeUndefined();
    expect(summary).toMatchObject({ decksIncluded: 3, decksWithoutCards: 0, proxiesSkipped: { decks: 1, collection: 1 }, nonPaperSkipped: 1 });
    expect(rows.every((r) => r.diff !== 0)).toBe(true);
  });

  it('flags the other finish of the same print as the likely fix', () => {
    const { rows, summary } = compareDecksToCollection(DECKS, CARDS, COLLECTION, OPTS);
    const foil = byKey(rows, 'dmu|107|foil')!;
    const nonFoil = byKey(rows, 'dmu|107|nonFoil')!;
    expect(foil).toMatchObject({ kind: 'missing', diff: -1 });
    expect(nonFoil).toMatchObject({ kind: 'unassigned', diff: 1 });
    expect(foil.otherPrints).toEqual([expect.objectContaining({ key: 'dmu|107|nonFoil', sameCn: true, diff: 1 })]);
    expect(nonFoil.otherPrints[0]).toMatchObject({ key: 'dmu|107|foil', diff: -1 });
    expect(summary.hinted).toBe(2);
  });

  it('applies deck, board and proxy options', () => {
    const noC = compareDecksToCollection(DECKS, CARDS, COLLECTION, { ...OPTS, excludedDeckIds: ['c'] });
    expect(byKey(noC.rows, 'c21|263|nonFoil')).toBeUndefined(); // 2 decks, 2 copies
    expect(noC.summary.decksIncluded).toBe(2);

    const withMaybe = compareDecksToCollection(DECKS, CARDS, COLLECTION, { ...OPTS, ignoredBoards: [] });
    expect(byKey(withMaybe.rows, 'm21|1|nonFoil')).toMatchObject({ kind: 'missing', diff: -1 });

    const noSide = compareDecksToCollection(DECKS, CARDS, COLLECTION, { ...OPTS, ignoredBoards: ['maybeboard', 'sideboard'] });
    expect(byKey(noSide.rows, 'neo|5|nonFoil')).toMatchObject({ kind: 'unassigned', diff: 2 });

    const proxies = compareDecksToCollection(DECKS, CARDS, COLLECTION, { ...OPTS, ignoreProxies: false });
    expect(byKey(proxies.rows, 'lea|1|nonFoil')).toBeUndefined(); // 1 proxy in a deck, 1 proxy owned
    expect(proxies.summary.proxiesSkipped).toEqual({ decks: 0, collection: 0 });
  });

  it('counts each collection row once and reports decks without cards', () => {
    const dup = entry(card('Binder only', 'otj', '9'), 3);
    const { rows, summary } = compareDecksToCollection([...DECKS, deckRow('unread')], CARDS, [...COLLECTION, dup, dup], OPTS);
    expect(byKey(rows, 'otj|9|nonFoil')!.collectionQty).toBe(6);
    expect(summary.decksWithoutCards).toBe(1);
  });
});

describe('Mismatch config and filters', () => {
  it('defaults and repairs stored config field by field', () => {
    expect(DEFAULT_MISMATCH_CONFIG).toEqual({ showMissing: true, showUnassigned: false, ignoreProxies: true, ignoredBoards: ['maybeboard'], excludedDeckIds: [] });
    expect(parseMismatchConfig({ showMissing: false, ignoredBoards: 'oops', excludedDeckIds: ['a'] })).toEqual({
      ...DEFAULT_MISMATCH_CONFIG,
      showMissing: false,
      excludedDeckIds: ['a'],
    });
    expect(parseMismatchConfig(null)).toEqual(DEFAULT_MISMATCH_CONFIG);
  });

  it('filters, sorts and round-trips through the URL', () => {
    const { rows } = compareDecksToCollection(DECKS, CARDS, COLLECTION, OPTS);
    const f = { q: 'deck b', sets: [], finishes: [], hinted: false };
    expect(applyMismatchFilters(rows, f, (id) => `Deck ${id}`).map((r) => r.name)).toEqual(['Sol Ring']);
    expect(applyMismatchFilters(rows, { ...f, q: '', hinted: true }, String).map((r) => r.key).sort()).toEqual(['dmu|107|foil', 'dmu|107|nonFoil']);
    expect(applyMismatchSort(rows, { key: 'diff', dir: 'asc' })[0].diff).toBeLessThan(0);
    // By first deck name; rows used by no deck come first ascending, last descending.
    const names: Record<string, string> = { a: 'Zombies', b: 'Angels', c: 'Merfolk' };
    const deckName = (id: string) => names[id];
    const first = (dir: 'asc' | 'desc') => applyMismatchSort(rows, { key: 'decks', dir }, deckName).map((r) => (r.decks[0] ? deckName(r.decks[0].deckId) : '-'));
    const asc = first('asc');
    expect(asc).toEqual([...asc].sort((x, y) => (x === '-' ? -1 : y === '-' ? 1 : x.localeCompare(y))));
    expect(asc[0]).toBe('-');
    expect(asc.at(-1)).toBe('Zombies');
    expect(first('desc')[0]).toBe('Zombies');
    expect(first('desc').at(-1)).toBe('-');
    const params = writeMismatchParams(new URLSearchParams('x=1'), { q: 'sol', sets: ['c21'], finishes: [], hinted: true }, DEFAULT_MISMATCH_SORT, 2);
    expect(params.toString()).toBe('x=1&q=sol&sets=c21&hint=1&page=2');
    expect(mismatchFiltersFromParams(params)).toEqual({ q: 'sol', sets: ['c21'], finishes: [], hinted: true });
  });
});
