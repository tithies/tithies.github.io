/**
 * The export list: what a page will export, print by print with a quantity. It lives in the
 * page's state only (each page has its own; leaving the page empties it).
 */
import { useCallback, useMemo, useReducer } from 'react';
import type { ExportItem } from './types';

export type ExportListState = ReadonlyMap<string, ExportItem>;

export type ExportListAction =
  /** Adds the items not in the list yet (those already in it keep their quantity). */
  | { type: 'add'; items: readonly ExportItem[] }
  | { type: 'remove'; keys: readonly string[] }
  /** Below 1: removed. */
  | { type: 'setQty'; key: string; qty: number }
  | { type: 'clear' };

export const MAX_EXPORT_QTY = 9999;

export function exportListReducer(state: ExportListState, a: ExportListAction): ExportListState {
  switch (a.type) {
    case 'add': {
      const fresh = a.items.filter((i) => i.qty > 0 && !state.has(i.key));
      if (!fresh.length) return state;
      const next = new Map(state);
      for (const i of fresh) next.set(i.key, { ...i, qty: Math.min(MAX_EXPORT_QTY, Math.round(i.qty)) });
      return next;
    }
    case 'remove': {
      if (!a.keys.some((k) => state.has(k))) return state;
      const next = new Map(state);
      for (const k of a.keys) next.delete(k);
      return next;
    }
    case 'setQty': {
      const item = state.get(a.key);
      if (!item) return state;
      const next = new Map(state);
      const qty = Math.min(MAX_EXPORT_QTY, Math.floor(a.qty));
      if (!(qty >= 1)) next.delete(a.key);
      else next.set(a.key, { ...item, qty });
      return next;
    }
    case 'clear':
      return state.size ? new Map() : state;
  }
}

export function exportListTotals(state: ExportListState): { prints: number; copies: number } {
  let copies = 0;
  for (const i of state.values()) copies += i.qty;
  return { prints: state.size, copies };
}

export interface ExportList {
  items: ExportItem[];
  prints: number;
  copies: number;
  has(key: string): boolean;
  get(key: string): ExportItem | undefined;
  add(items: readonly ExportItem[]): void;
  remove(keys: readonly string[]): void;
  setQty(key: string, qty: number): void;
  clear(): void;
}

export function useExportList(): ExportList {
  const [state, dispatch] = useReducer(exportListReducer, new Map() as ExportListState);
  const add = useCallback((items: readonly ExportItem[]) => dispatch({ type: 'add', items }), []);
  const remove = useCallback((keys: readonly string[]) => dispatch({ type: 'remove', keys }), []);
  const setQty = useCallback((key: string, qty: number) => dispatch({ type: 'setQty', key, qty }), []);
  const clear = useCallback(() => dispatch({ type: 'clear' }), []);
  return useMemo(() => {
    const t = exportListTotals(state);
    return {
      items: [...state.values()],
      ...t,
      has: (k: string) => state.has(k),
      get: (k: string) => state.get(k),
      add,
      remove,
      setQty,
      clear,
    };
  }, [state, add, remove, setQty, clear]);
}
