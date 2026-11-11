import Papa from 'papaparse';
import { f2fLinks } from '@/lib/f2f/links';
import { categoryOf, matchOf, type Item, type Run } from '../types';
import { pctOf } from './filtering';

export function itemsToCsv(items: Item[]): string {
  return Papa.unparse(
    items.map((i) => ({
      category: categoryOf(i) ?? i.status,
      name: i.name,
      set: i.set.toUpperCase(),
      set_name: i.setName,
      collector_number: i.cn,
      finish: i.finish,
      rarity: i.rarity,
      qty: i.qty,
      f2f_buy_cash: i.buyCash ?? '',
      f2f_buy_credit: i.buyCredit ?? '',
      f2f_retail_nm: i.retail ?? '',
      pct_cash: pctOf(i, 'pctCash') ?? '',
      pct_credit: pctOf(i, 'pctCredit') ?? '',
      line_cash: i.buyCash != null ? +(i.buyCash * i.qty).toFixed(4) : '',
      line_credit: i.buyCredit != null ? +(i.buyCredit * i.qty).toFixed(4) : '',
      f2f_nm_stock: i.stock ?? '',
      moxfield_market_usd: i.marketUsd ?? '',
      match: matchOf(i) ?? '',
      note: [i.matchNote, i.bulkReason, i.error].filter(Boolean).join(' | '),
      f2f_title: i.doc?.title ?? '',
      f2f_sell_url: i.doc?.handle && (categoryOf(i) === 'buylist' || i.match === 'price_check') ? f2fLinks.sellProduct(i.doc.handle) : '',
    })),
  );
}

export function downloadCsv(run: Run, items: Item[], suffix = '') {
  const blob = new Blob([itemsToCsv(items)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `tithies-f2f-run-${run.id}${suffix}-${new Date(run.createdAt).toISOString().slice(0, 10)}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
