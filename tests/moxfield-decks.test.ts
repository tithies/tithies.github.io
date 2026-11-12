import { requestUrl, runMoxRequest, wholeCollectionUrl } from '@/lib/sites/moxfield/api';
import { MAX_COLLECTION_PAGE_SIZE } from '@/lib/sites/moxfield/constants';
import { boardLabel, normalizeDeckCards, normalizeDeckList } from '@/lib/sites/moxfield/decks';
import { printKey } from '@/lib/cards/prints';
import { normalizeEntry } from '@/lib/sites/moxfield/normalize';
import { fixture } from './helpers';

const list = fixture<any>('moxfield-decks.json');
const deck = fixture<any>('moxfield-deck.json');
const page = fixture<{ data: any[] }>('moxfield-page.json');

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Moxfield deck normalisation', () => {
  it('reads deck summaries', () => {
    const decks = normalizeDeckList(list);
    expect(decks).toHaveLength(7);
    const ff = decks.find((d) => d.folderPath === 'Collection/Final Fantasy')!;
    expect(ff).toMatchObject({ id: 'deck01', publicId: 'TestDeck01Public_BBBBBB', visibility: 'private', format: 'none' });
    expect(ff.lastUpdatedAt).toBe(list.decks[1].lastUpdatedAtUtc);
    // No folder → ''.
    expect(decks.find((d) => d.id === 'deck04')!.folderPath).toBe('');
    expect(decks.find((d) => d.id === 'deck06')!.commanders.length).toBeGreaterThan(0);
    expect(normalizeDeckList({ decks: [{ name: 'no ids' }] })).toEqual([]);
  });

  it('reads every board and ignores the top-level tokens list', () => {
    const { lastUpdatedAt, cards } = normalizeDeckCards(deck);
    expect(lastUpdatedAt).toBe(deck.lastUpdatedAtUtc);
    const by = (board: string) => cards.filter((c) => c.board === board);
    expect(by('mainboard').reduce((s, c) => s + c.qty, 0)).toBe(12);
    expect(by('commanders').map((c) => c.card.name)).toEqual(['Ezuri, Claw of Progress']);
    expect(by('maybeboard')).toHaveLength(2);
    expect(cards.some((c) => c.card.name === deck.tokens[0].name)).toBe(false);

    const island = cards.find((c) => c.card.name === 'Island')!;
    expect(island).toMatchObject({ qty: 9, finish: 'nonFoil', isProxy: false });
    expect(printKey(island.card.set, island.card.cn, island.finish)).toBe('dsk|279|nonFoil');
    expect(cards.find((c) => c.finish === 'foil')!.board).toBe('maybeboard');
    expect(cards.filter((c) => c.isProxy).map((c) => c.card.name)).toEqual(['Tranquil Thicket']);
  });

  it('splits entries whose copies differ (printingData) into one row per finish / print', () => {
    const { cards } = normalizeDeckCards(fixture<any>('moxfield-deck-split.json'));
    const row = (board: string) => cards.filter((c) => c.board === board).map((c) => [c.qty, c.card.set, c.card.cn, c.finish, c.isProxy]);
    // Real entry: "3 Adventurer's Airship" = 2 non-foil + 1 foil, top level says 3 non-foil.
    expect(row('mainboard')).toEqual([
      [2, 'fin', '252', 'nonFoil', false],
      [1, 'fin', '252', 'foil', false],
    ]);
    // Other print in a group without its own card; 1 copy not covered by the groups keeps the entry's print.
    expect(row('sideboard')).toEqual([
      [2, 'fin', '252', 'nonFoil', false],
      [1, 'fca', '99', 'etched', true],
      [1, 'fin', '252', 'nonFoil', false],
    ]);
    expect(cards.find((c) => c.card.set === 'fca')!.card.name).toBe("Adventurer's Airship");
  });

  it('labels boards', () => {
    expect(boardLabel('signatureSpells')).toBe('Signature spells');
    expect(boardLabel('someNewBoard')).toBe('Some New Board');
  });

  it('reads the game of collection rows', () => {
    expect(normalizeEntry({ ...page.data[0], game: 'paper' })!.game).toBe('paper');
    expect(normalizeEntry(page.data[0])!.game).toBeUndefined();
  });
});

describe('Moxfield requests', () => {
  it('validates requests before building URLs', () => {
    expect(requestUrl({ kind: 'deckList' })).toBe('https://api2.moxfield.com/v3/decks');
    expect(requestUrl({ kind: 'deck', publicId: 'SQiW9NErJ0WEfI6NYMzCSw' })).toBe('https://api2.moxfield.com/v3/decks/all/SQiW9NErJ0WEfI6NYMzCSw');
    expect(requestUrl({ kind: 'deck', publicId: '../v1/account' })).toBeNull();
    expect(requestUrl({ kind: 'nope' })).toBeNull();
    expect(requestUrl({ kind: 'collection', pageNumber: 0, pageSize: 10 })).toBeNull();
    const url = new URL(requestUrl({ kind: 'collection', pageNumber: 2, pageSize: 99_999 })!);
    expect(url.searchParams.get('pageSize')).toBe(String(MAX_COLLECTION_PAGE_SIZE));
    expect(url.searchParams.get('pageNumber')).toBe('2');
  });

  it('asks for the whole collection with every filter empty', () => {
    const url = wholeCollectionUrl(1, 5000);
    expect(url).toContain('/v1/collections/search?q=+&setId=&deckId=&');
    const u = new URL(url);
    for (const k of ['setId', 'deckId', 'finish', 'isProxy', 'tradeBinderId', 'cardLanguageId']) expect(u.searchParams.get(k)).toBe('');
  });

  it('answers with trimmed data or a failure object', async () => {
    const urls: string[] = [];
    const ok = await runMoxRequest({ kind: 'deck', publicId: 'TestDeck06Public_GGGGGG' }, async (u) => {
      urls.push(u);
      return json(deck);
    });
    expect(urls).toEqual(['https://api2.moxfield.com/v3/decks/all/TestDeck06Public_GGGGGG']);
    expect(ok.ok && ok.kind === 'deck' && ok.cards.length).toBe(7); // 4 main + 2 maybe + 1 commander

    const coll = await runMoxRequest({ kind: 'collection', pageNumber: 1, pageSize: 5000 }, async () => json({ ...page, totalPages: 1, pageSize: 5000 }));
    expect(coll.ok && coll.kind === 'collection' && coll.entries.length).toBe(page.data.length);

    expect(await runMoxRequest({ kind: 'deckList' }, async () => json({}, 401))).toMatchObject({ ok: false, status: 401, code: 'no_auth' });
    expect(await runMoxRequest({ kind: 'deckList' }, async () => json({}, 429))).toMatchObject({ ok: false, status: 429, code: 'http' });
    expect(
      await runMoxRequest({ kind: 'deckList' }, async () => {
        throw new TypeError('Failed to fetch');
      }),
    ).toMatchObject({ ok: false, status: 0, code: 'network' });
    expect(await runMoxRequest({ kind: 'deckList' }, async () => new Response('<html>', { status: 200 }))).toMatchObject({ ok: false, code: 'parse' });
  });
});
