import type { Quad } from '@/features/scanner/geometry';
import { draftFromScan, pairByName, parseLabels, photoChecked, sameName, serializeLabels, turnQuad } from '@/features/scanner/labels';
import type { MethodResult, ScannedPhoto } from '@/features/scanner/pipeline';

const quad = (x: number, y: number, w = 100, h = 140): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const result = (cands: [string, string, string][], turned = false): MethodResult => ({
  candidates: cands.map(([name, set, cn], i) => ({ scryfallId: `${set}-${cn}`, name, set, setName: set, cn, score: 0.9 - i * 0.1 })),
  margin: 0.2,
  turned,
});
const scan = (cards: { q: Quad; r: MethodResult }[], scale = 1) =>
  ({
    file: 'a.jpg',
    width: 1000 * scale,
    height: 800 * scale,
    scale,
    cards: cards.map((c, i) => ({ n: i + 1, quad: c.q, heightPx: 140, crop: undefined, byMethod: { m: c.r } })),
  }) as unknown as ScannedPhoto;

describe('label files', () => {
  it('reads format 1 as hand-given prints, and format 2 with corners', () => {
    const v1 = parseLabels('{"a.jpg":[{"name":"Opt","set":"dom","cn":60},{"name":"Island"}]}');
    expect(v1['a.jpg'].cards.map(({ id: _id, ...c }) => c)).toEqual([
      { name: 'Opt', set: 'dom', cn: '60', manual: true },
      { name: 'Island', manual: true },
    ]);
    const v2 = parseLabels('{"b.jpg":{"width":10,"height":8,"cards":[{"name":"Opt","quad":[[0,0],[5,0],[5,7],[0,7]],"hidden":true},{"name":"Island","checked":true}]}}');
    expect(v2['b.jpg'].width).toBe(10);
    expect(v2['b.jpg'].cards[0]).toMatchObject({ name: 'Opt', hidden: true, quad: quad(0, 0, 5, 7) });
    expect(v2['b.jpg'].cards[0].manual).toBeUndefined();
    expect(v2['b.jpg'].cards[1]).toMatchObject({ checked: true, manual: true });
    expect(() => parseLabels('[]')).toThrow();
    expect(() => parseLabels('{"a.jpg":{}}')).toThrow();
    expect(() => parseLabels('{"a.jpg":[{"set":"dom"}]}')).toThrow();
    expect(() => parseLabels('{"a.jpg":{"cards":[{"name":"Opt","quad":[[0,0],[1,1]]}]}}')).toThrow();
  });

  it('writes format 2 and reads it back', () => {
    const labels = { 'a.jpg': { width: 1000, height: 800, cards: [{ name: 'Opt', set: 'dom', cn: '60', quad: quad(1.234, 2), checked: true, manual: true, id: 'x' }] } };
    const text = serializeLabels(labels);
    expect(JSON.parse(text)['a.jpg']).toEqual({ width: 1000, height: 800, checked: true, cards: [{ name: 'Opt', set: 'dom', cn: '60', quad: [[1.2, 2], [101.2, 2], [101.2, 142], [1.2, 142]], checked: true, manual: true }] });
    expect(parseLabels(text)['a.jpg'].cards[0]).toMatchObject({ name: 'Opt', checked: true, manual: true });
    // A print from an older file stays "given by a person" through format 2, before anyone checks it.
    const fromOld = serializeLabels(parseLabels('{"b.jpg":[{"name":"Opt","set":"dom","cn":"60"}]}'));
    expect(parseLabels(fromOld)['b.jpg'].cards[0]).toMatchObject({ name: 'Opt', manual: true });
    expect(parseLabels(fromOld)['b.jpg'].cards[0].checked).toBeUndefined();
  });

  it('counts a photo checked once every card is, with corners unless mostly hidden', () => {
    expect(photoChecked({ cards: [{ name: 'A', checked: true, quad: quad(0, 0) }, { name: 'B', checked: true, hidden: true }] })).toBe(true);
    expect(photoChecked({ cards: [{ name: 'A', checked: true }] })).toBe(false);
    expect(photoChecked({ cards: [{ name: 'A', quad: quad(0, 0) }] })).toBe(false);
    expect(photoChecked({ cards: [] })).toBe(false);
  });

  it('matches a face of a double-faced card', () => {
    expect(sameName('Volcanic Fissure', 'Sundering Eruption // Volcanic Fissure')).toBe(true);
    expect(sameName('Sundering Eruption', 'Sundering Eruption // Volcanic Fissure')).toBe(true);
    expect(sameName('Opt', 'Optimus')).toBe(false);
  });

  it('pairs same-name labels with their exact print first', () => {
    const forests = [
      { name: 'Forest', set: 'woe', cn: '266' },
      { name: 'Forest', set: 'tdm', cn: '285' },
    ];
    const found = [
      [{ name: 'Forest', set: 'tdm', cn: '285' }],
      [{ name: 'Forest', set: 'woe', cn: '266' }],
    ];
    expect([...pairByName(forests, found)]).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it('gives a card outlined twice to the outline that matches best', () => {
    const found = [
      [{ name: 'Pay No Heed', set: 'sta', cn: '5', score: 0.54 }],
      [{ name: 'Pay No Heed', set: 'sta', cn: '5', score: 0.9 }],
    ];
    expect([...pairByName([{ name: 'Pay No Heed', set: 'sta', cn: '5' }], found)]).toEqual([[0, 1]]);
  });
});

describe('drafts from a scan', () => {
  it('proposes every card found, turned to its own top-left, at full resolution', () => {
    const s = scan([{ q: quad(10, 20), r: result([['Opt', 'dom', '60']], true) }], 0.5);
    const { photo, matches } = draftFromScan(s, 'm');
    expect(photo.width).toBe(1000);
    expect(photo.cards).toHaveLength(1);
    const c = photo.cards[0];
    expect(c).toMatchObject({ name: 'Opt', set: 'dom', cn: '60', scryfallId: 'dom-60' });
    expect(c.checked).toBeUndefined();
    expect(c.quad).toEqual(turnQuad(quad(20, 40, 200, 280)));
    expect(matches.get(c.id!)?.result?.turned).toBe(true);
  });

  it('gives older name-only labels the corners of their card, and lists the rest without', () => {
    const s = scan([
      { q: quad(0, 0), r: result([['Island', 'one', '1']]) },
      { q: quad(200, 0), r: result([['Opt', 'dom', '60']]) },
      { q: quad(400, 0), r: result([['Junk', 'x', '1']]) },
    ]);
    const old = parseLabels('{"a.jpg":[{"name":"Opt","set":"dom","cn":"60"},{"name":"Lost card"}]}')['a.jpg'].cards;
    const { photo } = draftFromScan(s, 'm', old);
    expect(photo.cards.map((c) => [c.name, !!c.quad, !!c.manual])).toEqual([
      ['Opt', true, true],
      ['Lost card', false, true],
      ['Island', true, false],
      ['Junk', true, false],
    ]);
    expect(photo.cards[0].quad).toEqual(quad(200, 0));
  });

  it("doesn't propose again a card that a label already outlines", () => {
    const s = scan([{ q: quad(0, 0), r: result([['Island', 'one', '1']]) }]);
    const old = [{ name: 'Island', quad: quad(2, 1), checked: true }];
    expect(draftFromScan(s, 'm', old).photo.cards).toHaveLength(1);
  });
});
