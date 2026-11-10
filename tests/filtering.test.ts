import { applyFilters, applySort, EMPTY_FILTERS, filtersFromParams, itemState, sortFromParams, writeParams } from '@/features/f2f-buylist/ui/filtering';
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

  it('sorts empty values as the smallest: first ascending, last descending', () => {
    expect(applySort(items, { key: 'pctCash', dir: 'desc' }).map((i) => i.name)).toEqual(['Sol Ring', 'Sheoldred', 'Abigale']);
    expect(applySort(items, { key: 'pctCash', dir: 'asc' }).map((i) => i.name)).toEqual(['Abigale', 'Sheoldred', 'Sol Ring']);
    expect(applySort(items, { key: 'lineCash', dir: 'desc' }).map((i) => i.name)).toEqual(['Sheoldred', 'Sol Ring', 'Abigale']);
    expect(applySort(items, { key: 'name', dir: 'asc' }).map((i) => i.name)).toEqual(['Abigale', 'Sheoldred', 'Sol Ring']);
  });

  it('round-trips through URL params', () => {
    const f = { ...EMPTY_FILTERS, q: 'bolt', category: 'buylist' as const, sets: ['dmu', 'tmc'], minPct: 30, stock: 'out' as const, status: ['error'] };
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
