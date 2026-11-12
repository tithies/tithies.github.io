import type { CollectionEntry, Finish, PrintGroup } from './types';

/** Keeps English, non-proxy, paper rows; the Selling feature ignores everything else. */
export function isEligible(e: CollectionEntry): boolean {
  return e.lang === 'en' && !e.isProxy && e.qty > 0 && Boolean(e.card.set) && Boolean(e.card.cn);
}

export function printKey(set: string, cn: string, finish: Finish): string {
  return `${set.toLowerCase()}|${cn.toLowerCase()}|${finish}`;
}

/** Groups eligible entries by exact print (set + collector number + finish). */
export function groupPrints(entries: CollectionEntry[]): PrintGroup[] {
  const map = new Map<string, PrintGroup>();
  const seen = new Set<string>();
  for (const e of entries) {
    if (!isEligible(e) || (e.id && seen.has(e.id))) continue;
    if (e.id) seen.add(e.id);
    const key = printKey(e.card.set, e.card.cn, e.finish);
    let g = map.get(key);
    if (!g) {
      g = { key, qty: 0, entryIds: [], conditions: {}, alters: 0, finish: e.finish, card: e.card };
      map.set(key, g);
    }
    g.qty += e.qty;
    if (e.id) g.entryIds.push(e.id);
    g.conditions[e.condition] = (g.conditions[e.condition] ?? 0) + e.qty;
    if (e.isAlter) g.alters += e.qty;
  }
  return [...map.values()];
}
