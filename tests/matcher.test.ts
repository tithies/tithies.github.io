import { parseBulkRates } from '@/features/f2f-buylist/bulk';
import { evaluate, matchByNumber, matchPrint, type PrintRef } from '@/features/f2f-buylist/matcher';
import { docs } from './helpers';

const batch = docs('f2f-batch.json');
const dfc = docs('f2f-dfc.json');
const flavor = docs('f2f-flavor.json');
const rates = parseBulkRates(docs('f2f-bulk.json'), 0);
const meta = { setType: 'expansion', typeLine: 'Creature', isToken: false };

const print = (p: Partial<PrintRef> & Pick<PrintRef, 'set' | 'setName' | 'cn' | 'finish' | 'name'>): PrintRef => ({ faces: [p.name], ...p });

describe('matchPrint + evaluate', () => {
  it('matches Sheoldred DMU #435 foil exactly and computes cash/credit/%', () => {
    const p = print({ name: 'Sheoldred, the Apocalypse', set: 'dmu', setName: 'Dominaria United', cn: '435', finish: 'foil' });
    const r = matchPrint(p, batch);
    expect(r.match).toBe('exact');
    const ev = evaluate({ ...p, ...meta, rarity: 'mythic' }, r, rates, 0.3);
    expect(ev).toMatchObject({ category: 'buylist', buyCash: 210, buyCredit: 273, retail: 524.99, pctCash: 40, pctCredit: 52 });
  });

  it('does not confuse finishes or sets with the same collector number', () => {
    const nf = matchPrint(print({ name: 'Sheoldred, the Apocalypse', set: 'dmu', setName: 'Dominaria United', cn: '435', finish: 'nonFoil' }), batch);
    expect(nf.doc?.finish).toBe('Non-Foil');
    // #274 exists for both Sol Ring (Revised) and Mythic Proportions (Onslaught).
    const ons = matchPrint(print({ name: 'Mythic Proportions', set: 'ons', setName: 'Onslaught', cn: '274', finish: 'nonFoil' }), batch);
    expect(ons.doc?.name).toBe('Mythic Proportions');
  });

  it('maps a Moxfield foil to a special F2F foil (Surge Foil) and flags it', () => {
    const r = matchPrint(print({ name: 'Sol Ring', set: 'tmc', setName: 'Teenage Mutant Ninja Turtles Eternal', cn: '59', finish: 'foil' }), batch);
    expect(r.match).toBe('exact');
    expect(r.doc?.finish).toBe('Surge Foil');
    expect(r.note).toContain('Surge Foil');
  });

  it('matches The List by SKU set code (plst)', () => {
    const r = matchPrint(print({ name: 'Sol Ring', set: 'plst', setName: 'The List', cn: 'BLC-129', finish: 'nonFoil' }), batch);
    expect(r.match).toBe('exact');
  });

  it('matches DFCs by front face and values unbought cards as bulk', () => {
    const p = print({ name: 'Abigale, Poet Laureate // Heroic Stanza', faces: ['Abigale, Poet Laureate', 'Heroic Stanza'], set: 'sos', setName: 'Secrets of Strixhaven', cn: '170', finish: 'foil' });
    const r = matchPrint(p, dfc);
    expect(r.match).toBe('exact');
    const ev = evaluate({ ...p, ...meta, rarity: 'uncommon' }, r, rates, 0.3);
    expect(ev.category).toBe('bulk');
    expect(ev.buyCash).toBe(0.01);
    expect(ev.retail).toBe(0.75);
    expect(ev.pctCash).toBeCloseTo(1.33, 2);
  });

  it('matches flavor-name prints F2F titles "Flavor - Name"', () => {
    const wall = print({ name: 'Wall of Omens', flavorName: 'The Imperial City of Archades', set: 'fca', setName: 'Final Fantasy: Through the Ages', cn: '27', finish: 'foil' });
    const r = matchPrint(wall, flavor);
    expect(r.match).toBe('exact');
    expect(r.doc?.title).toContain('[Foil]');
    // Even without Moxfield's flavor name, the "… - Wall of Omens" half is recognised.
    expect(matchPrint({ ...wall, flavorName: undefined }, flavor).match).toBe('exact');
    const ev = evaluate({ ...wall, ...meta, rarity: 'uncommon' }, r, rates, 0.3);
    expect(ev).toMatchObject({ category: 'buylist', buyCash: 0.1, retail: 0.75 });
  });

  it('set + number fallback: exact when names agree, loose when F2F names it differently', () => {
    const wall = print({ name: 'Wall of Omens', set: 'fca', setName: 'Final Fantasy: Through the Ages', cn: '27', finish: 'nonFoil' });
    expect(matchByNumber(wall, flavor)).toMatchObject({ match: 'exact', doc: { finish: 'Non-Foil' } });
    const renamed = matchByNumber({ ...wall, name: 'Some Other Name', faces: ['Some Other Name'] }, flavor);
    expect(renamed.match).toBe('loose');
    expect(renamed.note).toContain('The Imperial City of Archades - Wall of Omens');
    expect(matchByNumber({ ...wall, cn: '999' }, flavor).match).toBe('not_found');
  });

  it('treats missing prints as bulk (not found)', () => {
    const p = print({ name: 'Nope', set: 'xxx', setName: 'Nowhere', cn: '1', finish: 'nonFoil' });
    const r = matchPrint(p, batch);
    expect(r.match).toBe('not_found');
    const ev = evaluate({ ...p, ...meta, rarity: 'rare' }, r, rates, 0.3);
    expect(ev).toMatchObject({ category: 'bulk', buyCash: 0.07, retail: null, pctCash: null });
  });

  it('keeps Un-set cards that F2F actually buys on the buylist', () => {
    const p = print({ name: '_____ Goblin', set: 'unf', setName: 'Unfinity', cn: '107', finish: 'nonFoil' });
    const r = matchPrint(p, dfc);
    expect(r.match).toBe('exact');
    // F2F buys this one (0.10), so it is a buylist card, not bulk.
    expect(evaluate({ ...p, ...meta, rarity: 'common' }, r, rates, 0.3).category).toBe('buylist');
  });
});
