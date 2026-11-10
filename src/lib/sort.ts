/** Table sorting shared by every dashboard page. */

export type SortValue = string | number | null | undefined;

const isNone = (v: SortValue) => v == null || v === '' || (typeof v === 'number' && Number.isNaN(v));

/**
 * Ascending comparison where "none" (null, undefined, '', NaN) is the smallest value: flipped by the
 * caller for descending, so empty cells come first when ascending and last when descending.
 */
export function compareValues(a: SortValue, b: SortValue): number {
  const an = isNone(a);
  const bn = isNone(b);
  if (an || bn) return an === bn ? 0 : an ? -1 : 1;
  return typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true });
}
