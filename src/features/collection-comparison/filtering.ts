import { fold } from '@/lib/format';
import { isEnglish, langLabel } from '@/lib/cards/languages';
import { compareValues } from '@/lib/sort';
import type { ComparisonRow } from './compare';

export interface ComparisonFilters {
  q: string;
  sets: string[];
  finishes: string[];
  /** Language codes (the print's). */
  languages: string[];
  /** Only rows with an other-print hint ("likely wrong print"). */
  hinted: boolean;
}

export const EMPTY_COMPARISON_FILTERS: ComparisonFilters = { q: '', sets: [], finishes: [], languages: [], hinted: false };

export const COMPARISON_SORT_KEYS = ['kind', 'name', 'set', 'cn', 'finish', 'deckQty', 'collectionQty', 'diff', 'decks'] as const;
export type ComparisonSortKey = (typeof COMPARISON_SORT_KEYS)[number];
export interface ComparisonSort {
  key: ComparisonSortKey;
  dir: 'asc' | 'desc';
}
export const DEFAULT_COMPARISON_SORT: ComparisonSort = { key: 'name', dir: 'asc' };

const list = (v: string | null) => (v ? v.split(',').filter(Boolean) : []);

export function comparisonFiltersFromParams(p: URLSearchParams): ComparisonFilters {
  return { q: p.get('q') ?? '', sets: list(p.get('sets')), finishes: list(p.get('fin')), languages: list(p.get('lang')), hinted: p.get('hint') === '1' };
}

export function comparisonSortFromParams(p: URLSearchParams): ComparisonSort {
  const key = p.get('sort') as ComparisonSortKey | null;
  const dir = p.get('dir') === 'desc' ? 'desc' : 'asc';
  return key && (COMPARISON_SORT_KEYS as readonly string[]).includes(key) ? { key, dir } : DEFAULT_COMPARISON_SORT;
}

/** Filters, sort and page in the URL (defaults left out). */
export function writeComparisonParams(base: URLSearchParams, f: ComparisonFilters, s: ComparisonSort, page: number): URLSearchParams {
  const p = new URLSearchParams(base);
  const set = (k: string, v: string | number | null | false) => {
    if (v === null || v === '' || v === false) p.delete(k);
    else p.set(k, String(v));
  };
  const isDefault = s.key === DEFAULT_COMPARISON_SORT.key && s.dir === DEFAULT_COMPARISON_SORT.dir;
  set('q', f.q.trim());
  set('sets', f.sets.join(','));
  set('fin', f.finishes.join(','));
  set('lang', f.languages.join(','));
  set('hint', f.hinted ? '1' : null);
  set('sort', isDefault ? null : s.key);
  set('dir', isDefault ? null : s.dir);
  set('page', page > 1 ? page : null);
  return p;
}

export function applyComparisonFilters(rows: ComparisonRow[], f: ComparisonFilters, deckName: (id: string) => string): ComparisonRow[] {
  const terms = fold(f.q).split(/\s+/).filter(Boolean);
  const sets = new Set(f.sets);
  const finishes = new Set(f.finishes);
  const languages = new Set(f.languages);
  return rows.filter((r) => {
    if (sets.size && !sets.has(r.set)) return false;
    if (finishes.size && !finishes.has(r.finish)) return false;
    if (languages.size && !languages.has(r.lang)) return false;
    if (f.hinted && !r.otherPrints.length) return false;
    if (terms.length) {
      const language = isEnglish(r.lang) ? '' : langLabel(r.lang);
      const hay = fold(`${r.name} ${r.set} ${r.setName} ${r.cn} ${language} ${r.decks.map((d) => deckName(d.deckId)).join(' ')}`);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
}

const KIND_ORDER = { missing: 0, unassigned: 1, match: 2 };

/**
 * `decks` sorts by the first deck shown in the row (the one using most copies). Empty values count as
 * the smallest: rows in no deck come first ascending, last descending (like every table in the tool).
 */
export function applyComparisonSort(rows: ComparisonRow[], s: ComparisonSort, deckName: (id: string) => string = () => ''): ComparisonRow[] {
  const dir = s.dir === 'asc' ? 1 : -1;
  const value = (r: ComparisonRow): string | number => {
    switch (s.key) {
      case 'kind':
        return KIND_ORDER[r.kind];
      case 'name':
        return fold(r.name);
      case 'set':
        return fold(r.setName || r.set);
      case 'cn':
        return r.cn;
      case 'finish':
        return r.finish;
      case 'decks':
        return r.decks.length ? fold(deckName(r.decks[0].deckId)) : '';
      case 'diff':
        // The row's copies, signed like the column: missing −, in no deck +, a match as is.
        return r.kind === 'missing' ? -r.copies : r.copies;
      default:
        return r[s.key];
    }
  };
  return [...rows].sort((a, b) => {
    return compareValues(value(a), value(b)) * dir || a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
  });
}
