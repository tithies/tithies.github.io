import { groupPrints, isEligible } from '@/lib/cards/prints';
import { printLangMismatch } from '@/lib/cards/languages';
import { describeQuery, isCollectionSearchUrl, normalizeEntry, withPaging } from '@/lib/sites/moxfield/normalize';
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

  it('keeps non-proxy rows of every language and aggregates by print and language', () => {
    const base = { ...entries[1], card: { ...entries[1].card, lang: 'en' } };
    const extra = [
      { ...base, id: 'dup-1', qty: 2, condition: 'lightlyPlayed' },
      { ...base, id: 'fr-1', lang: 'fr' },
      { ...base, id: 'proxy-1', isProxy: true },
      { ...base, id: 'foil-1', finish: 'foil' as const },
    ];
    expect(isEligible(extra[1])).toBe(true);
    expect(isEligible(extra[2])).toBe(false);
    const groups = groupPrints([base, ...entries.slice(2), entries[0], ...extra, base /* same id twice */]);
    const g = groups.find((x) => x.key === `${base.card.set}|${base.card.cn}|nonFoil|en`)!;
    expect(g.qty).toBe(base.qty + 2);
    expect(g.conditions).toMatchObject({ lightlyPlayed: 2 });
    expect(g).toMatchObject({ lang: 'en', mismatchCopies: 0 });
    expect(groups.some((x) => x.key === `${base.card.set}|${base.card.cn}|foil|en`)).toBe(true);
    // Language French on the English print: grouped as French, with the print's language to warn about.
    expect(groups.find((x) => x.key === `${base.card.set}|${base.card.cn}|nonFoil|fr`)).toMatchObject({ lang: 'fr', qty: base.qty, mismatchCopies: base.qty, printLang: 'en' });
    expect(groups.length).toBe(entries.length + 2);
  });

  it("reads the Language field and the print's language apart (verified on Moxfield, 2026-11-18)", () => {
    const raw = page.data[0];
    const french = { id: 'kAVXO', code: 'fr', name: 'French' };
    // A French print (one card object per print and language) with the Language field left on English.
    const fbb = normalizeEntry({ ...raw, card: { ...raw.card, set: 'fbb', cn: '41', lang: 'fr' } })!;
    expect(fbb).toMatchObject({ lang: 'en', langId: 'LD58x', card: { lang: 'fr' } });
    expect(printLangMismatch(fbb)).toBe('fr');
    // Language French on the English print (Moxfield has no French one for it).
    const mantle = normalizeEntry({ ...raw, language: french, card: { ...raw.card, lang: 'en' } })!;
    expect(mantle).toMatchObject({ lang: 'fr', langId: 'kAVXO', card: { lang: 'en' } });
    expect(printLangMismatch(mantle)).toBe('en');
    const agree = normalizeEntry({ ...raw, language: french, card: { ...raw.card, lang: 'fr' } })!;
    expect(printLangMismatch(agree)).toBeNull();
    // Deck rows have no Language field: the print's language.
    const { language: _l, ...deckRow } = raw;
    expect(normalizeEntry({ ...deckRow, card: { ...raw.card, lang: 'ja' } })!.lang).toBe('ja');
    // Rows read before the print's language was kept never differ.
    expect(printLangMismatch({ lang: 'fr', card: {} })).toBeNull();
  });

  it('describes the captured query and pages it', () => {
    const url =
      'https://api2.moxfield.com/v1/collections/search?q=+&setId=abc&rarity=&finish=foil&pricingProvider=tcgplayer&pageNumber=1&pageSize=50&sortType=cardName&sortDirection=ascending';
    expect(isCollectionSearchUrl(url)).toBe(true);
    expect(isCollectionSearchUrl('https://api2.moxfield.com/v1/trade-binders')).toBe(false);
    expect(describeQuery(url)).toEqual({ query: { setId: 'abc', finish: 'foil' }, summary: 'setId=abc, finish=foil' });
    expect(describeQuery(url.replace('setId=abc', 'setId=').replace('finish=foil', 'finish=')).summary).toBe('Whole collection');
    expect(describeQuery(url.replace('setId=abc', 'cardLanguageId=kAVXO')).summary).toBe('language=French, finish=foil');
    const paged = new URL(withPaging(url, 3, 100));
    expect(paged.searchParams.get('pageNumber')).toBe('3');
    expect(paged.searchParams.get('pageSize')).toBe('100');
    expect(paged.searchParams.get('setId')).toBe('abc');
  });
});
