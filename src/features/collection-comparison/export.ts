import type { ExportItem } from '@/lib/export/types';
import type { ComparisonRow } from './compare';

/** Copies a row exports: the difference, or for a match its copies (as many in decks as in the collection). */
export const exportQty = (r: ComparisonRow): number => (r.diff === 0 ? r.deckQty : Math.abs(r.diff));

/** A comparison row as an export item. */
export const rowToItem = (r: ComparisonRow): ExportItem => ({
  key: r.key,
  cardId: r.cardId,
  scryfallId: r.scryfallId,
  name: r.name,
  set: r.set,
  setName: r.setName,
  cn: r.cn,
  finish: r.finish,
  qty: exportQty(r),
  note: r.kind === 'missing' ? 'Missing from collection' : r.kind === 'unassigned' ? 'Not in any deck' : 'Matching',
});
