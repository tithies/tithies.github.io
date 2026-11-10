import { bulkValue, DEFAULT_BULK_RATES, parseBulkRates } from '@/features/f2f-buylist/bulk';
import { docs } from './helpers';

describe('bulk rates', () => {
  const rates = parseBulkRates(docs('f2f-bulk.json'), 0);

  it('reads every MTG bulk lot from the wholesale page, per card', () => {
    expect(rates.usedDefaults).toBe(false);
    expect(rates).toMatchObject({
      cu: 0.002,
      rare: 0.07,
      mythic: 0.25,
      foilCu: 0.01,
      foilRare: 0.07,
      foilMythic: 0.5,
      basic: 0.01,
      foilBasic: 0.01,
      fullArtBasic: 0.1,
      promo: 0.02,
    });
  });

  it('falls back to defaults when lots are missing', () => {
    const r = parseBulkRates([], 0);
    expect(r.usedDefaults).toBe(true);
    expect(r.rare).toBe(DEFAULT_BULK_RATES.rare);
  });

  const base = { set: 'sos', setType: 'expansion', typeLine: 'Creature', isToken: false } as const;
  it('values cards by rarity and finish', () => {
    expect(bulkValue({ ...base, finish: 'foil', rarity: 'uncommon' }, rates)).toMatchObject({ value: 0.01 });
    expect(bulkValue({ ...base, finish: 'nonFoil', rarity: 'mythic' }, rates)).toMatchObject({ value: 0.25 });
    expect(bulkValue({ ...base, finish: 'etched', rarity: 'rare' }, rates)).toMatchObject({ value: 0.07 });
    expect(bulkValue({ ...base, finish: 'nonFoil', rarity: 'common', typeLine: 'Basic Land — Forest' }, rates)).toMatchObject({ value: 0.01 });
  });

  it('excludes Un-sets and tokens', () => {
    expect(bulkValue({ ...base, set: 'unf', finish: 'nonFoil', rarity: 'common' }, rates)).toMatchObject({ value: 0, reason: expect.stringContaining('Unfinity') });
    expect(bulkValue({ ...base, isToken: true, finish: 'nonFoil', rarity: 'common' }, rates).value).toBe(0);
    // Oversized Archenemy schemes / Planechase planes: F2F doesn't list them at all.
    expect(bulkValue({ ...base, set: 'dsc', typeLine: 'Ongoing Scheme', finish: 'nonFoil', rarity: 'common' }, rates)).toMatchObject({ value: 0, reason: expect.stringContaining('Oversized') });
    expect(bulkValue({ ...base, typeLine: 'Legendary Planeswalker — Jace', finish: 'nonFoil', rarity: 'mythic' }, rates).value).toBe(0.25);
  });
});
