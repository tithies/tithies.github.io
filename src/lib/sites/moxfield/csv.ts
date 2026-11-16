/**
 * Moxfield's collection CSV ("moxfield" import format), as its own "Export CSV" writes it
 * (verified 2026-11-16): 13 columns, every field quoted, Foil = "" | "foil" | "etched",
 * Edition = the lowercase set code, double-faced names as "Front // Back".
 * Pure: imported by the page hook (to check an import) and the background (to build one).
 */
import type { Finish } from '@/lib/cards/types';

export const MOX_CSV_COLUMNS = [
  'Count',
  'Tradelist Count',
  'Name',
  'Edition',
  'Condition',
  'Language',
  'Foil',
  'Tags',
  'Last Modified',
  'Collector Number',
  'Alter',
  'Proxy',
  'Purchase Price',
] as const;

const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;

export const MOX_CSV_HEADER = MOX_CSV_COLUMNS.map(quote).join(',');

export interface MoxCsvRow {
  qty: number;
  name: string;
  /** Set code (any case: written lowercase). */
  set: string;
  cn: string;
  finish: Finish;
  /** Default "Near Mint". */
  condition?: string;
  /** Default "English". */
  language?: string;
  isProxy?: boolean;
  isAlter?: boolean;
}

const FOIL: Record<Finish, string> = { nonFoil: '', foil: 'foil', etched: 'etched' };

export function toMoxCsv(rows: readonly MoxCsvRow[]): string {
  const lines = [MOX_CSV_HEADER];
  for (const r of rows) {
    if (!(r.qty >= 1) || !Number.isInteger(r.qty)) throw new Error(`Bad quantity for ${r.name}: ${r.qty}`);
    const qty = String(r.qty);
    lines.push(
      [
        qty,
        qty,
        r.name,
        r.set.toLowerCase(),
        r.condition ?? 'Near Mint',
        r.language ?? 'English',
        FOIL[r.finish],
        '',
        '',
        r.cn,
        r.isAlter ? 'True' : 'False',
        r.isProxy ? 'True' : 'False',
        '',
      ]
        .map(quote)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}
