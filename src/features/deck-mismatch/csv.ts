import Papa from 'papaparse';
import type { MismatchRow } from './compare';

export function mismatchesToCsv(rows: MismatchRow[], deckName: (id: string) => string, boardLabel: (board: string) => string): string {
  return Papa.unparse(
    rows.map((r) => ({
      mismatch: r.kind === 'missing' ? 'missing_from_collection' : 'not_in_any_deck',
      name: r.name,
      set: r.set.toUpperCase(),
      set_name: r.setName,
      collector_number: r.cn,
      finish: r.finish,
      rarity: r.rarity,
      deck_qty: r.deckQty,
      collection_qty: r.collectionQty,
      difference: r.diff,
      decks: r.decks.map((d) => `${deckName(d.deckId)}${d.board === 'mainboard' ? '' : ` (${boardLabel(d.board)})`} ×${d.qty}`).join(' | '),
      other_prints: r.otherPrints.map((o) => `${o.set.toUpperCase()} ${o.cn} ${o.finish} ${o.diff > 0 ? '+' : ''}${o.diff}`).join(' | '),
    })),
  );
}

export function downloadMismatchCsv(rows: MismatchRow[], deckName: (id: string) => string, boardLabel: (board: string) => string, suffix = '') {
  const blob = new Blob([mismatchesToCsv(rows, deckName, boardLabel)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tithies-deck-mismatches${suffix}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
