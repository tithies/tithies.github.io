import type { ExportItem } from '@/lib/export/types';
import type { ComparisonRow } from './compare';

/** A comparison row as an export item: the copies that differ (|diff|). */
export const rowToItem = (r: ComparisonRow): ExportItem => ({
  key: r.key,
  cardId: r.cardId,
  scryfallId: r.scryfallId,
  name: r.name,
  set: r.set,
  setName: r.setName,
  cn: r.cn,
  finish: r.finish,
  qty: Math.abs(r.diff),
  note: r.kind === 'missing' ? 'Missing from collection' : 'Not in any deck',
});
