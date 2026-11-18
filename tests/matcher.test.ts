import { parseBulkRates } from '@/features/f2f-buylist/bulk';
import { evaluate, matchByNumber, matchPrint, type PrintRef } from '@/features/f2f-buylist/matcher';
import { isScanListing } from '@/lib/f2f/api';
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

  describe('scanned single copies (SIN-SCAN-…)', () => {
    const scans = docs('f2f-scans.json');
    const yshtola = (cn: string, finish: PrintRef['finish']) =>
      print({ name: "Y'shtola, Night's Blessed", set: 'fic', setName: 'Final Fantasy Commander', cn, finish });

    it('recognises them by SKU and by title', () => {
      expect(scans.filter(isScanListing)).toHaveLength(5);
      expect(isScanListing({ title: "Y'shtola, Night's Blessed - Borderless - Scan 13012", variants: [] })).toBe(true);
      expect(isScanListing({ title: 'Sol Ring [59] [TMNT] [Surge Foil]', variants: [] })).toBe(false);
    });

    it('prefers the regular buylist product even when F2F lists the scans first', () => {
      // Real case: FIC #215 is Surge Foil only; four scanned copies come before the product F2F buys at 1100.
      const r = matchPrint(yshtola('215', 'foil'), scans);
      expect(r).toMatchObject({ match: 'exact', doc: { handle: 'yshtola-nights-blessed-215-borderless-character-final-fantasy-commander-surge-foil' } });
      expect(r.note).toBe('F2F lists this foil as "Surge Foil"');
      expect(evaluate({ ...yshtola('215', 'foil'), ...meta, rarity: 'mythic' }, r, rates, 0.3)).toMatchObject({ category: 'buylist', buyCash: 1100, retail: 1799.99 });
      expect(matchPrint(yshtola('207', 'foil'), scans).doc?.handle).toBe('yshtola-nights-blessed-207-borderless-character-final-fantasy-commander-foil');
    });

    it('falls back to a scan (flagged) when F2F has nothing else for the print', () => {
      const onlyScans = scans.filter((d) => isScanListing(d) || d.cn !== '215');
      const r = matchPrint(yshtola('215', 'foil'), onlyScans);
      expect(r.match).toBe('exact');
      expect(r.doc && isScanListing(r.doc)).toBe(true);
      expect(r.note).toContain('individually scanned copies');
    });
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

  it("puts cards F2F doesn't buy at all (tokens, Unfinity, schemes) in their own category", () => {
    const none = { match: 'not_found' as const, doc: null };
    const token = evaluate({ set: 'totc', setType: 'token', finish: 'nonFoil', rarity: 'token', typeLine: 'Token Creature — Construct', isToken: true }, none, rates, 0.3);
    expect(token).toMatchObject({ category: 'not_bought', buyCash: 0, buyCredit: 0 });
    expect(token.bulkReason).toMatch(/tokens are not bought/i);
    const unf = evaluate({ set: 'unf', setType: 'funny', finish: 'nonFoil', rarity: 'common', typeLine: 'Creature', isToken: false }, none, rates, 0.3);
    expect(unf).toMatchObject({ category: 'not_bought', buyCash: 0 });
    // No buy ÷ sell % for cards F2F doesn't buy, even when it sells them.
    const unfListed = evaluate({ set: 'unf', setType: 'funny', finish: 'nonFoil', rarity: 'common', typeLine: 'Creature', isToken: false }, { match: 'exact', doc: { ...dfc[0], publishedF2FSell: false } }, rates, 0.3);
    expect(unfListed).toMatchObject({ category: 'not_bought', pctCash: null, pctCredit: null });
    const scheme = evaluate({ set: 'dsc', setType: 'commander', finish: 'nonFoil', rarity: 'common', typeLine: 'Scheme', isToken: false }, none, rates, 0.3);
    expect(scheme.category).toBe('not_bought');
  });
});

describe('Languages (real F2F docs, 2026-11-18)', () => {
  const foreign = docs('f2f-foreign.json');
  const swords = (lang: string, set = 'fbb', setName = 'Foreign Black Border') =>
    print({ name: 'Swords to Plowshares', set, setName, cn: '41', finish: 'nonFoil', lang });
  const murk = (lang: string, set: string, setName: string, cn: string) => print({ name: 'Murk Dwellers', set, setName, cn, finish: 'nonFoil', lang });

  it("finds a print in its language, in F2F's set of that language", () => {
    const fr = matchPrint(swords('fr'), foreign);
    expect(fr).toMatchObject({ match: 'exact', doc: { setName: 'Foreign Black Border: French', language: 'French', skuSet: 'fbbf' } });
    expect(evaluate({ ...swords('fr'), ...meta, rarity: 'uncommon' }, fr, rates, 0.3)).toMatchObject({ category: 'buylist', buyCash: 40 });
    expect(matchPrint(swords('de'), foreign).doc?.setName).toBe('Foreign Black Border: German');
    expect(matchPrint(swords('it'), foreign).doc?.setName).toBe('Foreign Black Border: Italian');
    // Older SKUs ("M-RENf-…"), split sets named "…: Japanese", F2F's "Portugese" and its one Chinese.
    expect(matchPrint(murk('fr', 'ren', 'Renaissance', '62'), foreign).doc?.title).toMatch(/Renaissance French/);
    expect(matchPrint(murk('ja', '4bb', 'Fourth Edition Foreign Black Border', '148'), foreign).doc?.title).toMatch(/Japanese/);
    expect(matchPrint(murk('pt', '4bb', 'Fourth Edition Foreign Black Border', '148'), foreign).doc?.title).toMatch(/Portuguese/);
    expect(matchPrint(murk('zhs', '4bb', 'Fourth Edition Foreign Black Border', '148'), foreign).doc?.title).toMatch(/Chinese/);
    expect(matchPrint(murk('it', 'drk', 'The Dark', '49'), foreign).doc?.title).toMatch(/The Dark: Italian/);
    expect(matchByNumber(murk('it', 'drk', 'The Dark', '49'), foreign).doc?.title).toMatch(/The Dark: Italian/);
  });

  it('never takes a listing in another language', () => {
    // No English FBB, and no French Revised #41 among these docs.
    expect(matchPrint(swords('en'), foreign).match).toBe('not_found');
    expect(matchPrint(swords('fr', '3ed', 'Revised Edition'), foreign).match).toBe('not_found');
    expect(matchPrint(swords('en', '3ed', 'Revised Edition'), foreign).doc?.title).toBe('Swords to Plowshares [41] [Revised Edition] [Non-Foil]');
    // The English Fourth Edition, not its Japanese black-border print of the same number.
    expect(matchPrint(murk('en', '4ed', 'Fourth Edition', '148'), foreign).doc?.title).toMatch(/\[Fourth Edition\]/);
    expect(matchPrint(murk('ko', '4ed', 'Fourth Edition', '148'), foreign).match).toBe('not_found');
  });

  it('values a non-English copy at its buylist price only, never as bulk', () => {
    const item = { ...swords('fr', '3ed', 'Revised Edition'), ...meta, rarity: 'uncommon' };
    const none = evaluate(item, { match: 'unlisted', doc: null }, rates, 0.3);
    expect(none).toMatchObject({ category: 'not_bought', buyCash: 0, buyCredit: 0, pctCash: null });
    expect(none.bulkReason).toMatch(/doesn't list this print in French/);
    // Listed in its language but not bought (Renaissance French has no buy price).
    const ren = murk('fr', 'ren', 'Renaissance', '62');
    const listed = evaluate({ ...ren, ...meta, rarity: 'common' }, matchPrint(ren, foreign), rates, 0.3);
    expect(listed).toMatchObject({ category: 'not_bought', buyCash: 0 });
    expect(listed.bulkReason).toMatch(/lists it in French but doesn't buy it/);
    // The same English card would be bulk.
    expect(evaluate({ ...item, lang: 'en' }, { match: 'not_found', doc: null }, rates, 0.3).category).toBe('bulk');
  });
});
