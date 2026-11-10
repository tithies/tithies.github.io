import { buildDeckTree, filterTree, folderState, folderValues, NO_FOLDER_LABEL, setIncluded, type DeckTreeNode } from '@/lib/decks/tree';
import type { DeckRow } from '@/lib/decks/types';

const deck = (id: string, name: string, folderPath: string, extra: Partial<DeckRow> = {}): DeckRow => ({
  id,
  publicId: `pub-${id}`,
  name,
  format: 'commander',
  visibility: 'unlisted',
  folderPath,
  lastUpdatedAt: '2026-01-01T00:00:00Z',
  createdAt: '2026-01-01T00:00:00Z',
  mainboardCount: 100,
  sideboardCount: 0,
  maybeboardCount: 0,
  commanders: [],
  publicUrl: `https://moxfield.com/decks/pub-${id}`,
  firstSeenAt: 0,
  isNew: false,
  ...extra,
});

const DECKS = [
  deck('a', 'Zombies', 'Collection'),
  deck('b', 'Final Fantasy 10', 'Collection/Final Fantasy'),
  deck('c', 'Final Fantasy 9', 'Collection/Final Fantasy'),
  deck('d', 'Copy 1', 'Utils/Copy'),
  deck('e', 'Loose deck', ''),
  deck('f', 'Ezuri elves', 'Ideas', { commanders: ['Ezuri, Claw of Progress'] }),
];

const labels = (nodes: DeckTreeNode[]) => nodes.map((n) => n.label);

describe('Deck tree', () => {
  const tree = buildDeckTree(DECKS);

  it('nests folders by path, folders first, "(No folder)" last', () => {
    expect(labels(tree)).toEqual(['Collection', 'Ideas', 'Utils', NO_FOLDER_LABEL]);
    const collection = tree[0];
    // A folder can hold subfolders and decks at once.
    expect(labels(collection.children!)).toEqual(['Final Fantasy', 'Zombies']);
    // Natural sort: 9 before 10.
    expect(labels(collection.children![0].children!)).toEqual(['Final Fantasy 9', 'Final Fantasy 10']);
    expect(collection.deckIds.sort()).toEqual(['a', 'b', 'c']);
    // "Utils" only exists through "Utils/Copy".
    expect(tree[2].children![0]).toMatchObject({ label: 'Copy', path: 'Utils/Copy', deckIds: ['d'] });
    expect(tree[3].deckIds).toEqual(['e']);
    expect(folderValues(tree)).toEqual(['folder:Collection', 'folder:Collection/Final Fantasy', 'folder:Ideas', 'folder:Utils', 'folder:Utils/Copy', 'folder:/none']);
  });

  it('derives folder checkboxes from the exclusion list', () => {
    const ids = tree[0].deckIds;
    expect(folderState(ids, new Set())).toBe('all');
    expect(folderState(ids, new Set(['b']))).toBe('some');
    expect(folderState(ids, new Set(ids))).toBe('none');
    // Unchecking a folder excludes its decks; a deck added later is included (not in the list).
    const excluded = setIncluded(new Set(), ids, false);
    expect([...excluded].sort()).toEqual(['a', 'b', 'c']);
    const withNew = buildDeckTree([...DECKS, deck('g', 'New one', 'Collection')]);
    expect(folderState(withNew[0].deckIds, excluded)).toBe('some');
    expect([...setIncluded(excluded, ['a'], true)].sort()).toEqual(['b', 'c']);
  });

  it('filters by deck, commander and folder names', () => {
    expect(labels(filterTree(tree, 'fantasy 9'))).toEqual(['Collection']);
    const ff = filterTree(tree, 'fantasy 9')[0];
    expect(ff.deckIds).toEqual(['c']);
    expect(filterTree(tree, 'ezuri')[0]).toMatchObject({ label: 'Ideas', deckIds: ['f'] });
    // Matching a folder keeps everything in it.
    expect(filterTree(tree, 'utils')[0].deckIds).toEqual(['d']);
    expect(filterTree(tree, 'nothing like this')).toEqual([]);
    expect(filterTree(tree, '  ')).toBe(tree);
  });
});
