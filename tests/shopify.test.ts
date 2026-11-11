import { parseBulkRates } from '@/features/f2f-buylist/bulk';
import { evaluate, matchShopify, PRICE_CHECK_NOTE, type PrintRef } from '@/features/f2f-buylist/matcher';
import { parseSinglesTitle, parseSuggest, productJsUrl, skuLanguage, suggestUrl, withProductVariants, type ProductJs, type SuggestResponse } from '@/lib/f2f/shopify';
import { docs, fixture } from './helpers';

// Real responses (trimmed), 2026-11-11: Avacyn M15 #3 is live on Shopify but missing from F2F's search index.
const suggest = fixture<SuggestResponse>('shopify-suggest-avacyn.json');
const product = fixture<ProductJs>('shopify-product-avacyn.json');
const rates = parseBulkRates(docs('f2f-bulk.json'), 0);

const avacyn: PrintRef = { name: 'Avacyn, Guardian Angel', faces: ['Avacyn, Guardian Angel'], set: 'm15', setName: 'Magic 2015', cn: '3', finish: 'nonFoil' };

describe('Shopify product search', () => {
  it('builds the predictive search and product JSON URLs', () => {
    expect(suggestUrl('Avacyn, Guardian Angel')).toBe(
      'https://facetofacegames.com/search/suggest.json?q=Avacyn%2C%20Guardian%20Angel&resources%5Btype%5D=product&resources%5Blimit%5D=10',
    );
    expect(productJsUrl('avacyn-guardian-angel-3-magic-2015-non-foil')).toBe('https://facetofacegames.com/products/avacyn-guardian-angel-3-magic-2015-non-foil.js');
  });

  it('parses F2F single titles, with variant tags and non-English prints', () => {
    expect(parseSinglesTitle('Avacyn, Guardian Angel [3] [Magic 2015] [Non-Foil]')).toEqual({
      name: 'Avacyn, Guardian Angel',
      cn: '3',
      setName: 'Magic 2015',
      finish: 'Non-Foil',
      language: 'English',
    });
    expect(parseSinglesTitle('Avacyn, Angel of Hope [482] [Borderless] [Poster] [Innistrad Remastered] [Foil]')).toMatchObject({
      cn: '482',
      setName: 'Innistrad Remastered',
      finish: 'Foil',
    });
    expect(parseSinglesTitle('Twitching Doll - Japanese [2026-4] [PRM-0002] [Planeswalker Championship Promos] [Foil]')).toMatchObject({
      name: 'Twitching Doll',
      language: 'Japanese',
    });
    expect(parseSinglesTitle('Chaos Orb — ID 19331')).toBeNull();
    expect(parseSinglesTitle('Legions Preconstructed Theme Deck - Elvish Rage')).toBeNull();
  });

  it('turns predictive-search singles into docs and counts every result', () => {
    const { total, docs: found } = parseSuggest(suggest);
    expect(total).toBe(10);
    expect(found[0]).toMatchObject({
      handle: 'avacyn-guardian-angel-3-magic-2015-non-foil',
      name: 'Avacyn, Guardian Angel',
      setName: 'Magic 2015',
      cn: '3',
      finish: 'Non-Foil',
      source: 'shopify',
      variants: [],
    });
    expect(() => parseSuggest({} as SuggestResponse)).toThrow(/no product results/);
  });

  it('reads conditions, retail prices and the SKU from the product JSON', () => {
    const doc = withProductVariants(parseSuggest(suggest).docs[0], product);
    expect(doc.skuSet).toBe('m15');
    expect(doc.language).toBe('English');
    expect(doc.variants).toEqual([
      { condition: 'NM', retail: 2.49, buy: null, stock: null, sku: 'M-M15-Avacyn_Gu-3-NM-NF' },
      { condition: 'PL', retail: 1.99, buy: null, stock: null, sku: 'M-M15-Avacyn_Gu-3-PL-NF' },
    ]);
  });

  it('reads the language from current SKUs only', () => {
    expect(skuLanguage('SIN-MTG-PWCS-2026-4-JPN-NM-F')).toBe('JPN');
    expect(skuLanguage('SIN-MTG-J25-643-ENG-NM-NF')).toBe('ENG');
    expect(skuLanguage('M-M15-Avacyn_Gu-3-NM-NF')).toBeNull();
    const japanese = withProductVariants(parseSuggest(suggest).docs[0], {
      variants: [{ option1: 'NM', sku: 'SIN-MTG-M15-3-JPN-NM-NF', price: 500 }],
    });
    expect(japanese.language).toBe('JPN');
  });

  it('matches only the exact print among fuzzy results', () => {
    const found = parseSuggest(suggest).docs;
    expect(matchShopify(avacyn, found)?.handle).toBe('avacyn-guardian-angel-3-magic-2015-non-foil');
    expect(matchShopify({ ...avacyn, finish: 'foil' }, found)?.handle).toBe('avacyn-guardian-angel-3-magic-2015-foil');
    // Same name, other number / set: not this print.
    expect(matchShopify({ ...avacyn, cn: '4' }, found)).toBeNull();
    expect(matchShopify({ ...avacyn, set: 'm14', setName: 'Magic 2014' }, found)).toBeNull();
    // Names that only partly match ("Avacyn, Angel of Hope") never count.
    expect(matchShopify({ ...avacyn, name: 'Avacyn', faces: ['Avacyn'], cn: '5', setName: 'From the Vault: Angels', finish: 'foil' }, found)).toBeNull();
  });

  it("uses F2F's set name when Scryfall's differs", () => {
    const found = parseSuggest(suggest).docs;
    expect(matchShopify({ ...avacyn, setName: 'Core Set 2015' }, found)).toBeNull();
    expect(matchShopify({ ...avacyn, setName: 'Core Set 2015' }, found, 'Magic 2015')?.cn).toBe('3');
  });

  it('rejects non-English prints', () => {
    const [jp] = parseSuggest({
      resources: { results: { products: [{ id: 1, handle: 'jp', type: 'Singles', title: 'Avacyn, Guardian Angel - Japanese [3] [Magic 2015] [Non-Foil]' }] } },
    }).docs;
    expect(matchShopify(avacyn, [jp])).toBeNull();
  });

  it('values a price-check card at the bulk rate, with retail price and unknown stock', () => {
    const doc = withProductVariants(matchShopify(avacyn, parseSuggest(suggest).docs)!, product);
    const ev = evaluate({ ...avacyn, setType: 'core', typeLine: 'Legendary Creature — Angel', isToken: false, rarity: 'rare' }, { match: 'price_check', doc, note: PRICE_CHECK_NOTE }, rates, 0.3);
    expect(ev).toMatchObject({ category: 'bulk', buyCash: rates.rare, retail: 2.49, stock: null });
    expect(ev.bulkReason).toBe('Buy price unknown (check it on F2F) — bulk rate: rare');
  });
});
