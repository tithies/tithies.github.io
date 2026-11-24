import type { CardFacts, ScryfallSet } from '@/lib/cards/scryfall';
import { cleanGrouping, copyToSiblings, folderDecks, groupTree, leaves, pruneGrouping, setSplit, validGroup, withGroups } from '@/lib/export/grouping';
import type { ExportItem, Grouping } from '@/lib/export/types';

const item = (name: string, set: string, qty: number, group: Partial<NonNullable<ExportItem['group']>> = {}): ExportItem => ({
  key: `${set}|${name}`,
  cardId: `${set}-${name}`,
  scryfallId: '',
  name,
  set,
  setName: set.toUpperCase(),
  cn: '1',
  finish: 'nonFoil',
  qty,
  group: { set: 'fin', setName: 'Final Fantasy', rarity: 'rare', colors: 'R', ...group },
});

const CARDS = [
  item('Cloud', 'fin', 2, { rarity: 'mythic', colors: 'R' }),
  item('Tifa', 'fin', 1, { rarity: 'rare', colors: 'R' }),
  item('Aerith', 'fic', 3, { rarity: 'rare', colors: 'WG' }),
  item('Sol Ring', 'fic', 1, { rarity: 'uncommon', colors: '' }),
  item('Mabel', 'blb', 4, { set: 'blb', setName: 'Bloomburrow', rarity: 'rare', colors: 'W' }),
];

describe('Deck folder grouping', () => {
  it('splits each group its own way, and names each deck after its groups', () => {
    // Set; Final Fantasy by rarity; its rares by color; Bloomburrow not split.
    const g: Grouping = { '': 'set', 'set:fin': 'rarity', 'set:fin/rarity:rare': 'color' };
    const decks = folderDecks(CARDS, g, 'Collection/By set');
    expect(decks.map((d) => [d.name, d.items.reduce((s, i) => s + i.qty, 0)])).toEqual([
      ['Bloomburrow', 4],
      ['Final Fantasy - Uncommon', 1],
      ['Final Fantasy - Rare - Red', 1],
      ['Final Fantasy - Rare - MultiColor', 3],
      ['Final Fantasy - Mythic', 2],
    ]);
  });

  it('any order of keys works, a key at most once per path; nothing split is one deck named after the folder', () => {
    expect(folderDecks(CARDS, { '': 'rarity', 'rarity:rare': 'color', 'rarity:rare/color:m': 'set' }, 'F').map((d) => d.name)).toEqual([
      'Uncommon',
      'Rare - White',
      'Rare - Red',
      'Rare - MultiColor - Final Fantasy',
      'Mythic',
    ]);
    // "set" again under "set" is ignored.
    expect(leaves(groupTree(CARDS, { '': 'set', 'set:fin': 'set' })).map((n) => n.path)).toEqual(['set:blb', 'set:fin']);
    expect(folderDecks(CARDS, {}, 'Collection/Spare cards')).toEqual([{ name: 'Spare cards', items: CARDS }]);
    // Colorless, and a card Scryfall didn't know.
    expect(folderDecks([item('Sol Ring', 'c21', 1, { colors: '' }), item('Odd', 'xyz', 1, { colors: '?', rarity: '' })], { '': 'color', 'color:x': 'rarity' }, 'F').map((d) => d.name)).toEqual([
      'Colorless',
      'Unknown color - Unknown rarity',
    ]);
  });

  it('"apply to every set" copies a group’s choices to the groups next to it, all the way down', () => {
    const g: Grouping = { '': 'set', 'set:fin': 'rarity', 'set:fin/rarity:rare': 'color' };
    const tree = groupTree(CARDS, g);
    const all = copyToSiblings(g, tree, 'set:fin');
    expect(all['set:blb']).toBe('rarity');
    expect(all['set:blb/rarity:rare']).toBe('color');
    expect(folderDecks(CARDS, all, 'F').map((d) => d.name)).toContain('Bloomburrow - Rare - White');
    // Only what the cards have is kept in a target.
    expect(pruneGrouping(CARDS, { ...all, 'set:zzz': 'color' })['set:zzz']).toBeUndefined();
    expect(setSplit(g, 'set:fin', null)['set:fin']).toBeUndefined();
  });

  it('merges a set with the sets it holds (FIC → FIN) from Scryfall’s facts', () => {
    const sets = new Map<string, ScryfallSet>([
      ['fin', { code: 'fin', name: 'Final Fantasy' }],
      ['fic', { code: 'fic', name: 'Final Fantasy Commander', parent: 'fin' }],
      ['trk', { code: 'trk', name: 'Star Trek' }],
      ['trc', { code: 'trc', name: 'Star Trek Commander', parent: 'trk' }],
      ['atrc', { code: 'atrc', name: 'Star Trek Commander Art Series', parent: 'trc' }],
    ]);
    const facts = new Map<string, CardFacts>([
      ['11111111-1111-1111-1111-111111111111', { set: 'fic', rarity: 'rare', colors: 'WU' }],
      ['22222222-2222-2222-2222-222222222222', { set: 'atrc', rarity: 'common', colors: '' }],
    ]);
    const raw = (id: string, set: string): ExportItem => ({ ...item('x', set, 1), scryfallId: id, group: undefined });
    const [a, b, c] = withGroups([raw('11111111-1111-1111-1111-111111111111', 'fic'), raw('22222222-2222-2222-2222-222222222222', 'atrc'), raw('', 'plst')], facts, sets);
    expect(a.group).toEqual({ set: 'fin', setName: 'Final Fantasy', rarity: 'rare', colors: 'WU' });
    expect(b.group).toEqual({ set: 'trk', setName: 'Star Trek', rarity: 'common', colors: '' });
    // Unknown to Scryfall: its own set, unknown rarity and color.
    expect(c.group).toEqual({ set: 'plst', setName: 'PLST', rarity: '', colors: '?' });
    expect([a, b, c].every((i) => validGroup(i.group))).toBe(true);
  });

  it('checks a grouping from an extension page', () => {
    expect(cleanGrouping({ '': 'set', 'set:fin': 'rarity', 'set:fin/rarity:rare': 'color' })).toEqual({ '': 'set', 'set:fin': 'rarity', 'set:fin/rarity:rare': 'color' });
    expect(cleanGrouping({})).toEqual({});
    expect(cleanGrouping({ '': 'name' })).toBeNull();
    expect(cleanGrouping({ 'set:fin': 'set' })).toBeNull();
    expect(cleanGrouping({ 'set:fin/set:fic': 'rarity' })).toBeNull();
    expect(cleanGrouping({ 'set:fin/rarity:rare/color:r': 'set' })).toBeNull();
    expect(cleanGrouping({ 'set:F I N': 'rarity' })).toBeNull();
    expect(cleanGrouping([])).toBeNull();
    expect(validGroup({ set: 'fin', setName: 'x', rarity: 'rare', colors: 'WX' })).toBe(false);
  });
});
