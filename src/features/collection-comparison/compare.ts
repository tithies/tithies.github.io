/**
 * Decks vs collection, by exact print: set + collector number + finish + the print's language
 * (Moxfield has one card object per print and language, and deck cards point to one: a deck's
 * French Talisman is the French print). Deck cards have no Language field, so a collection copy is
 * matched by its print too, even when its Language field says otherwise (that copy gets a warning).
 * Deck copies are summed over every included deck: each physical copy is expected to live in one deck.
 * Proxy copies are left out on both sides (counted in the summary).
 */
import type { DeckCardsRow, DeckRow } from '@/lib/decks/types';
import { copyKey } from '@/lib/cards/prints';
import { langOf } from '@/lib/cards/languages';
import type { CardPrint, CollectionEntry, Finish } from '@/lib/cards/types';

/**
 * missing = in decks, not (enough) in the collection; unassigned = in the collection, not (enough)
 * in decks; match = as many copies in decks as in the collection.
 */
export type ComparisonKind = 'missing' | 'unassigned' | 'match';

export interface DeckUse {
  deckId: string;
  board: string;
  qty: number;
}

/** Another print of the same card with the opposite mismatch: probably the print to fix. */
export interface OtherPrint {
  key: string;
  set: string;
  setName: string;
  cn: string;
  finish: Finish;
  /** That print's language. */
  lang: string;
  /** That print's collection − decks. */
  diff: number;
  /** Same set and number: only the finish or the language differs. */
  sameCn: boolean;
  /** The decks that use that print (where to fix it when decks use the wrong one). */
  decks: DeckUse[];
}

/**
 * One group of copies of one print. A print gives up to two rows: its copies on both sides (a
 * match), and the difference (missing, or in no deck). So every copy lands in exactly one kind.
 */
export interface ComparisonRow {
  /** Unique per row: the print key, with "|match" for the matching part. */
  key: string;
  /** The print (set|cn|finish|lang), the same for both rows of a print. */
  printKey: string;
  kind: ComparisonKind;
  name: string;
  set: string;
  setName: string;
  cn: string;
  finish: Finish;
  /** The print's language (deck and collection copies alike). */
  lang: string;
  /** The print's collection copies by their Language field (what an export writes). */
  langs: Record<string, number>;
  /** Collection copies of the print whose Language field isn't the print's language (a warning). */
  mismatchCopies: number;
  rarity: string;
  typeLine: string;
  scryfallId: string;
  /** The site's card id (Moxfield's), for exports. */
  cardId: string;
  /** The print's copies in the included decks, and in the collection (the same on both rows of a print). */
  deckQty: number;
  collectionQty: number;
  /** The print's collection − decks (< 0: missing copies, > 0: copies in no deck, 0: everything matches). */
  diff: number;
  /** The copies this row stands for: those on both sides (match), missing, or in no deck. */
  copies: number;
  decks: DeckUse[];
  otherPrints: OtherPrint[];
}

export interface CompareOptions {
  excludedDeckIds: readonly string[];
  ignoredBoards: readonly string[];
}

export interface CompareSummary {
  decksIncluded: number;
  /** Included decks whose cards were never read (sync not finished or failed). */
  decksWithoutCards: number;
  deckCopies: number;
  collectionCopies: number;
  /** Copies present on both sides (the match rows' copies). */
  matchedCopies: number;
  /** Prints with copies on both sides (match rows); `exactPrints` of them have no difference at all. */
  matchedPrints: number;
  exactPrints: number;
  missingPrints: number;
  missingCopies: number;
  unassignedPrints: number;
  unassignedCopies: number;
  /** Rows with at least one other-print hint. */
  hinted: number;
  /** Proxy copies left out (always, on both sides). */
  proxiesSkipped: { decks: number; collection: number };
  /** Collection copies for MTGO / Arena. */
  nonPaperSkipped: number;
}

interface Acc {
  key: string;
  /** The print's card: a collection copy's when there is one (a deck card read from a group of copies may lack some fields). */
  card: CardPrint;
  cardFromCollection: boolean;
  finish: Finish;
  lang: string;
  deckQty: number;
  collectionQty: number;
  langs: Record<string, number>;
  mismatchCopies: number;
  decks: Map<string, DeckUse>;
}

const nameKey = (name: string) => name.trim().toLowerCase();

export function compareDecksToCollection(
  decks: readonly DeckRow[],
  deckCards: readonly DeckCardsRow[],
  collection: readonly CollectionEntry[],
  opts: CompareOptions,
): { rows: ComparisonRow[]; summary: CompareSummary } {
  const excluded = new Set(opts.excludedDeckIds);
  const ignoredBoards = new Set(opts.ignoredBoards);
  const cardsByDeck = new Map(deckCards.map((r) => [r.deckId, r]));
  const acc = new Map<string, Acc>();
  const summary: CompareSummary = {
    decksIncluded: 0,
    decksWithoutCards: 0,
    deckCopies: 0,
    collectionCopies: 0,
    matchedCopies: 0,
    matchedPrints: 0,
    exactPrints: 0,
    missingPrints: 0,
    missingCopies: 0,
    unassignedPrints: 0,
    unassignedCopies: 0,
    hinted: 0,
    proxiesSkipped: { decks: 0, collection: 0 },
    nonPaperSkipped: 0,
  };

  const slot = (card: CardPrint, finish: Finish, printLang: string): Acc => {
    const lang = langOf({ lang: printLang });
    const key = copyKey(card.set, card.cn, finish, lang);
    let a = acc.get(key);
    if (!a) {
      a = { key, card, cardFromCollection: false, finish, lang, deckQty: 0, collectionQty: 0, langs: {}, mismatchCopies: 0, decks: new Map() };
      acc.set(key, a);
    }
    return a;
  };

  for (const deck of decks) {
    if (excluded.has(deck.id)) continue;
    summary.decksIncluded++;
    const row = cardsByDeck.get(deck.id);
    if (!row) {
      summary.decksWithoutCards++;
      continue;
    }
    for (const c of row.cards) {
      if (ignoredBoards.has(c.board) || c.qty <= 0 || !c.card.set || !c.card.cn) continue;
      if (c.isProxy) {
        summary.proxiesSkipped.decks += c.qty;
        continue;
      }
      // A deck copy's language is its print's (decks read before Tithies kept it: English).
      const a = slot(c.card, c.finish, langOf(c.card));
      a.deckQty += c.qty;
      summary.deckCopies += c.qty;
      const useKey = `${deck.id}|${c.board}`;
      const use = a.decks.get(useKey);
      if (use) use.qty += c.qty;
      else a.decks.set(useKey, { deckId: deck.id, board: c.board, qty: c.qty });
    }
  }

  const seen = new Set<string>();
  for (const e of collection) {
    if (e.id) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
    }
    if (e.qty <= 0 || !e.card.set || !e.card.cn) continue;
    if (e.game && e.game !== 'paper') {
      summary.nonPaperSkipped += e.qty;
      continue;
    }
    if (e.isProxy) {
      summary.proxiesSkipped.collection += e.qty;
      continue;
    }
    // Every condition counts (decks don't record it). The print's language decides the match;
    // a snapshot read before Tithies kept it falls back to the Language field.
    const lang = langOf(e);
    const a = slot(e.card, e.finish, e.card.lang || lang);
    if (!a.cardFromCollection) {
      a.card = e.card;
      a.cardFromCollection = true;
    }
    a.collectionQty += e.qty;
    a.langs[lang] = (a.langs[lang] ?? 0) + e.qty;
    if (lang !== a.lang) a.mismatchCopies += e.qty;
    summary.collectionCopies += e.qty;
  }

  const rows: ComparisonRow[] = [];
  for (const a of acc.values()) {
    const matched = Math.min(a.deckQty, a.collectionQty);
    const diff = a.collectionQty - a.deckQty;
    const row = (kind: ComparisonKind, copies: number): ComparisonRow => ({
      key: kind === 'match' ? `${a.key}|match` : a.key,
      printKey: a.key,
      kind,
      name: a.card.name,
      set: a.card.set,
      setName: a.card.setName,
      cn: a.card.cn,
      finish: a.finish,
      lang: a.lang,
      langs: a.langs,
      mismatchCopies: a.mismatchCopies,
      rarity: a.card.rarity,
      typeLine: a.card.typeLine,
      scryfallId: a.card.scryfallId,
      cardId: a.card.id,
      deckQty: a.deckQty,
      collectionQty: a.collectionQty,
      diff,
      copies,
      decks: [...a.decks.values()].sort((x, y) => y.qty - x.qty),
      otherPrints: [],
    });
    if (matched > 0) {
      summary.matchedCopies += matched;
      summary.matchedPrints++;
      if (diff === 0) summary.exactPrints++;
      rows.push(row('match', matched));
    }
    if (diff < 0) {
      summary.missingPrints++;
      summary.missingCopies -= diff;
      rows.push(row('missing', -diff));
    } else if (diff > 0) {
      summary.unassignedPrints++;
      summary.unassignedCopies += diff;
      rows.push(row('unassigned', diff));
    }
  }

  // Same card, opposite difference elsewhere: "deck uses DMU 435 foil, collection has DMU 435 non-foil".
  // Match rows neither get nor give hints.
  const differing = rows.filter((r) => r.kind !== 'match');
  const byName = new Map<string, ComparisonRow[]>();
  for (const r of differing) {
    const k = nameKey(r.name);
    const list = byName.get(k);
    if (list) list.push(r);
    else byName.set(k, [r]);
  }
  for (const r of differing) {
    const others = byName.get(nameKey(r.name))!.filter((o) => o !== r && Math.sign(o.diff) === -Math.sign(r.diff));
    r.otherPrints = others
      .map((o) => ({ key: o.printKey, set: o.set, setName: o.setName, cn: o.cn, finish: o.finish, lang: o.lang, diff: o.diff, sameCn: o.set === r.set && o.cn === r.cn, decks: o.decks }))
      .sort((x, y) => Number(y.sameCn) - Number(x.sameCn) || Math.abs(y.diff) - Math.abs(x.diff));
    if (r.otherPrints.length) summary.hinted++;
  }

  rows.sort(
    (x, y) => x.name.localeCompare(y.name) || x.set.localeCompare(y.set) || x.cn.localeCompare(y.cn, undefined, { numeric: true }) || x.key.localeCompare(y.key),
  );
  return { rows, summary };
}
