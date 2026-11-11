import type { RunPhase, RunStatus } from '../types';

export { dateTime, FINISH_LABEL, finishLabel } from '@/lib/format';

const cad = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const cadSmall = new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', minimumFractionDigits: 2, maximumFractionDigits: 3 });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

export const money = (n: number | null | undefined) => (n == null ? '—' : n > 0 && n < 0.1 ? cadSmall.format(n) : cad.format(n));
export const moneyUsd = (n: number | null | undefined) => (n == null ? '—' : usd.format(n));
export const pct = (n: number | null | undefined) => (n == null ? '—' : `${n.toFixed(1)} %`);
export const rarityLabel = (r: string) => (r ? r.charAt(0).toUpperCase() + r.slice(1) : '—');
export const RARITY_COLOR: Record<string, string> = { common: 'gray', uncommon: 'cyan', rare: 'yellow', mythic: 'orange', special: 'grape', bonus: 'grape' };

/** Buy ÷ retail: higher means F2F pays closer to what it sells for. */
export function pctColor(p: number | null | undefined) {
  if (p == null) return 'gray';
  if (p >= 50) return 'teal';
  if (p >= 35) return 'lime';
  if (p >= 20) return 'yellow';
  return 'red';
}

export const STATUS_LABEL: Record<RunStatus, string> = {
  fetching_collection: 'Reading collection',
  queued: 'Queued',
  running: 'Running',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export const STATUS_COLOR: Record<RunStatus, string> = {
  fetching_collection: 'blue',
  queued: 'gray',
  running: 'blue',
  paused: 'yellow',
  completed: 'teal',
  failed: 'red',
  cancelled: 'gray',
};
export const PHASE_LABEL: Record<RunPhase, string> = {
  bulk_rates: 'Fetching bulk rates',
  lookup: 'Batched lookup',
  fallback: 'Fallback search',
  shop_search: 'Shopify search',
  done: 'Done',
};
