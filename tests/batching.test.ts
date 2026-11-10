import { f2fSetLookup, makeBatches, makeSetBatches } from '@/features/f2f-buylist/batching';
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

  it("maps Moxfield set names to F2F's spelling", () => {
    expect(setOf('Duskmourn: House of Horror Commander')).toBe('Duskmourn: House of Horror: Commander');
    expect(setOf('Final Fantasy: Through the Ages')).toBe('FINAL FANTASY: Through the Ages');
    expect(setOf('Definitely Not A Set')).toBeUndefined();
  });

  it('groups prints by F2F set and skips sets F2F does not carry', () => {
    const { batches, unknownSet } = makeSetBatches(
      [
        { key: 'fca|27|foil', set: 'fca', setName: 'Final Fantasy: Through the Ages', cn: '27' },
        { key: 'dsc|340|nonFoil', set: 'dsc', setName: 'Duskmourn: House of Horror Commander', cn: '340' },
        { key: 'zzz|1|nonFoil', set: 'zzz', setName: 'Nowhere', cn: '1' },
      ],
      setOf,
    );
    expect(unknownSet).toEqual(['zzz|1|nonFoil']);
    expect(batches).toHaveLength(1);
    expect(batches[0].facets).toEqual({
      Set: ['Duskmourn: House of Horror: Commander', 'FINAL FANTASY: Through the Ages'],
      'Collector Number': ['340', '27'],
    });
    expect(batches[0].url).toContain('/Set/');
    expect(batches[0].url).not.toContain('Card%20Name');
  });
});
