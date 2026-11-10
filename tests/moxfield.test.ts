import { describeQuery, groupPrints, isCollectionSearchUrl, isEligible, normalizeEntry, withPaging } from '@/lib/moxfield/normalize';
import { fixture } from './helpers';

const page = fixture<{ data: any[] }>('moxfield-page.json');

describe('Moxfield normalisation', () => {
  const entries = page.data.map(normalizeEntry).filter((e) => e !== null);

  it('normalises rows', () => {
    const abigale = entries.find((e) => e.card.cn === '170')!;
    expect(abigale.card.faces).toEqual(['Abigale, Poet Laureate', 'Heroic Stanza']);
    expect(abigale.card.set).toBe('sos');
    expect(abigale.lang).toBe('en');
    const etched = entries.find((e) => e.finish === 'etched')!;
    expect(etched.card.name).toContain('Abdel Adrian');
  });

  it('reads flavor names', () => {
    const raw = { ...page.data[0], card: { ...page.data[0].card, name: 'Wall of Omens', flavor_name: 'The Imperial City of Archades' } };
    expect(normalizeEntry(raw)!.card.flavorName).toBe('The Imperial City of Archades');
    expect(normalizeEntry(page.data[0])!.card.flavorName).toBe('');
  });

  it('keeps English non-proxy rows only and aggregates by print', () => {
    const base = entries[1];
    const extra = [
      { ...base, id: 'dup-1', qty: 2, condition: 'lightlyPlayed' },
      { ...base, id: 'fr-1', lang: 'fr' },
      { ...base, id: 'proxy-1', isProxy: true },
      { ...base, id: 'foil-1', finish: 'foil' as const },
    ];
    expect(isEligible(extra[1])).toBe(false);
    expect(isEligible(extra[2])).toBe(false);
    const groups = groupPrints([...entries, ...extra, entries[1] /* same id twice */]);
    const g = groups.find((x) => x.key === `${base.card.set}|${base.card.cn}|nonFoil`)!;
    expect(g.qty).toBe(base.qty + 2);
    expect(g.conditions).toMatchObject({ lightlyPlayed: 2 });
    expect(groups.some((x) => x.key === `${base.card.set}|${base.card.cn}|foil`)).toBe(true);
    expect(groups.length).toBe(entries.length + 1);
  });

  it('describes the captured query and pages it', () => {
    const url =
      'https://api2.moxfield.com/v1/collections/search?q=+&setId=abc&rarity=&finish=foil&pricingProvider=tcgplayer&pageNumber=1&pageSize=50&sortType=cardName&sortDirection=ascending';
    expect(isCollectionSearchUrl(url)).toBe(true);
    expect(isCollectionSearchUrl('https://api2.moxfield.com/v1/trade-binders')).toBe(false);
    expect(describeQuery(url)).toEqual({ query: { setId: 'abc', finish: 'foil' }, summary: 'setId=abc, finish=foil' });
    expect(describeQuery(url.replace('setId=abc', 'setId=').replace('finish=foil', 'finish=')).summary).toBe('Whole collection');
    const paged = new URL(withPaging(url, 3, 100));
    expect(paged.searchParams.get('pageNumber')).toBe('3');
    expect(paged.searchParams.get('pageSize')).toBe('100');
    expect(paged.searchParams.get('setId')).toBe('abc');
  });
});
