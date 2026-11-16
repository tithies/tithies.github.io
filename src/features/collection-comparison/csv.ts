import Papa from 'papaparse';
import type { ComparisonRow } from './compare';

export function comparisonToCsv(rows: ComparisonRow[], deckName: (id: string) => string, boardLabel: (board: string) => string): string {
  return Papa.unparse(
    rows.map((r) => ({
      kind: r.kind === 'missing' ? 'missing_from_collection' : r.kind === 'unassigned' ? 'not_in_any_deck' : 'match',
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

export function downloadComparisonCsv(rows: ComparisonRow[], deckName: (id: string) => string, boardLabel: (board: string) => string, suffix = '') {
  const blob = new Blob([comparisonToCsv(rows, deckName, boardLabel)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tithies-collection-comparison${suffix}-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
