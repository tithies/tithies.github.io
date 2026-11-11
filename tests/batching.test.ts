import { buildBatch, f2fSetLookup, makeBatches, makeSetBatches, nameFacets } from '@/features/f2f-buylist/batching';
import { fixture } from './helpers';

const mk = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ key: `set${i % 3}|${i}|nonFoil`, frontName: `Card number ${i}, the long-named`, cn: String(i), set: `set${i % 3}` }));

describe('makeBatches', () => {
  it('packs prints into batches of at most maxPrints', () => {
    const b = makeBatches(mk(100), { maxPrints: 40, maxUrlLength: 100_000, pageSize: 500 });
    expect(b.map((x) => x.keys.length)).toEqual([40, 40, 20]);
    expect(new Set(b.flatMap((x) => x.keys)).size).toBe(100);
  });

  it('respects the URL length cap', () => {
    const b = makeBatches(mk(100), { maxPrints: 100, maxUrlLength: 2000, pageSize: 500 });
    expect(b.length).toBeGreaterThan(1);
    for (const x of b) expect(x.url.length).toBeLessThanOrEqual(2000);
  });

  it("asks for F2F's real page size (100) by default", () => {
    const [b] = makeBatches(mk(3));
    expect(b.url).toContain('/pageSize/100/page/1/');
  });

  it('builds one request for an exact subset (used to split oversized batches)', () => {
    const items = mk(4);
    const b = buildBatch(items.slice(1, 3), nameFacets);
    expect(b.keys).toEqual([items[1].key, items[2].key]);
    expect(b.facets['Collector Number']).toEqual(['1', '2']);
  });

  it('dedupes names and numbers within a batch', () => {
    const items = [
      { key: 'a|1|foil', frontName: 'Sol Ring', cn: '1', set: 'a' },
      { key: 'a|1|nonFoil', frontName: 'Sol Ring', cn: '1', set: 'a' },
    ];
    const [b] = makeBatches(items);
    expect(b.facets['Card Name']).toEqual(['Sol Ring']);
    expect(b.facets['Collector Number']).toEqual(['1']);
  });

  it("also searches F2F's \"Flavor - Name\" title for flavor-name prints", () => {
    const [b] = makeBatches([{ key: 'fca|27|foil', frontName: 'Wall of Omens', flavorName: 'The Imperial City of Archades', cn: '27', set: 'fca' }]);
    expect(b.facets['Card Name']).toEqual(['Wall of Omens', 'The Imperial City of Archades - Wall of Omens']);
    expect(b.url).toContain('/Card%20Name/Wall%2520of%2520Omens%2524%255EThe%2520Imperial%2520City%2520of%2520Archades%2520-%2520Wall%2520of%2520Omens/');
  });
});

describe('set + number fallback batches', () => {
  const f2fSets = fixture<{ sets: string[] }>('f2f-sets.json').sets;
  const setOf = f2fSetLookup(f2fSets);

  const named = (setName: string, set = 'xxx') => setOf({ set, setName });

  it("maps Moxfield set names to F2F's spelling", () => {
    expect(named('Duskmourn: House of Horror Commander')).toBe('Duskmourn: House of Horror: Commander');
    expect(named('Final Fantasy: Through the Ages')).toBe('FINAL FANTASY: Through the Ages');
    expect(named('Definitely Not A Set')).toBeUndefined();
  });

  it('accepts a unique F2F set name that ends with the Moxfield one', () => {
    expect(named('Midnight Hunt Commander')).toBe('Innistrad: Midnight Hunt: Commander');
    expect(named('Tales of Middle-earth Commander')).toBe('The Lord of the Rings: Tales of Middle-earth: Commander');
    expect(named('Doctor Who')).toBe('Universes Beyond: Doctor Who');
    // Too short / ambiguous suffixes are not guessed.
    expect(named('Promos')).toBeUndefined();
  });

  it('prefers set names learned from F2F docs (by set code)', () => {
    const learned = f2fSetLookup(f2fSets, new Map([['40k', 'Universes Beyond: Warhammer 40,000']]));
    expect(named('Warhammer 40,000 Commander', '40k')).toBeUndefined();
    expect(learned({ set: '40k', setName: 'Warhammer 40,000 Commander' })).toBe('Universes Beyond: Warhammer 40,000');
  });

  it('puts each F2F set in its own request and skips sets F2F does not carry', () => {
    const { batches, unknownSet } = makeSetBatches(
      [
        { key: 'fca|27|foil', set: 'fca', setName: 'Final Fantasy: Through the Ages', cn: '27' },
        { key: 'dsc|340|nonFoil', set: 'dsc', setName: 'Duskmourn: House of Horror Commander', cn: '340' },
        { key: 'dsc|329|nonFoil', set: 'dsc', setName: 'Duskmourn: House of Horror Commander', cn: '329' },
        { key: 'zzz|1|nonFoil', set: 'zzz', setName: 'Nowhere', cn: '1' },
      ],
      setOf,
    );
    expect(unknownSet).toEqual(['zzz|1|nonFoil']);
    expect(batches.map((b) => b.facets)).toEqual([
      { Set: ['Duskmourn: House of Horror: Commander'], 'Collector Number': ['329', '340'] },
      { Set: ['FINAL FANTASY: Through the Ages'], 'Collector Number': ['27'] },
    ]);
    expect(batches[0].url).toContain('/Set/');
    expect(batches[0].url).not.toContain('Card%20Name');
  });
});
