import type { ExportItem } from '@/lib/export/types';
import type { ComparisonRow } from './compare';

/** Copies a row exports: its own copies (missing, in no deck, or on both sides for a match). */
export const exportQty = (r: ComparisonRow): number => r.copies;

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
