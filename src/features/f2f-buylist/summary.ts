import { categoryOf, emptyTotals, matchOf, type Item, type RunTotals } from './types';

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Per-card buy ÷ F2F price, in % (each print counts once). */
export interface PctStats {
  /** Prints with an F2F price (the others have no ratio). */
  cards: number;
  medianCash: number | null;
  meanCash: number | null;
  medianCredit: number | null;
  meanCredit: number | null;
}

export interface BuySellStats {
  buylist: PctStats;
  bulk: PctStats;
  /** F2F buys and bulk together (cards F2F doesn't buy have no ratio). */
  all: PctStats;
}

const statsOf = (cash: number[], credit: number[]): PctStats => ({
  cards: cash.length,
  medianCash: median(cash),
  meanCash: mean(cash),
  medianCredit: median(credit),
  meanCredit: mean(credit),
});

/** Per-card buy ÷ sell % of a run's checked cards, for F2F buys, bulk, and both. Pure. */
export function buySellStats(items: readonly Item[]): BuySellStats {
  const pcts = { buylist: { cash: [] as number[], credit: [] as number[] }, bulk: { cash: [] as number[], credit: [] as number[] } };
  for (const it of items) {
    if (it.status !== 'done') continue;
    const category = categoryOf(it);
    if (category !== 'buylist' && category !== 'bulk') continue;
    if (it.pctCash != null) pcts[category].cash.push(it.pctCash);
    if (it.pctCredit != null) pcts[category].credit.push(it.pctCredit);
  }
  const { buylist, bulk } = pcts;
  return {
    buylist: statsOf(buylist.cash, buylist.credit),
    bulk: statsOf(bulk.cash, bulk.credit),
    all: statsOf([...buylist.cash, ...bulk.cash], [...buylist.credit, ...bulk.credit]),
  };
}

/** Aggregates a run's items. Pure: used by the runner (stored totals) and the dashboard (live view). */
export function summarize(items: Item[], entries = 0): RunTotals {
  const t = emptyTotals();
  t.entries = entries;
  t.prints = items.length;
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
  const { buylist } = buySellStats(items);
  t.medianPctCash = buylist.medianCash;
  t.meanPctCash = buylist.meanCash;
  t.medianPctCredit = buylist.medianCredit;
  t.meanPctCredit = buylist.meanCredit;
  return t;
}
