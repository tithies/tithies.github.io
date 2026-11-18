/**
 * The Selling runs' "Cards in decks" filter: a run's cards minus the copies decks use, by exact
 * print, compared the Comparator's way (set + collector number + finish + the print's language).
 *
 * Copies are counted against the whole collection snapshot: a run read from one binder (or one
 * condition) holds only those copies, while a deck's copy may be another one (the site doesn't say
 * which copy a deck uses). So a print's free copies are its copies (in the collection snapshot, or
 * the run's when it has more, e.g. no snapshot yet) − the copies decks use, capped at the run's.
 * Deck proxies never count: they use no copy of the collection (and runs hold no proxies).
 */
import { compareDecksToCollection, type CompareOptions, type DeckUse } from '@/features/collection-comparison/compare';
import { langOf } from '@/lib/cards/languages';
import { copyKey, isSellable } from '@/lib/cards/prints';
import type { CollectionEntry } from '@/lib/cards/types';
import type { DeckCardsRow, DeckRow } from '@/lib/decks/types';
import type { Item } from './types';

/** Why a row lost copies. */
export interface DeckUsage {
  /** The run's copies of the row. */
  runQty: number;
  /** Of them, the copies left out (decks use them). */
  inDecks: number;
  /** The decks that use the print, most copies first. */
  decks: DeckUse[];
}

export interface FreeCopiesSummary {
  /** Rows left out: decks use every copy. */
  hiddenPrints: number;
  /** Rows shown with fewer copies. */
  reducedPrints: number;
  /** Copies left out. */
  hiddenCopies: number;
  decksIncluded: number;
  /** Included decks whose cards were never read (not counted). */
  decksWithoutCards: number;
  /** A collection snapshot was counted (else only the run's own copies). */
  withCollection: boolean;
}

export interface FreeCopies {
  /** The rows with their free copies only (same order; rows with none left out). */
  items: Item[];
  /** By item key: rows that lost copies. */
  usage: Map<string, DeckUsage>;
  summary: FreeCopiesSummary;
}

/** Some copies of a row, under the language of their print. */
interface Part {
  item: Item;
  key: string;
  qty: number;
  /** The copies' Language field is the print's (false: the row's copies that disagree). */
  exact: boolean;
}

export function freeCopies(
  items: readonly Item[],
  decks: readonly DeckRow[],
  deckCards: readonly DeckCardsRow[],
  collection: readonly CollectionEntry[],
  opts: Pick<CompareOptions, 'excludedDeckIds' | 'ignoredBoards'>,
): FreeCopies {
  const sellable = collection.filter(isSellable);
  const { rows, summary: compared } = compareDecksToCollection(decks, deckCards, sellable, {
    excludedDeckIds: opts.excludedDeckIds,
    ignoredBoards: opts.ignoredBoards,
    ignoreProxies: true,
  });
  // Both rows of a print carry its totals: one is enough.
  const prints = new Map<string, { deckQty: number; collectionQty: number; decks: DeckUse[] }>();
  for (const r of rows) if (r.deckQty > 0 && !prints.has(r.printKey)) prints.set(r.printKey, r);

  // A row is keyed by its copies' Language field; decks by the print's language. Most copies have
  // both the same; a row's copies whose print is in another language are keyed by that print.
  const parts: Part[] = [];
  const runQty = new Map<string, number>();
  const add = (item: Item, lang: string, qty: number, exact: boolean) => {
    if (qty <= 0) return;
    const key = copyKey(item.set, item.cn, item.finish, lang);
    parts.push({ item, key, qty, exact });
    runQty.set(key, (runQty.get(key) ?? 0) + qty);
  };
  for (const it of items) {
    const mismatch = it.printLang ? Math.min(it.mismatchCopies ?? 0, it.qty) : 0;
    add(it, langOf(it), it.qty - mismatch, true);
    if (it.printLang) add(it, it.printLang, mismatch, false);
  }

  // Free copies of each print decks use (prints no deck uses aren't listed: every copy is free).
  const free = new Map<string, number>();
  for (const [key, qty] of runQty) {
    const p = prints.get(key);
    if (p) free.set(key, Math.max(0, Math.max(p.collectionQty, qty) - p.deckQty));
  }

  // Handed out to the copies whose Language field matches first, so no copy is counted twice.
  const kept = new Map<Item, { exact: number; mismatch: number; keys: Set<string> }>();
  for (const pass of [true, false]) {
    for (const part of parts) {
      if (part.exact !== pass) continue;
      const left = free.get(part.key);
      const take = left === undefined ? part.qty : Math.min(part.qty, left);
      if (left !== undefined) free.set(part.key, left - take);
      let k = kept.get(part.item);
      if (!k) kept.set(part.item, (k = { exact: 0, mismatch: 0, keys: new Set() }));
      if (part.exact) k.exact += take;
      else k.mismatch += take;
      k.keys.add(part.key);
    }
  }

  const out: Item[] = [];
  const usage = new Map<string, DeckUsage>();
  const summary: FreeCopiesSummary = {
    hiddenPrints: 0,
    reducedPrints: 0,
    hiddenCopies: 0,
    decksIncluded: compared.decksIncluded,
    decksWithoutCards: compared.decksWithoutCards,
    withCollection: sellable.length > 0,
  };
  for (const it of items) {
    const k = kept.get(it);
    const qty = k ? k.exact + k.mismatch : it.qty;
    if (!k || qty >= it.qty) {
      if (it.qty > 0) out.push(it);
      continue;
    }
    const decksOf = new Map<string, DeckUse>();
    for (const key of k.keys) for (const d of prints.get(key)?.decks ?? []) {
      const id = `${d.deckId}|${d.board}`;
      const seen = decksOf.get(id);
      decksOf.set(id, seen ? { ...seen, qty: seen.qty + d.qty } : d);
    }
    usage.set(it.key, { runQty: it.qty, inDecks: it.qty - qty, decks: [...decksOf.values()].sort((a, b) => b.qty - a.qty) });
    summary.hiddenCopies += it.qty - qty;
    if (qty === 0) {
      summary.hiddenPrints++;
      continue;
    }
    summary.reducedPrints++;
    // The language warning only counts the copies still shown.
    const { mismatchCopies: _m, printLang: _p, ...rest } = it;
    out.push(k.mismatch > 0 ? { ...rest, qty, mismatchCopies: k.mismatch, printLang: it.printLang } : { ...rest, qty });
  }
  return { items: out, usage, summary };
}
