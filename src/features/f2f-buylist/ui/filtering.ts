import { fold } from '@/lib/format';
import { compareValues } from '@/lib/sort';
import { OVERSIZED_REASON } from '../bulk';
import { categoryOf, matchOf, type Category, type Item } from '../types';

export type CategoryFilter = 'all' | 'buylist' | 'bulk' | 'not_bought';
export type StockFilter = 'any' | 'in' | 'out';
/** One status per row: lookup error, not checked yet, or how well it matched F2F. */
export type ItemState = 'exact' | 'loose' | 'price_check' | 'unlisted' | 'not_found' | 'error' | 'pending';

export const itemState = (it: Item): ItemState =>
  it.status === 'error' ? 'error' : it.status !== 'done' ? 'pending' : (matchOf(it) ?? 'pending');

export interface Filters {
  q: string;
  category: CategoryFilter;
  sets: string[];
  finishes: string[];
  rarities: string[];
  status: string[];
  minBuy: number | null;
  maxBuy: number | null;
  minPct: number | null;
  maxPct: number | null;
  minQty: number | null;
  stock: StockFilter;
  problems: boolean;
  /** Only rows with a note under the card name (see `nameNote`). */
  noted: boolean;
}

export const EMPTY_FILTERS: Filters = {
  q: '',
  category: 'all',
  sets: [],
  finishes: [],
  rarities: [],
  status: [],
  minBuy: null,
  maxBuy: null,
  minPct: null,
  maxPct: null,
  minQty: null,
  stock: 'any',
  problems: false,
  noted: false,
};

export const SORT_KEYS = [
  'category',
  'name',
  'set',
  'cn',
  'finish',
  'rarity',
  'qty',
  'buyCash',
  'buyCredit',
  'retail',
  'pctCash',
  'pctCredit',
  'stock',
  'marketUsd',
  'lineCash',
  'lineCredit',
] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export interface Sort {
  key: SortKey;
  dir: 'asc' | 'desc';
}
export const DEFAULT_SORT: Sort = { key: 'buyCash', dir: 'desc' };

// --- URL <-> state ------------------------------------------------------------------------

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);
const numOrNull = (v: string | null) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function filtersFromParams(p: URLSearchParams): Filters {
  const cat = p.get('cat');
  const stock = p.get('stock');
  return {
    q: p.get('q') ?? '',
    category: cat === 'buylist' || cat === 'bulk' || cat === 'not_bought' ? cat : 'all',
    sets: list(p.get('sets')),
    finishes: list(p.get('fin')),
    rarities: list(p.get('rar')),
    // `match` is the pre-0.2 name of the status filter.
    status: list(p.get('status') ?? p.get('match')),
    minBuy: numOrNull(p.get('minBuy')),
    maxBuy: numOrNull(p.get('maxBuy')),
    minPct: numOrNull(p.get('minPct')),
    maxPct: numOrNull(p.get('maxPct')),
    minQty: numOrNull(p.get('minQty')),
    stock: stock === 'out' ? 'out' : stock === 'in' || stock === '1' ? 'in' : 'any',
    problems: p.get('problems') === '1',
    noted: p.get('note') === '1',
  };
}

export function sortFromParams(p: URLSearchParams): Sort {
  const key = p.get('sort') as SortKey | null;
  const dir = p.get('dir') === 'asc' ? 'asc' : 'desc';
  return key && (SORT_KEYS as readonly string[]).includes(key) ? { key, dir } : DEFAULT_SORT;
}

/** Writes filters/sort into URL params (empty values are removed to keep URLs short). */
export function writeParams(base: URLSearchParams, f: Filters, s: Sort, page: number): URLSearchParams {
  const p = new URLSearchParams(base);
  const set = (k: string, v: string | number | null | undefined | false) => {
    if (v === null || v === undefined || v === '' || v === false) p.delete(k);
    else p.set(k, String(v));
  };
  set('q', f.q.trim());
  set('cat', f.category === 'all' ? null : f.category);
  set('sets', f.sets.join(','));
  set('fin', f.finishes.join(','));
  set('rar', f.rarities.join(','));
  p.delete('match');
  set('status', f.status.join(','));
  set('minBuy', f.minBuy);
  set('maxBuy', f.maxBuy);
  set('minPct', f.minPct);
  set('maxPct', f.maxPct);
  set('minQty', f.minQty);
  set('stock', f.stock === 'any' ? null : f.stock);
  set('problems', f.problems ? '1' : null);
  set('note', f.noted ? '1' : null);
  set('sort', s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir ? null : s.key);
  set('dir', s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir ? null : s.dir);
  set('page', page > 1 ? page : null);
  return p;
}

export const activeFilterCount = (f: Filters) =>
  (f.q.trim() ? 1 : 0) +
  (f.category !== 'all' ? 1 : 0) +
  (f.sets.length ? 1 : 0) +
  (f.finishes.length ? 1 : 0) +
  (f.rarities.length ? 1 : 0) +
  (f.status.length ? 1 : 0) +
  (f.minBuy != null || f.maxBuy != null ? 1 : 0) +
  (f.minPct != null || f.maxPct != null ? 1 : 0) +
  (f.minQty != null ? 1 : 0) +
  (f.stock !== 'any' ? 1 : 0) +
  (f.problems ? 1 : 0) +
  (f.noted ? 1 : 0);

// --- filtering & sorting -------------------------------------------------------------------

/** Rows worth a second look: lookup errors, loose matches, buy prices to check by hand, prints not found (oversized cards F2F never lists are left out). */
export const isProblem = (it: Item) => ['error', 'loose', 'price_check', 'not_found'].includes(itemState(it));

/** Buy ÷ sell %, or null for cards F2F doesn't buy (rows saved before 'not_bought' stored 0). */
export const pctOf = (it: Item, key: 'pctCash' | 'pctCredit'): number | null => (categoryOf(it) === 'not_bought' ? null : (it[key] ?? null));

export interface NameNote {
  text: string;
  /** Mantine color: red = check the price by hand, yellow = matched with a remark, dimmed = F2F's title. */
  color: 'red' | 'yellow' | 'dimmed';
  /** Full text for the hover title. */
  title: string;
}

/**
 * The short line under the card name in the table, or null. Kinds: a buy price to check on F2F,
 * a remark on an exact match (F2F's own foil name, only scanned copies listed), or F2F's title
 * when the match isn't exact.
 */
export function nameNote(it: Item): NameNote | null {
  if (it.match === 'price_check') return { text: 'Check the buy price manually on F2F', color: 'red', title: it.matchNote ?? '' };
  if (it.match === 'exact') return it.matchNote ? { text: it.matchNote, color: 'yellow', title: it.matchNote } : null;
  if (it.doc?.title) return { text: `F2F: ${it.doc.title}`, color: 'dimmed', title: it.doc.title };
  return null;
}


export function applyFilters(items: Item[], f: Filters): Item[] {
  const terms = fold(f.q).split(/\s+/).filter(Boolean);
  const sets = new Set(f.sets);
  const fins = new Set(f.finishes);
  const rars = new Set(f.rarities);
  const states = new Set(f.status);
  return items.filter((it) => {
    if (terms.length) {
      // Reasons too ("Unfinity is excluded…", "Tokens are not bought…", "Surge Foil"…). Older
      // rows of oversized cards carry a reason without the word "scheme", so add today's.
      const oversized = matchOf(it) === 'unlisted' ? OVERSIZED_REASON : '';
      const hay = fold(`${it.name} ${it.set} ${it.setName} ${it.cn} ${it.doc?.title ?? ''} ${it.bulkReason ?? ''} ${it.matchNote ?? ''} ${it.error ?? ''} ${oversized}`);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    if (f.category !== 'all' && categoryOf(it) !== f.category) return false;
    if (sets.size && !sets.has(it.set)) return false;
    if (fins.size && !fins.has(it.finish)) return false;
    if (rars.size && !rars.has(it.rarity)) return false;
    if (states.size && !states.has(itemState(it))) return false;
    const buy = it.buyCash ?? null;
    if (f.minBuy != null && (buy == null || buy < f.minBuy)) return false;
    if (f.maxBuy != null && (buy == null || buy > f.maxBuy)) return false;
    const pctCash = pctOf(it, 'pctCash');
    if (f.minPct != null && (pctCash == null || pctCash < f.minPct)) return false;
    if (f.maxPct != null && (pctCash == null || pctCash > f.maxPct)) return false;
    if (f.minQty != null && it.qty < f.minQty) return false;
    const hasStock = (it.stock ?? 0) > 0;
    if (f.stock === 'in' && !hasStock) return false;
    if (f.stock === 'out' && hasStock) return false;
    if (f.problems && !isProblem(it)) return false;
    if (f.noted && !nameNote(it)) return false;
    return true;
  });
}

const CATEGORY_ORDER: Record<Category, number> = { buylist: 0, bulk: 1, not_bought: 2 };
const RARITY_ORDER: Record<string, number> = { common: 0, uncommon: 1, rare: 2, mythic: 3, special: 4, bonus: 5 };

export function sortValue(it: Item, key: SortKey): string | number | null {
  switch (key) {
    case 'category': {
      const c = categoryOf(it);
      return c ? CATEGORY_ORDER[c] : null;
    }
    case 'pctCash':
    case 'pctCredit':
      return pctOf(it, key);
    case 'name':
      return fold(it.name);
    case 'set':
      return fold(it.setName || it.set);
    case 'cn':
      return it.cn;
    case 'finish':
      return it.finish;
    case 'rarity':
      return RARITY_ORDER[it.rarity] ?? null;
    case 'qty':
      return it.qty;
    case 'lineCash':
      return it.buyCash == null ? null : it.buyCash * it.qty;
    case 'lineCredit':
      return it.buyCredit == null ? null : it.buyCredit * it.qty;
    default: {
      const v = it[key];
      return typeof v === 'number' ? v : null;
    }
  }
}

/** Stable sort; empty values count as the smallest (first ascending, last descending). Ties are broken by name. */
export function applySort(items: Item[], s: Sort): Item[] {
  const sign = s.dir === 'asc' ? 1 : -1;
  return items
    .map((it, i) => ({ it, i, v: sortValue(it, s.key) }))
    .sort((a, b) => compareValues(a.v, b.v) * sign || a.it.name.localeCompare(b.it.name) || a.i - b.i)
    .map((x) => x.it);
}
