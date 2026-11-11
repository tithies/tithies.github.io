import { summarize } from '@/features/f2f-buylist/summary';
import type { Item } from '@/features/f2f-buylist/types';

const item = (p: Partial<Item>): Item =>
  ({ runId: 1, key: Math.random().toString(), status: 'done', name: 'X', qty: 1, match: 'exact', ...p }) as Item;

describe('summarize', () => {
  const items = [
    item({ category: 'buylist', qty: 2, buyCash: 10, buyCredit: 13, retail: 25, pctCash: 40, pctCredit: 52 }),
    item({ category: 'buylist', qty: 1, buyCash: 5, buyCredit: 6.5, retail: null, pctCash: null }),
    item({ category: 'buylist', qty: 1, buyCash: 3, buyCredit: 3.9, retail: 5, pctCash: 60, pctCredit: 78 }),
    item({ category: 'buylist', qty: 1, buyCash: 1, buyCredit: 1.3, retail: 10, pctCash: 10, pctCredit: 13 }),
    item({ category: 'bulk', qty: 4, buyCash: 0.07, buyCredit: 0.091, retail: 0.5, match: 'not_found'}),
    // F2F doesn't buy these at all; the second was saved before 'not_bought' existed.
    item({ category: 'not_bought', qty: 2, buyCash: 0, buyCredit: 0, retail: 0.25 }),
    item({ category: 'bulk', qty: 1, buyCash: 0, buyCredit: 0, retail: 0.25 }),
    item({ category: 'bulk', qty: 1, buyCash: 0.07, buyCredit: 0.091, match: 'price_check' }),
    // Oversized cards F2F never lists: new rows say 'unlisted', older ones 'not_found'.
    item({ category: 'not_bought', qty: 1, buyCash: 0, buyCredit: 0, match: 'unlisted', typeLine: 'Scheme' }),
    item({ category: 'bulk', qty: 1, buyCash: 0, buyCredit: 0, match: 'not_found', typeLine: 'Ongoing Scheme' }),
    item({ status: 'error', qty: 1 }),
    item({ status: 'pending', qty: 3 }),
  ];
  const t = summarize(items, 12);

  it('totals buylist and bulk value, including what F2F sells them for', () => {
    expect(t).toMatchObject({ entries: 12, prints: 12, copies: 19, done: 10, errors: 1, notFound: 1, unlisted: 2, priceCheck: 1, buylistPrints: 4, buylistCopies: 5, bulkPrints: 2, bulkCopies: 5 });
    expect(t.buylistCash).toBe(29);
    expect(t.buylistCredit).toBeCloseTo(37.7);
    // Only cards with an F2F price count toward the sell total and its ratio.
    expect(t.buylistRetail).toBe(65);
    expect(t.buylistCashWithRetail).toBe(24);
    expect(t.buylistCreditWithRetail).toBeCloseTo(31.2);
    expect(t.buylistNoRetail).toBe(1);
    // Cards F2F doesn't buy don't count toward the bulk value or what F2F sells bulk for.
    expect(t.bulkCash).toBeCloseTo(0.35);
    expect(t.bulkRetail).toBe(2);
    expect(t.bulkCashWithRetail).toBeCloseTo(0.28);
    expect(t.bulkCreditWithRetail).toBeCloseTo(0.364);
    // Per-card %: 40, 60, 10 (the card without a price has none).
    expect(t.medianPctCash).toBe(40);
    expect(t.meanPctCash).toBeCloseTo(36.667, 3);
    expect(t.medianPctCredit).toBe(52);
    expect(t.meanPctCredit).toBeCloseTo(47.667, 3);
  });
});
