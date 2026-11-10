/**
 * Decks vs collection, by exact print (set + collector number + finish, like the F2F buylist).
 * Deck copies are summed over every included deck: each physical copy is expected to live in one deck.
 */
import type { DeckCardsRow, DeckRow } from '@/lib/decks/types';
import { printKey, type MoxCard, type MoxEntry, type MoxFinish } from '@/lib/moxfield/normalize';

/** missing = in decks, not (enough) in the collection; unassigned = in the collection, not (enough) in decks. */
export type MismatchKind = 'missing' | 'unassigned';

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
  finish: MoxFinish;
  /** That print's collection − decks. */
  diff: number;
  /** Same set and number: only the finish differs. */
  sameCn: boolean;
}

export interface MismatchRow {
  key: string;
  kind: MismatchKind;
  name: string;
  set: string;
  setName: string;
  cn: string;
  finish: MoxFinish;
  rarity: string;
  typeLine: string;
  scryfallId: string;
  deckQty: number;
  collectionQty: number;
  /** collection − decks (< 0: missing, > 0: unassigned). */
  diff: number;
  decks: DeckUse[];
  otherPrints: OtherPrint[];
}

export interface CompareOptions {
  excludedDeckIds: readonly string[];
  ignoredBoards: readonly string[];
  ignoreProxies: boolean;
}

export interface CompareSummary {
  decksIncluded: number;
  /** Included decks whose cards were never read (sync not finished or failed). */
  decksWithoutCards: number;
  deckCopies: number;
  collectionCopies: number;
  /** Copies present on both sides. */
  matchedCopies: number;
  missingPrints: number;
  missingCopies: number;
  unassignedPrints: number;
  unassignedCopies: number;
  /** Rows with at least one other-print hint. */
  hinted: number;
  proxiesSkipped: { decks: number; collection: number };
  /** Collection copies for MTGO / Arena. */
  nonPaperSkipped: number;
}

interface Acc {
  key: string;
  card: MoxCard;
  finish: MoxFinish;
  deckQty: number;
  collectionQty: number;
  decks: Map<string, DeckUse>;
}

const nameKey = (name: string) => name.trim().toLowerCase();

export function compareDecksToCollection(
  decks: readonly DeckRow[],
  deckCards: readonly DeckCardsRow[],
  collection: readonly MoxEntry[],
  opts: CompareOptions,
): { rows: MismatchRow[]; summary: CompareSummary } {
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
    missingPrints: 0,
    missingCopies: 0,
    unassignedPrints: 0,
    unassignedCopies: 0,
    hinted: 0,
    proxiesSkipped: { decks: 0, collection: 0 },
    nonPaperSkipped: 0,
  };

  const slot = (card: MoxCard, finish: MoxFinish): Acc => {
    const key = printKey(card.set, card.cn, finish);
    let a = acc.get(key);
    if (!a) {
      a = { key, card, finish, deckQty: 0, collectionQty: 0, decks: new Map() };
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
      if (opts.ignoreProxies && c.isProxy) {
        summary.proxiesSkipped.decks += c.qty;
        continue;
      }
      const a = slot(c.card, c.finish);
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
    if (opts.ignoreProxies && e.isProxy) {
      summary.proxiesSkipped.collection += e.qty;
      continue;
    }
    // Every language and condition of a print counts: decks don't record either.
    const a = slot(e.card, e.finish);
    a.collectionQty += e.qty;
    summary.collectionCopies += e.qty;
  }

  const rows: MismatchRow[] = [];
  for (const a of acc.values()) {
    summary.matchedCopies += Math.min(a.deckQty, a.collectionQty);
    const diff = a.collectionQty - a.deckQty;
    if (diff === 0) continue;
    const kind: MismatchKind = diff < 0 ? 'missing' : 'unassigned';
    if (kind === 'missing') {
      summary.missingPrints++;
      summary.missingCopies -= diff;
    } else {
      summary.unassignedPrints++;
      summary.unassignedCopies += diff;
    }
    rows.push({
      key: a.key,
      kind,
      name: a.card.name,
      set: a.card.set,
      setName: a.card.setName,
      cn: a.card.cn,
      finish: a.finish,
      rarity: a.card.rarity,
      typeLine: a.card.typeLine,
      scryfallId: a.card.scryfallId,
      deckQty: a.deckQty,
      collectionQty: a.collectionQty,
      diff,
      decks: [...a.decks.values()].sort((x, y) => y.qty - x.qty),
      otherPrints: [],
    });
  }

  // Same card, opposite mismatch elsewhere: "deck uses DMU 435 foil, collection has DMU 435 non-foil".
  const byName = new Map<string, MismatchRow[]>();
  for (const r of rows) {
    const k = nameKey(r.name);
    const list = byName.get(k);
    if (list) list.push(r);
    else byName.set(k, [r]);
  }
  for (const r of rows) {
    const others = byName.get(nameKey(r.name))!.filter((o) => o !== r && Math.sign(o.diff) !== Math.sign(r.diff));
    r.otherPrints = others
      .map((o) => ({ key: o.key, set: o.set, setName: o.setName, cn: o.cn, finish: o.finish, diff: o.diff, sameCn: o.set === r.set && o.cn === r.cn }))
      .sort((x, y) => Number(y.sameCn) - Number(x.sameCn) || Math.abs(y.diff) - Math.abs(x.diff));
    if (r.otherPrints.length) summary.hinted++;
  }

  rows.sort((x, y) => x.name.localeCompare(y.name) || x.set.localeCompare(y.set) || x.cn.localeCompare(y.cn, undefined, { numeric: true }));
  return { rows, summary };
}
