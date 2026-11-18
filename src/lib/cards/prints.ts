import { langOf, printLangMismatch } from './languages';
import type { CollectionEntry, Finish, PrintGroup } from './types';

/** Keeps non-proxy paper rows with a known print (every language); the Selling feature ignores everything else. */
export function isEligible(e: CollectionEntry): boolean {
  return !e.isProxy && e.qty > 0 && Boolean(e.card.set) && Boolean(e.card.cn);
}

/** Copies a check of the whole collection covers: paper (not MTGO or Arena), non-proxy, with a known print. */
export const isSellable = (e: CollectionEntry): boolean => isEligible(e) && (!e.game || e.game === 'paper');

export function printKey(set: string, cn: string, finish: Finish): string {
  return `${set.toLowerCase()}|${cn.toLowerCase()}|${finish}`;
}

/** A print in one language: `printKey` + "|fr". */
export function copyKey(set: string, cn: string, finish: Finish, lang: string | null | undefined): string {
  return `${printKey(set, cn, finish)}|${langOf({ lang })}`;
}

/** Groups eligible entries by exact print (set + collector number + finish) and language (the entries' Language field). */
export function groupPrints(entries: CollectionEntry[]): PrintGroup[] {
  const map = new Map<string, PrintGroup>();
  const seen = new Set<string>();
  for (const e of entries) {
    if (!isEligible(e) || (e.id && seen.has(e.id))) continue;
    if (e.id) seen.add(e.id);
    const lang = langOf(e);
    const key = copyKey(e.card.set, e.card.cn, e.finish, lang);
    let g = map.get(key);
    if (!g) {
      g = { key, lang, qty: 0, entryIds: [], conditions: {}, alters: 0, mismatchCopies: 0, finish: e.finish, card: e.card };
      map.set(key, g);
    }
    g.qty += e.qty;
    if (e.id) g.entryIds.push(e.id);
    g.conditions[e.condition] = (g.conditions[e.condition] ?? 0) + e.qty;
    if (e.isAlter) g.alters += e.qty;
    const printLang = printLangMismatch(e);
    if (printLang) {
      g.mismatchCopies += e.qty;
      g.printLang ??= printLang;
    }
  }
  return [...map.values()];
}
