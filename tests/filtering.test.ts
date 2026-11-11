import { applyFilters, applySort, detailedFinish, EMPTY_FILTERS, filtersFromParams, isProblem, itemState, nameNote, pctOf, sortFromParams, writeParams } from '@/features/f2f-buylist/ui/filtering';
import type { Item } from '@/features/f2f-buylist/types';

const item = (p: Partial<Item>): Item =>
  ({
    runId: 1,
    key: p.name ?? 'x',
    status: 'done',
    name: 'X',
    frontName: 'X',
    faces: ['X'],
    set: 'dmu',
    setName: 'Dominaria United',
    setType: 'expansion',
    cn: '1',
    finish: 'nonFoil',
    rarity: 'rare',
    typeLine: '',
    isToken: false,
    qty: 1,
    conditions: {},
    alters: 0,
    scryfallId: '',
    marketUsd: null,
    updatedAt: 0,
    ...p,
  }) as Item;

const items = [
  item({ name: 'Sheoldred', category: 'buylist', buyCash: 100, pctCash: 41.7, qty: 1, stock: 3, match: 'exact' }),
  item({ name: 'Sol Ring', category: 'buylist', buyCash: 2, pctCash: 50, qty: 4, stock: 0, match: 'exact', set: 'tmc' }),
  item({ name: 'Abigale', category: 'bulk', buyCash: 0.01, pctCash: null, qty: 2, match: 'not_found', finish: 'foil' }),
];
const failed = item({ name: 'Broken', status: 'error', error: 'HTTP 429' });
const waiting = item({ name: 'Waiting', status: 'pending' });

describe('filters & sort', () => {
  it('filters by category, text, set, % and stock', () => {
    expect(applyFilters(items, { ...EMPTY_FILTERS, category: 'bulk' }).map((i) => i.name)).toEqual(['Abigale']);
    expect(applyFilters(items, { ...EMPTY_FILTERS, q: 'sol' }).map((i) => i.name)).toEqual(['Sol Ring']);
    expect(applyFilters(items, { ...EMPTY_FILTERS, sets: ['tmc'] }).length).toBe(1);
    expect(applyFilters(items, { ...EMPTY_FILTERS, minPct: 45 }).map((i) => i.name)).toEqual(['Sol Ring']);
    expect(applyFilters(items, { ...EMPTY_FILTERS, stock: 'in' }).map((i) => i.name)).toEqual(['Sheoldred']);
    // "No stock" = F2F has 0 copies, or doesn't list the card at all.
    expect(applyFilters(items, { ...EMPTY_FILTERS, stock: 'out' }).map((i) => i.name)).toEqual(['Sol Ring', 'Abigale']);
    expect(applyFilters([...items, failed], { ...EMPTY_FILTERS, problems: true }).map((i) => i.name)).toEqual(['Abigale', 'Broken']);
  });

  it('filters by status, including lookup errors and unchecked rows', () => {
    const all = [...items, failed, waiting];
    expect(itemState(failed)).toBe('error');
    expect(itemState(waiting)).toBe('pending');
    expect(applyFilters(all, { ...EMPTY_FILTERS, status: ['error'] }).map((i) => i.name)).toEqual(['Broken']);
    expect(applyFilters(all, { ...EMPTY_FILTERS, status: ['pending'] }).map((i) => i.name)).toEqual(['Waiting']);
    expect(applyFilters(all, { ...EMPTY_FILTERS, status: ['exact', 'not_found'] }).length).toBe(3);
  });

  it("filters cards F2F doesn't buy, including rows saved before that category existed", () => {
    const token = item({ name: 'Token', category: 'not_bought', buyCash: 0, match: 'exact' });
    const oldUnf = item({ name: 'Old Unfinity', category: 'bulk', buyCash: 0, pctCash: 0, match: 'exact' });
    const all = [...items, token, oldUnf];
    expect(applyFilters(all, { ...EMPTY_FILTERS, category: 'not_bought' }).map((i) => i.name)).toEqual(['Token', 'Old Unfinity']);
    expect(applyFilters(all, { ...EMPTY_FILTERS, category: 'bulk' }).map((i) => i.name)).toEqual(['Abigale']);
    expect(applySort(all, { key: 'category', dir: 'asc' }).map((i) => i.name)).toEqual(['Sheoldred', 'Sol Ring', 'Abigale', 'Old Unfinity', 'Token']);
    // Their stored 0 % is no ratio: excluded from % filters, sorted with the empty values.
    expect(pctOf(oldUnf, 'pctCash')).toBeNull();
    expect(applyFilters(all, { ...EMPTY_FILTERS, maxPct: 10 }).map((i) => i.name)).toEqual([]);
  });

  it('finds rows with a note under the name, and flags price checks for review', () => {
    const foil = item({ name: 'Surge', category: 'buylist', match: 'exact', matchNote: 'F2F lists this foil as "Surge Foil"' });
    const loose = item({ name: 'Loose', category: 'bulk', match: 'loose', doc: { title: 'Loose [2] [Set] [Non-Foil]' } as Item['doc'] });
    const check = item({ name: 'Avacyn', category: 'bulk', match: 'price_check', matchNote: 'On F2F, but missing…', doc: { title: 'Avacyn [3] [Magic 2015] [Non-Foil]' } as Item['doc'] });
    expect(nameNote(foil)).toEqual({ text: 'F2F lists this foil as "Surge Foil"', color: 'yellow', title: 'F2F lists this foil as "Surge Foil"' });
    expect(nameNote(loose)).toMatchObject({ text: 'F2F: Loose [2] [Set] [Non-Foil]', color: 'dimmed' });
    expect(nameNote(check)).toMatchObject({ text: 'Check the buy price manually on F2F', color: 'red' });
    expect(items.map(nameNote)).toEqual([null, null, null]);
    expect(applyFilters([...items, foil, loose, check], { ...EMPTY_FILTERS, noted: true }).map((i) => i.name)).toEqual(['Surge', 'Loose', 'Avacyn']);
    expect(isProblem(check)).toBe(true);
    expect(applyFilters([...items, check], { ...EMPTY_FILTERS, problems: true }).map((i) => i.name)).toEqual(['Abigale', 'Avacyn']);
    expect(applyFilters([...items, check], { ...EMPTY_FILTERS, status: ['price_check'] }).map((i) => i.name)).toEqual(['Avacyn']);
  });

  it("doesn't ask to review oversized cards F2F never lists, including rows saved as 'not_found'", () => {
    const scheme = item({ name: 'Scheme', category: 'not_bought', buyCash: 0, match: 'unlisted', typeLine: 'Scheme' });
    const oldScheme = item({ name: 'Old scheme', category: 'bulk', buyCash: 0, match: 'not_found', typeLine: 'Ongoing Scheme' });
    expect([scheme, oldScheme].map(itemState)).toEqual(['unlisted', 'unlisted']);
    expect([scheme, oldScheme].some(isProblem)).toBe(false);
    expect(applyFilters([...items, scheme, oldScheme], { ...EMPTY_FILTERS, status: ['unlisted'] }).map((i) => i.name)).toEqual(['Scheme', 'Old scheme']);
    expect(applyFilters([...items, scheme, oldScheme], { ...EMPTY_FILTERS, problems: true }).map((i) => i.name)).toEqual(['Abigale']);
    // Found by "scheme" even with the reason saved by older versions.
    const oldReason = { ...oldScheme, bulkReason: "Not on F2F's buylist — oversized Archenemy / Planechase cards are not sold or bought by F2F" };
    expect(applyFilters([...items, oldReason], { ...EMPTY_FILTERS, q: 'scheme' }).map((i) => i.name)).toEqual(['Old scheme']);
  });

  it('searches the reasons and notes too', () => {
    const unf = item({ name: 'Aardwolf', category: 'not_bought', buyCash: 0, bulkReason: 'Unfinity is excluded from F2F bulk' });
    const token = item({ name: 'Bounty', category: 'not_bought', buyCash: 0, bulkReason: 'Tokens are not bought as bulk' });
    const surge = item({ name: 'Forge Anew', category: 'buylist', match: 'exact', matchNote: 'F2F lists this foil as "Surge Foil"' });
    const all = [...items, unf, token, surge];
    expect(applyFilters(all, { ...EMPTY_FILTERS, q: 'unfinity' }).map((i) => i.name)).toEqual(['Aardwolf']);
    expect(applyFilters(all, { ...EMPTY_FILTERS, q: 'tokens' }).map((i) => i.name)).toEqual(['Bounty']);
    expect(applyFilters(all, { ...EMPTY_FILTERS, q: 'surge foil' }).map((i) => i.name)).toEqual(['Forge Anew']);
  });

  it('sorts empty values as the smallest: first ascending, last descending', () => {
    expect(applySort(items, { key: 'pctCash', dir: 'desc' }).map((i) => i.name)).toEqual(['Sol Ring', 'Sheoldred', 'Abigale']);
    expect(applySort(items, { key: 'pctCash', dir: 'asc' }).map((i) => i.name)).toEqual(['Abigale', 'Sheoldred', 'Sol Ring']);
    expect(applySort(items, { key: 'lineCash', dir: 'desc' }).map((i) => i.name)).toEqual(['Sheoldred', 'Sol Ring', 'Abigale']);
    expect(applySort(items, { key: 'name', dir: 'asc' }).map((i) => i.name)).toEqual(['Abigale', 'Sheoldred', 'Sol Ring']);
  });

  it('filters by special finish, using the name shown in the table', () => {
    const doc = (finish: string) => ({ finish }) as Item['doc'];
    const plain = item({ name: 'Plain', finish: 'nonFoil' });
    const foil = item({ name: 'Foil', finish: 'foil', doc: doc('Foil') });
    const surge = item({ name: 'Surge', finish: 'foil', doc: doc('Surge Foil') });
    const etched = item({ name: 'Etched', finish: 'etched', doc: doc('Etched Foil') });
    const all = [plain, foil, surge, etched];
    expect(all.map(detailedFinish)).toEqual(['Non-foil', 'Foil', 'Surge Foil', 'Etched']);
    expect(applyFilters(all, { ...EMPTY_FILTERS, specialFinishes: ['Surge Foil'] }).map((i) => i.name)).toEqual(['Surge']);
    expect(applyFilters(all, { ...EMPTY_FILTERS, specialFinishes: ['Surge Foil', 'Foil'] }).map((i) => i.name)).toEqual(['Foil', 'Surge']);
    // The plain Finish filter is unchanged: a surge foil is still a "foil".
    expect(applyFilters(all, { ...EMPTY_FILTERS, finishes: ['foil'] }).map((i) => i.name)).toEqual(['Foil', 'Surge']);
    expect(applyFilters(all, { ...EMPTY_FILTERS, finishes: ['foil'], specialFinishes: ['Surge Foil'] }).map((i) => i.name)).toEqual(['Surge']);
  });

  it('round-trips through URL params', () => {
    const f = { ...EMPTY_FILTERS, q: 'bolt', category: 'not_bought' as const, sets: ['dmu', 'tmc'], minPct: 30, stock: 'out' as const, status: ['error'], noted: true, specialFinishes: ['Surge Foil'] };
    const p = writeParams(new URLSearchParams(), f, { key: 'pctCash', dir: 'asc' }, 3);
    expect(filtersFromParams(p)).toEqual(f);
    expect(sortFromParams(p)).toEqual({ key: 'pctCash', dir: 'asc' });
    expect(p.get('page')).toBe('3');
    expect(writeParams(new URLSearchParams(), EMPTY_FILTERS, { key: 'buyCash', dir: 'desc' }, 1).toString()).toBe('');
  });

  it('still reads links saved before the status/stock rename', () => {
    const f = filtersFromParams(new URLSearchParams('match=loose,not_found&stock=1'));
    expect(f.status).toEqual(['loose', 'not_found']);
    expect(f.stock).toBe('in');
    expect(writeParams(new URLSearchParams('match=loose'), f, { key: 'buyCash', dir: 'desc' }, 1).get('match')).toBeNull();
  });
});
