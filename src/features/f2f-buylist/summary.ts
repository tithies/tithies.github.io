import { categoryOf, emptyTotals, matchOf, type Item, type RunTotals } from './types';

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Aggregates a run's items. Pure: used by the runner (stored totals) and the dashboard (live view). */
export function summarize(items: Item[], entries = 0): RunTotals {
  const t = emptyTotals();
  t.entries = entries;
  t.prints = items.length;
  const pcts: number[] = [];
  const pctsCredit: number[] = [];
  for (const it of items) {
    t.copies += it.qty;
    if (it.status === 'error') t.errors++;
    if (it.status !== 'done') continue;
    t.done++;
    const match = matchOf(it);
    if (match === 'not_found') t.notFound++;
    if (match === 'unlisted') t.unlisted++;
    if (match === 'loose') t.loose++;
    if (match === 'price_check') t.priceCheck++;
    const retail = it.retail != null ? it.qty * it.retail : null;
    const category = categoryOf(it);
    if (category === 'buylist') {
      t.buylistPrints++;
      t.buylistCopies += it.qty;
      t.buylistCash += it.qty * (it.buyCash ?? 0);
      t.buylistCredit += it.qty * (it.buyCredit ?? 0);
      if (retail != null) {
        t.buylistRetail += retail;
        t.buylistCashWithRetail += it.qty * (it.buyCash ?? 0);
        t.buylistCreditWithRetail += it.qty * (it.buyCredit ?? 0);
      } else t.buylistNoRetail++;
      if (it.pctCash != null) pcts.push(it.pctCash);
      if (it.pctCredit != null) pctsCredit.push(it.pctCredit);
    } else if (category === 'bulk') {
      t.bulkPrints++;
      t.bulkCopies += it.qty;
      t.bulkCash += it.qty * (it.buyCash ?? 0);
      t.bulkCredit += it.qty * (it.buyCredit ?? 0);
      if (retail != null) {
        t.bulkRetail += retail;
        t.bulkCashWithRetail += it.qty * (it.buyCash ?? 0);
        t.bulkCreditWithRetail += it.qty * (it.buyCredit ?? 0);
      }
    }
  }
  t.medianPctCash = median(pcts);
  t.meanPctCash = mean(pcts);
  t.medianPctCredit = median(pctsCredit);
  t.meanPctCredit = mean(pctsCredit);
  return t;
}
