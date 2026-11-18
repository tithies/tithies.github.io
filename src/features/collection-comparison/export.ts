import type { ExportItem } from '@/lib/export/types';
import { langLabel, sortLangs } from '@/lib/cards/languages';
import type { ComparisonRow } from './compare';

/** Copies a row exports: its own copies (missing, in no deck, or on both sides for a match). */
export const exportQty = (r: ComparisonRow): number => r.copies;

const NOTE: Record<ComparisonRow['kind'], string> = { missing: 'Missing from collection', unassigned: 'Not in any deck', match: 'Matching' };

/**
 * The row's copies by language (their Language field: what the export writes). Decks have no
 * Language field, so a deck-only copy ("missing") is in its print's language. When the print's
 * collection copies have several Language fields (some disagree with the print) and decks use only
 * some of them, decks are assumed to use the copies in the print's language first, then the most
 * common languages: the rest are "not in a deck".
 */
export function rowLanguages(r: ComparisonRow): { langs: [string, number][]; guessed: boolean } {
  if (r.kind === 'missing') return { langs: [[r.lang, r.copies]], guessed: false };
  const owned = Object.entries(r.langs).filter(([, n]) => n > 0);
  if (owned.length <= 1) return { langs: [[owned[0]?.[0] ?? r.lang, r.copies]], guessed: false };
  const order = sortLangs(owned.map(([l]) => l)).sort((a, b) => Number(b === r.lang) - Number(a === r.lang) || (r.langs[b] ?? 0) - (r.langs[a] ?? 0));
  let deckLeft = r.deckQty;
  const inDecks = new Map<string, number>();
  for (const l of order) {
    const used = Math.min(deckLeft, r.langs[l]);
    inDecks.set(l, used);
    deckLeft -= used;
  }
  const langs: [string, number][] = order
    .map((l): [string, number] => [l, r.kind === 'match' ? inDecks.get(l)! : r.langs[l] - inDecks.get(l)!])
    .filter(([, n]) => n > 0);
  // Exact when every collection copy is in the row (no deck uses one, or decks use them all).
  const guessed = r.deckQty > 0 && r.deckQty < r.collectionQty;
  return { langs, guessed };
}

/**
 * A comparison row as export items: one per language. Nearly every row has one language, and its
 * item has the row's key; a row whose copies have several Language fields gets one item per
 * language ("row key|fr").
 */
export function rowToItems(r: ComparisonRow): ExportItem[] {
  const { langs, guessed } = rowLanguages(r);
  // The print itself (its card object and language): exported as that exact print where the site can.
  const base = { cardId: r.cardId, scryfallId: r.scryfallId, name: r.name, set: r.set, setName: r.setName, cn: r.cn, finish: r.finish, printLang: r.lang };
  if (langs.length === 1) return [{ ...base, key: r.key, lang: langs[0][0], qty: langs[0][1], note: NOTE[r.kind] }];
  const split = langs.map(([l, n]) => `${n} ${langLabel(l)}`).join(', ');
  const note = `${NOTE[r.kind]} · ${guessed ? `languages guessed (decks record none): ${split}` : split}`;
  return langs.map(([l, n]) => ({ ...base, key: `${r.key}|${l}`, lang: l, qty: n, note }));
}

/** The export list keys of a row's items. */
export const rowItemKeys = (r: ComparisonRow): string[] => rowToItems(r).map((i) => i.key);
