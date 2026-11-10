import { buildSearchUrl, F2F_COLLECTIONS, nmVariant, parseFacetValues, skuSetCode, sizedImage } from '@/lib/f2f/api';
import { f2fLinks } from '@/lib/f2f/links';
import { docs } from './helpers';

describe('buildSearchUrl', () => {
  it('reproduces the URL format F2F itself uses (double-encoded, $^-joined)', () => {
    const url = buildSearchUrl({
      collection: F2F_COLLECTIONS.mtgSingles,
      pageSize: 500,
      facets: { 'Card Name': ['Sheoldred, the Apocalypse', 'Sol Ring'], 'Collector Number': ['435', 'BLC-129'], Language: ['English'] },
    });
    expect(url).toBe(
      'https://facetofacegames.com/apps/prod-indexer/buy/search/collections/616193818996/pageSize/500/page/1' +
        '/Card%20Name/Sheoldred%252C%2520the%2520Apocalypse%2524%255ESol%2520Ring' +
        '/Collector%20Number/435%2524%255EBLC-129/Language/English/withFacets/false',
    );
  });

  it('can ask for facet aggregations (used to read F2F set names)', () => {
    const url = buildSearchUrl({ collection: F2F_COLLECTIONS.mtgSingles, pageSize: 0, withFacets: true });
    expect(url).toBe('https://facetofacegames.com/apps/prod-indexer/buy/search/collections/616193818996/pageSize/0/page/1');
    expect(parseFacetValues({ aggregations: { Set: { buckets: [{ key: 'The List' }, { key: 'Dominaria United' }] } } }, 'Set')).toEqual(['The List', 'Dominaria United']);
    expect(() => parseFacetValues({}, 'Set')).toThrow();
  });

  it('adds keyword searches and skips empty facets', () => {
    const url = buildSearchUrl({ collection: '1', pageSize: 10, keyword: 'Fire // Ice', facets: { Set: [] } });
    expect(url).toBe('https://facetofacegames.com/apps/prod-indexer/buy/search/collections/1/pageSize/10/page/1/keyword/Fire%2520%252F%252F%2520Ice/withFacets/false');
  });
});

describe('F2F docs', () => {
  const batch = docs('f2f-batch.json');

  it('parses set codes from both SKU formats', () => {
    expect(skuSetCode('SIN-MTG-PLST-BLC-129-ENG-NM-NF')).toBe('plst');
    expect(skuSetCode('M-ONS-Mythic_Pro-274-NM-F')).toBe('ons');
    expect(skuSetCode('MTG_Bulk_Rare')).toBeNull();
  });

  it('trims docs with retail and buy prices per condition', () => {
    const sheoldred = batch.find((d) => d.cn === '435' && d.finish === 'Foil')!;
    expect(sheoldred.name).toBe('Sheoldred, the Apocalypse');
    expect(sheoldred.skuSet).toBe('dmu');
    expect(nmVariant(sheoldred)).toMatchObject({ condition: 'NM', retail: 524.99, buy: 210 });
    expect(sheoldred.publishedF2FSell).toBe(true);
  });

  it('sizes Shopify images', () => {
    expect(sizedImage('https://cdn.shopify.com/s/files/x.jpg?v=1', 146)).toBe('https://cdn.shopify.com/s/files/x.jpg?v=1&width=146');
  });

  it('builds sell/buy links', () => {
    expect(f2fLinks.sellProduct('sol-ring-59')).toBe('https://facetofacegames.com/products/sol-ring-59?site=sell');
    expect(f2fLinks.shopProduct('sol-ring-59')).toBe('https://facetofacegames.com/products/sol-ring-59?tithies=shop');
  });
});
