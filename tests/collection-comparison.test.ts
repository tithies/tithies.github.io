import { compareDecksToCollection, type CompareOptions } from '@/features/collection-comparison/compare';
import {
  DEFAULT_COMPARISON_CONFIG,
  DEFAULT_COMPARISON_STATE,
  parseComparisonConfig,
  parseComparisonState,
} from '@/features/collection-comparison/config';
import { applyComparisonFilters, applyComparisonSort, comparisonFiltersFromParams, writeComparisonParams, DEFAULT_COMPARISON_SORT } from '@/features/collection-comparison/filtering';
import type { DeckCardsRow, DeckRow } from '@/lib/decks/types';
import type { DeckCard } from '@/lib/decks/types';
import type { CardPrint, CollectionEntry, Finish } from '@/lib/cards/types';

const card = (name: string, set: string, cn: string): CardPrint => ({
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
  typeLine: 'Creature',
  isToken: false,
  usd: { nonFoil: null, foil: null, etched: null },
});

const SOL = card('Sol Ring', 'c21', '263');
const SHEOLDRED = card('Sheoldred, the Apocalypse', 'dmu', '107');
const EZURI = card('Ezuri, Claw of Progress', '2x2', '211');
const ISLAND = card('Island', 'dsk', '279');

const dc = (c: CardPrint, qty: number, board = 'mainboard', finish: Finish = 'nonFoil', isProxy = false): DeckCard => ({ board, qty, finish, isProxy, isAlter: false, card: c });
let n = 0;
const entry = (c: CardPrint, qty: number, finish: Finish = 'nonFoil', extra: Partial<CollectionEntry> = {}): CollectionEntry => ({
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
    // Sol Ring in 3 decks, 2 copies owned (LP counts; so does the one whose Language field says French on the English print): 2 match, 1 missing.
    expect(byKey(rows, 'c21|263|nonFoil|en')).toMatchObject({ kind: 'missing', printKey: 'c21|263|nonFoil|en', deckQty: 3, collectionQty: 2, diff: -1, copies: 1 });
    expect(byKey(rows, 'c21|263|nonFoil|en|match')).toMatchObject({ kind: 'match', printKey: 'c21|263|nonFoil|en', deckQty: 3, collectionQty: 2, copies: 2 });
    expect(byKey(rows, 'c21|263|nonFoil|en')!.decks.map((d) => d.deckId).sort()).toEqual(['a', 'b', 'c']);
    expect(byKey(rows, 'c21|263|nonFoil|en')).toMatchObject({ lang: 'en', langs: { en: 1, fr: 1 }, mismatchCopies: 1 });
    // Commanders count; matching prints are match rows (shown only when asked), and nothing else.
    expect(byKey(rows, '2x2|211|nonFoil|en|match')).toMatchObject({ kind: 'match', diff: 0 });
    expect(byKey(rows, '2x2|211|nonFoil|en')).toBeUndefined();
    expect(byKey(rows, 'dsk|279|nonFoil|en|match')).toMatchObject({ kind: 'match', diff: 0 });
    expect(byKey(rows, 'neo|5|nonFoil|en|match')).toMatchObject({ kind: 'match', diff: 0 });
    // Collection-only cards.
    expect(byKey(rows, 'otj|9|nonFoil|en')).toMatchObject({ kind: 'unassigned', deckQty: 0, collectionQty: 3, diff: 3 });
    // Ignored: maybeboard, proxies (both sides), MTGO/Arena rows.
    expect(byKey(rows, 'm21|1|nonFoil|en')).toBeUndefined();
    expect(byKey(rows, 'lea|1|nonFoil|en')).toBeUndefined();
    expect(byKey(rows, 'otj|10|nonFoil|en')).toBeUndefined();
    expect(summary).toMatchObject({ decksIncluded: 3, decksWithoutCards: 0, proxiesSkipped: { decks: 1, collection: 1 }, nonPaperSkipped: 1 });
    // Row keys are unique; every copy is in exactly one kind.
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    const matches = rows.filter((r) => r.kind === 'match');
    const sum = (kind: string) => rows.filter((r) => r.kind === kind).reduce((s, r) => s + r.copies, 0);
    expect(summary.matchedPrints).toBe(matches.length);
    expect(summary.matchedCopies).toBe(sum('match'));
    expect([summary.missingCopies, summary.unassignedCopies]).toEqual([sum('missing'), sum('unassigned')]);
    expect(sum('match') + sum('unassigned')).toBe(summary.collectionCopies);
    expect(sum('match') + sum('missing')).toBe(summary.deckCopies);
    expect(summary.exactPrints).toBe(matches.filter((r) => r.diff === 0).length);
    // Matches neither get nor give likely-wrong-print hints.
    expect(matches.every((r) => r.otherPrints.length === 0)).toBe(true);
  });

  it('flags the other finish of the same print as the likely fix', () => {
    const { rows, summary } = compareDecksToCollection(DECKS, CARDS, COLLECTION, OPTS);
    const foil = byKey(rows, 'dmu|107|foil|en')!;
    const nonFoil = byKey(rows, 'dmu|107|nonFoil|en')!;
    expect(foil).toMatchObject({ kind: 'missing', diff: -1 });
    expect(nonFoil).toMatchObject({ kind: 'unassigned', diff: 1 });
    expect(foil.otherPrints).toEqual([expect.objectContaining({ key: 'dmu|107|nonFoil|en', sameCn: true, diff: 1 })]);
    expect(nonFoil.otherPrints[0]).toMatchObject({ key: 'dmu|107|foil|en', diff: -1 });
    // The hint names the decks using the other print (where to fix it).
    expect(nonFoil.otherPrints[0].decks.map((d) => d.deckId)).toEqual(foil.decks.map((d) => d.deckId));
    expect(nonFoil.otherPrints[0].decks.length).toBeGreaterThan(0);
    expect(summary.hinted).toBe(2);
  });

  it("matches by print, the print's language included", () => {
    const TALISMAN_FR = { ...card('Talisman of Hierarchy', 'mh1', '233'), id: 'Er3VK', lang: 'fr' };
    const TALISMAN_EN = { ...TALISMAN_FR, id: 'en-233', lang: 'en' };
    const decks = [deckRow('a')];
    const deckCards = [cardsRow('a', [dc(TALISMAN_FR, 1), dc(TALISMAN_EN, 1)])];
    // The French print in French matches; the English print the deck uses is owned in French only
    // through a Language field (the copy points to the French print).
    const { rows } = compareDecksToCollection(decks, deckCards, [entry(TALISMAN_FR, 1, 'nonFoil', { lang: 'fr' }), entry(TALISMAN_FR, 1, 'nonFoil', { lang: 'en' })], OPTS);
    expect(byKey(rows, 'mh1|233|nonFoil|fr|match')).toMatchObject({ kind: 'match', lang: 'fr', copies: 1, collectionQty: 2, langs: { fr: 1, en: 1 }, mismatchCopies: 1 });
    expect(byKey(rows, 'mh1|233|nonFoil|fr')).toMatchObject({ kind: 'unassigned', copies: 1 });
    const missing = byKey(rows, 'mh1|233|nonFoil|en')!;
    expect(missing).toMatchObject({ kind: 'missing', lang: 'en', copies: 1 });
    // The other language of the same print is the likely fix.
    expect(missing.otherPrints).toEqual([expect.objectContaining({ key: 'mh1|233|nonFoil|fr', lang: 'fr', sameCn: true, diff: 1 })]);
    // Decks read before the print's language was kept count as English.
    const old = compareDecksToCollection(decks, [cardsRow('a', [dc({ ...TALISMAN_FR, lang: undefined }, 1)])], [], OPTS).rows;
    expect(old.map((r) => r.key)).toEqual(['mh1|233|nonFoil|en']);
  });

  it('applies deck, board and proxy options', () => {
    const noC = compareDecksToCollection(DECKS, CARDS, COLLECTION, { ...OPTS, excludedDeckIds: ['c'] });
    expect(byKey(noC.rows, 'c21|263|nonFoil|en|match')).toMatchObject({ kind: 'match', copies: 2 }); // 2 decks, 2 copies
    expect(byKey(noC.rows, 'c21|263|nonFoil|en')).toBeUndefined();
    expect(noC.summary.decksIncluded).toBe(2);

    const withMaybe = compareDecksToCollection(DECKS, CARDS, COLLECTION, { ...OPTS, ignoredBoards: [] });
    expect(byKey(withMaybe.rows, 'm21|1|nonFoil|en')).toMatchObject({ kind: 'missing', diff: -1 });

    const noSide = compareDecksToCollection(DECKS, CARDS, COLLECTION, { ...OPTS, ignoredBoards: ['maybeboard', 'sideboard'] });
    expect(byKey(noSide.rows, 'neo|5|nonFoil|en')).toMatchObject({ kind: 'unassigned', diff: 2 });

    const proxies = compareDecksToCollection(DECKS, CARDS, COLLECTION, { ...OPTS, ignoreProxies: false });
    expect(byKey(proxies.rows, 'lea|1|nonFoil|en|match')).toMatchObject({ kind: 'match', copies: 1 }); // 1 proxy in a deck, 1 proxy owned
    expect(proxies.summary.proxiesSkipped).toEqual({ decks: 0, collection: 0 });
  });

  it('counts each collection row once and reports decks without cards', () => {
    const dup = entry(card('Binder only', 'otj', '9'), 3);
    const { rows, summary } = compareDecksToCollection([...DECKS, deckRow('unread')], CARDS, [...COLLECTION, dup, dup], OPTS);
    expect(byKey(rows, 'otj|9|nonFoil|en')!.collectionQty).toBe(6);
    expect(summary.decksWithoutCards).toBe(1);
  });
});

describe('Comparator config and filters', () => {
  it('defaults and repairs stored config field by field', () => {
    expect(DEFAULT_COMPARISON_CONFIG).toEqual({ showMissing: true, showUnassigned: false, showMatched: false, ignoreProxies: true, ignoredBoards: ['maybeboard'], excludedDeckIds: [] });
    expect(parseComparisonConfig({ showMissing: false, ignoredBoards: 'oops', excludedDeckIds: ['a'] })).toEqual({
      ...DEFAULT_COMPARISON_CONFIG,
      showMissing: false,
      excludedDeckIds: ['a'],
    });
    expect(parseComparisonConfig(null)).toEqual(DEFAULT_COMPARISON_CONFIG);
  });

  it('filters, sorts and round-trips through the URL', () => {
    const rows = compareDecksToCollection(DECKS, CARDS, COLLECTION, OPTS).rows.filter((r) => r.kind !== 'match');
    const f = { q: 'deck b', sets: [], finishes: [], languages: [], hinted: false };
    expect(applyComparisonFilters(rows, f, (id) => `Deck ${id}`).map((r) => r.name)).toEqual(['Sol Ring']);
    expect(applyComparisonFilters(rows, { ...f, q: '', hinted: true }, String).map((r) => r.key).sort()).toEqual(['dmu|107|foil|en', 'dmu|107|nonFoil|en']);
    expect(applyComparisonSort(rows, { key: 'diff', dir: 'asc' })[0].diff).toBeLessThan(0);
    // By first deck name; rows used by no deck come first ascending, last descending.
    const names: Record<string, string> = { a: 'Zombies', b: 'Angels', c: 'Merfolk' };
    const deckName = (id: string) => names[id];
    const first = (dir: 'asc' | 'desc') => applyComparisonSort(rows, { key: 'decks', dir }, deckName).map((r) => (r.decks[0] ? deckName(r.decks[0].deckId) : '-'));
    const asc = first('asc');
    expect(asc).toEqual([...asc].sort((x, y) => (x === '-' ? -1 : y === '-' ? 1 : x.localeCompare(y))));
    expect(asc[0]).toBe('-');
    expect(asc.at(-1)).toBe('Zombies');
    expect(first('desc')[0]).toBe('Zombies');
    expect(first('desc').at(-1)).toBe('-');
    const params = writeComparisonParams(new URLSearchParams('x=1'), { q: 'sol', sets: ['c21'], finishes: [], languages: ['fr'], hinted: true }, DEFAULT_COMPARISON_SORT, 2);
    expect(params.toString()).toBe('x=1&q=sol&sets=c21&lang=fr&hint=1&page=2');
    expect(comparisonFiltersFromParams(params)).toEqual({ q: 'sol', sets: ['c21'], finishes: [], languages: ['fr'], hinted: true });
    expect(applyComparisonFilters(rows, { ...f, q: '', languages: ['fr'] }, String)).toEqual([]);
  });
});

describe('Comparator options', () => {
  it('repairs stored state field by field, and ignores the presets of before', () => {
    const s = parseComparisonState({ current: { showMissing: false, ignoredBoards: 7 }, presets: [{ id: 'a', name: 'A', config: {} }], loadedPresetId: 'a' });
    expect(s).toEqual({ current: { ...DEFAULT_COMPARISON_CONFIG, showMissing: false } });
    expect(parseComparisonState(undefined)).toEqual(DEFAULT_COMPARISON_STATE);
    expect(parseComparisonConfig('junk')).toEqual(DEFAULT_COMPARISON_CONFIG);
  });
});

describe('Comparator rows as export items', () => {
  it('exports the difference, or for a match its copies', async () => {
    const { exportQty, rowToItems } = await import('@/features/collection-comparison/export');
    const rowToItem = (r: (typeof rows)[number]) => rowToItems(r)[0];
    const { rows } = compareDecksToCollection(DECKS, CARDS, COLLECTION, OPTS);
    const missing = byKey(rows, 'c21|263|nonFoil|en')!;
    const unassigned = byKey(rows, 'otj|9|nonFoil|en')!;
    const match = byKey(rows, 'dsk|279|nonFoil|en|match')!;
    expect([exportQty(missing), exportQty(unassigned)]).toEqual([1, 3]);
    expect(exportQty(match)).toBe(match.deckQty);
    expect(match.deckQty).toBeGreaterThan(0);
    expect(rowToItems(match)).toMatchObject([{ key: 'dsk|279|nonFoil|en|match', lang: 'en', qty: match.collectionQty, note: 'Matching' }]);
    // Both rows of a partly matching print go into the export as one print with every copy.
    const { mergeItems } = await import('@/lib/export/plan');
    const sol = rows.filter((r) => r.printKey === 'c21|263|nonFoil|en' && r.kind === 'missing').flatMap(rowToItems);
    const solMatch = rowToItems(byKey(rows, 'c21|263|nonFoil|en|match')!);
    // The match covers both owned copies: one per Language field, exactly (nothing guessed).
    expect(solMatch.map((i) => [i.key, i.lang, i.qty])).toEqual([
      ['c21|263|nonFoil|en|match|en', 'en', 1],
      ['c21|263|nonFoil|en|match|fr', 'fr', 1],
    ]);
    expect(solMatch[0].note).not.toMatch(/guessed/);
    expect(sol).toMatchObject([{ lang: 'en', qty: 1 }]);
    expect(mergeItems([...sol, ...solMatch]).map((i) => [i.key, i.qty])).toEqual([
      ['c21|263|nonFoil|en', 2],
      ['c21|263|nonFoil|fr', 1],
    ]);
  });

  it("keeps each copy's Language field, and guesses which ones decks use when it can't tell", async () => {
    const { rowToItems } = await import('@/features/collection-comparison/export');
    const SWORDS_FR = { ...card('Swords to Plowshares', 'fbb', '41'), lang: 'fr' };
    // 3 copies of the French print: Language French ×1, English ×2 (left on Moxfield's default); a deck uses 1.
    const coll = [entry(SWORDS_FR, 1, 'nonFoil', { lang: 'fr' }), entry(SWORDS_FR, 2, 'nonFoil', { lang: 'en' })];
    const { rows } = compareDecksToCollection([deckRow('a')], [cardsRow('a', [dc(SWORDS_FR, 1)])], coll, OPTS);
    // Decks are assumed to use the copies in the print's language first.
    expect(rowToItems(byKey(rows, 'fbb|41|nonFoil|fr|match')!)).toMatchObject([{ lang: 'fr', qty: 1 }]);
    const rest = rowToItems(byKey(rows, 'fbb|41|nonFoil|fr')!);
    expect(rest).toMatchObject([{ key: 'fbb|41|nonFoil|fr', lang: 'en', qty: 2 }]);
    // Deck-only copies are in the print's language.
    const { rows: missing } = compareDecksToCollection([deckRow('a')], [cardsRow('a', [dc(SWORDS_FR, 2)])], [], OPTS);
    expect(rowToItems(missing[0])).toMatchObject([{ lang: 'fr', qty: 2, note: 'Missing from collection' }]);
    // Two Language fields left over: one item each, marked as a guess.
    const mixed = [...coll, entry(SWORDS_FR, 1, 'nonFoil', { lang: 'de' })];
    const split = rowToItems(byKey(compareDecksToCollection([deckRow('a')], [cardsRow('a', [dc(SWORDS_FR, 1)])], mixed, OPTS).rows, 'fbb|41|nonFoil|fr')!);
    expect(split.map((i) => [i.key, i.lang, i.qty])).toEqual([
      ['fbb|41|nonFoil|fr|en', 'en', 2],
      ['fbb|41|nonFoil|fr|de', 'de', 1],
    ]);
    expect(split[0].note).toMatch(/guessed/);
  });
});
