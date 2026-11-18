import type { CompareOptions } from '@/features/collection-comparison/compare';
import { DEFAULT_SELLING_DECK_FILTER, parseSellingDeckFilter } from '@/features/f2f-buylist/deck-filter';
import { freeCopies } from '@/features/f2f-buylist/in-decks';
import type { Item } from '@/features/f2f-buylist/types';
import { copyKey } from '@/lib/cards/prints';
import type { CardPrint, CollectionEntry, Finish } from '@/lib/cards/types';
import type { DeckCard, DeckCardsRow, DeckRow } from '@/lib/decks/types';

const card = (name: string, set: string, cn: string, lang = 'en'): CardPrint => ({
  id: `${set}-${cn}-${lang}`,
  scryfallId: '',
  set,
  setName: set.toUpperCase(),
  setType: 'expansion',
  name,
  faces: [name],
  flavorName: '',
  cn,
  lang,
  rarity: 'rare',
  typeLine: 'Creature',
  isToken: false,
  usd: { nonFoil: null, foil: null, etched: null },
});

const BOLT = card('Lightning Bolt', 'm10', '146');
const SOL = card('Sol Ring', 'c21', '263');
const SHEOLDRED = card('Sheoldred, the Apocalypse', 'dmu', '107');
const TALISMAN_FR = card('Talisman of Hierarchy', 'mh1', '233', 'fr');

const dc = (c: CardPrint, qty: number, board = 'mainboard', finish: Finish = 'nonFoil', isProxy = false): DeckCard => ({ board, qty, finish, isProxy, isAlter: false, card: c });
let n = 0;
const entry = (c: CardPrint, qty: number, extra: Partial<CollectionEntry> = {}): CollectionEntry => ({
  id: `e${n++}`,
  qty,
  condition: 'nearMint',
  finish: 'nonFoil',
  lang: c.lang ?? 'en',
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

/** A run row of `c`'s copies (keyed like the runner: by the copies' Language field). */
const item = (c: CardPrint, qty: number, p: Partial<Item> = {}): Item =>
  ({
    runId: 1,
    accountKey: 'moxfield:1',
    key: copyKey(c.set, c.cn, p.finish ?? 'nonFoil', p.lang ?? c.lang),
    status: 'done',
    name: c.name,
    frontName: c.name,
    faces: c.faces,
    set: c.set,
    setName: c.setName,
    setType: c.setType,
    cn: c.cn,
    finish: 'nonFoil',
    lang: c.lang,
    rarity: c.rarity,
    typeLine: c.typeLine,
    isToken: false,
    qty,
    conditions: {},
    alters: 0,
    scryfallId: '',
    marketUsd: null,
    category: 'buylist',
    buyCash: 1,
    updatedAt: 0,
    ...p,
  }) as Item;

const OPTS: Pick<CompareOptions, 'excludedDeckIds' | 'ignoredBoards'> = { excludedDeckIds: [], ignoredBoards: ['maybeboard'] };
const DECKS = [deckRow('a'), deckRow('b')];
const qtyOf = (items: Item[], c: CardPrint) => items.find((i) => i.name === c.name)?.qty ?? 0;

describe('freeCopies', () => {
  it('keeps the free copies of a print decks use, and leaves out prints decks use entirely', () => {
    const items = [item(BOLT, 3), item(SOL, 1), item(SHEOLDRED, 2)];
    const collection = [entry(BOLT, 3), entry(SOL, 1), entry(SHEOLDRED, 2)];
    const cards = [cardsRow('a', [dc(BOLT, 1), dc(SOL, 1)]), cardsRow('b', [dc(BOLT, 1, 'sideboard')])];
    const r = freeCopies(items, DECKS, cards, collection, OPTS);

    expect(qtyOf(r.items, BOLT)).toBe(1);
    expect(qtyOf(r.items, SOL)).toBe(0);
    expect(r.items.find((i) => i.name === SHEOLDRED.name)).toBe(items[2]); // untouched
    expect(r.items.map((i) => i.name)).toEqual([BOLT.name, SHEOLDRED.name]);
    expect(r.usage.get(items[0].key)).toEqual({
      runQty: 3,
      inDecks: 2,
      decks: [
        { deckId: 'a', board: 'mainboard', qty: 1 },
        { deckId: 'b', board: 'sideboard', qty: 1 },
      ],
    });
    expect(r.usage.has(items[2].key)).toBe(false);
    expect(r.summary).toMatchObject({ hiddenPrints: 1, reducedPrints: 1, hiddenCopies: 3, decksIncluded: 2, decksWithoutCards: 0, withCollection: true });
  });

  it('applies the deck and board options, and never counts deck proxies', () => {
    const items = [item(BOLT, 4)];
    const collection = [entry(BOLT, 4)];
    const cards = [cardsRow('a', [dc(BOLT, 1), dc(BOLT, 1, 'maybeboard'), dc(BOLT, 1, 'mainboard', 'nonFoil', true)]), cardsRow('b', [dc(BOLT, 1)])];

    expect(qtyOf(freeCopies(items, DECKS, cards, collection, OPTS).items, BOLT)).toBe(2);
    expect(qtyOf(freeCopies(items, DECKS, cards, collection, { ...OPTS, excludedDeckIds: ['b'] }).items, BOLT)).toBe(3);
    expect(qtyOf(freeCopies(items, DECKS, cards, collection, { ...OPTS, ignoredBoards: [] }).items, BOLT)).toBe(1);
  });

  it('compares exact prints: another finish or language is not the same card', () => {
    const items = [item(BOLT, 1), item(TALISMAN_FR, 1)];
    const collection = [entry(BOLT, 1), entry(TALISMAN_FR, 1)];
    const cards = [cardsRow('a', [dc(BOLT, 1, 'mainboard', 'foil'), dc(card('Talisman of Hierarchy', 'mh1', '233'), 1)])];
    const r = freeCopies(items, DECKS, cards, collection, OPTS);
    expect(r.items).toEqual(items);
    expect(r.summary.hiddenCopies).toBe(0);
  });

  it("counts the whole collection: a deck's copy may be one the run doesn't hold", () => {
    // 2 Bolts owned: one in the binder the run was read from, one in a deck.
    const items = [item(BOLT, 1)];
    const cards = [cardsRow('a', [dc(BOLT, 1)])];
    expect(qtyOf(freeCopies(items, DECKS, cards, [entry(BOLT, 2)], OPTS).items, BOLT)).toBe(1);
    // With no collection snapshot, only the run's copies are known.
    const r = freeCopies(items, DECKS, cards, [], OPTS);
    expect(qtyOf(r.items, BOLT)).toBe(0);
    expect(r.summary.withCollection).toBe(false);
    // A snapshot older than the run (fewer copies) doesn't hide copies the run has.
    expect(qtyOf(freeCopies([item(BOLT, 3)], DECKS, cards, [entry(BOLT, 1)], OPTS).items, BOLT)).toBe(2);
    // Proxies, MTGO and Arena copies of the snapshot aren't copies to sell.
    expect(qtyOf(freeCopies(items, DECKS, cards, [entry(BOLT, 1), entry(BOLT, 1, { isProxy: true }), entry(BOLT, 1, { game: 'arena' })], OPTS).items, BOLT)).toBe(0);
  });

  it("matches copies by their print's language, without counting a free copy twice", () => {
    // Two rows of the same English print: copies marked English, and copies marked French
    // (their print is English: a mismatch). One English copy is free.
    const en = item(BOLT, 1);
    const fr = item(BOLT, 2, { lang: 'fr', mismatchCopies: 2, printLang: 'en' });
    const collection = [entry(BOLT, 1), entry(BOLT, 2, { lang: 'fr' })];
    const cards = [cardsRow('a', [dc(BOLT, 2)])];
    const r = freeCopies([en, fr], DECKS, cards, collection, OPTS);
    // The copy whose Language field matches is kept first.
    expect(r.items.map((i) => [i.lang, i.qty])).toEqual([['en', 1]]);
    expect(r.summary).toMatchObject({ hiddenPrints: 1, hiddenCopies: 2 });

    // A row partly mismatched keeps the warning only for the copies still shown.
    const mixed = item(BOLT, 3, { mismatchCopies: 1, printLang: 'fr' });
    const frCards = [cardsRow('a', [dc(card('Lightning Bolt', 'm10', '146', 'fr'), 1)])];
    const kept = freeCopies([mixed], DECKS, frCards, [entry(BOLT, 2), entry(card('Lightning Bolt', 'm10', '146', 'fr'), 1, { lang: 'en' })], OPTS).items[0];
    expect(kept.qty).toBe(2);
    expect(kept.mismatchCopies).toBeUndefined();
    expect(kept.printLang).toBeUndefined();
  });

  it('reports decks not read yet', () => {
    const r = freeCopies([item(BOLT, 1)], [...DECKS, { ...deckRow('c'), cardsUpdatedAt: undefined }], [cardsRow('a', [])], [], OPTS);
    expect(r.summary).toMatchObject({ decksIncluded: 3, decksWithoutCards: 2 });
  });
});

describe('Selling "Cards in decks" options', () => {
  it('defaults to off, and repairs stored options field by field', () => {
    expect(DEFAULT_SELLING_DECK_FILTER).toEqual({ enabled: false, ignoredBoards: ['maybeboard'], excludedDeckIds: [] });
    expect(parseSellingDeckFilter(null)).toEqual(DEFAULT_SELLING_DECK_FILTER);
    // Options of before are dropped (deck proxies never count now).
    expect(parseSellingDeckFilter({ enabled: true, ignoredBoards: 'x', excludedDeckIds: ['d1'], ignoreProxies: false })).toEqual({
      enabled: true,
      ignoredBoards: ['maybeboard'],
      excludedDeckIds: ['d1'],
    });
  });
});
