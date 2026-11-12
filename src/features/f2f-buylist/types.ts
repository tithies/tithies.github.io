import type { F2FDoc } from '@/lib/f2f/api';
import { isOversized } from './bulk';
import type { Finish } from '@/lib/cards/types';

export type RunStatus = 'fetching_collection' | 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type RunPhase = 'bulk_rates' | 'lookup' | 'fallback' | 'shop_search' | 'done';

/** What F2F pays: its buylist price, the wholesale bulk rate, or nothing (tokens, Unfinity, oversized cards…). */
export type Category = 'buylist' | 'bulk' | 'not_bought';
/**
 * price_check: the exact print is on F2F but missing from its search index, so its buy price is unknown.
 * unlisted: not found, and F2F never lists this kind of card (oversized schemes, planes…): nothing to review.
 */
export type MatchStatus = 'exact' | 'loose' | 'price_check' | 'unlisted' | 'not_found';
/** pending → (pass 1) → fallback? → shop_search? (Shopify product search) → done | error */
export type ItemStatus = 'pending' | 'fallback' | 'shop_search' | 'done' | 'error';

export interface BulkRates {
  /** Per-card CAD rates. */
  cu: number;
  rare: number;
  mythic: number;
  foilCu: number;
  foilRare: number;
  foilMythic: number;
  basic: number;
  foilBasic: number;
  fullArtBasic: number;
  promo: number;
  fetchedAt: number;
  /** True when some rates fell back to built-in defaults (lot missing from F2F's bulk page). */
  usedDefaults: boolean;
  sources: { title: string; sku: string; sellPrice: number; perCard: number }[];
}

export interface RunTotals {
  entries: number;
  prints: number;
  copies: number;
  done: number;
  errors: number;
  buylistPrints: number;
  buylistCopies: number;
  bulkPrints: number;
  bulkCopies: number;
  notFound: number;
  /** Oversized cards F2F never lists (not counted in notFound). */
  unlisted: number;
  loose: number;
  /** Prints on F2F whose buy price must be checked by hand (missing from F2F's search). */
  priceCheck: number;
  buylistCash: number;
  buylistCredit: number;
  bulkCash: number;
  bulkCredit: number;
  /** Σ qty × F2F NM retail price of buylist cards that have one. */
  buylistRetail: number;
  /** Buylist cash / credit of the same cards (for overall cash ÷ retail and credit ÷ retail ratios). */
  buylistCashWithRetail: number;
  buylistCreditWithRetail: number;
  /** Buylist prints with no F2F retail price (excluded from buylistRetail). */
  buylistNoRetail: number;
  /** Σ qty × F2F NM retail price of bulk cards that have one. */
  bulkRetail: number;
  /** Bulk cash / credit of the same cards (for % of F2F price). */
  bulkCashWithRetail: number;
  bulkCreditWithRetail: number;
  medianPctCash: number | null;
  /** Unweighted average of per-card cash ÷ F2F price (buylist cards with a price). */
  meanPctCash: number | null;
  medianPctCredit: number | null;
  meanPctCredit: number | null;
}

export interface RunSource {
  url: string;
  pageUrl: string;
  query: Record<string, string>;
  summary: string;
  tabId?: number;
}

export interface Run {
  id?: number;
  /** The account whose collection this run checks (see src/lib/accounts). */
  accountKey: string;
  createdAt: number;
  updatedAt: number;
  finishedAt?: number;
  status: RunStatus;
  phase: RunPhase;
  source: RunSource;
  totals: RunTotals;
  creditBonus: number;
  bulkRates?: BulkRates;
  requests: number;
  consecutiveFailures: number;
  error?: string;
}

export interface Item {
  runId: number;
  /** Same as the run's. */
  accountKey: string;
  key: string;
  status: ItemStatus;
  // --- from Moxfield
  name: string;
  frontName: string;
  faces: string[];
  /** Alternate printed name from Moxfield/Scryfall (empty when none). */
  flavorName?: string;
  set: string;
  setName: string;
  setType: string;
  cn: string;
  finish: Finish;
  rarity: string;
  typeLine: string;
  isToken: boolean;
  qty: number;
  conditions: Record<string, number>;
  alters: number;
  scryfallId: string;
  marketUsd: number | null;
  // --- results
  category?: Category;
  match?: MatchStatus;
  matchNote?: string;
  doc?: F2FDoc | null;
  retail?: number | null;
  buyCash?: number;
  buyCredit?: number;
  pctCash?: number | null;
  pctCredit?: number | null;
  stock?: number | null;
  bulkReason?: string;
  error?: string;
  fromCache?: boolean;
  updatedAt: number;
}

export interface CacheEntry {
  key: string;
  fetchedAt: number;
  /** Matcher version that produced this entry (older ones are ignored). */
  v?: number;
  match: MatchStatus;
  matchNote?: string;
  doc: F2FDoc | null;
}

export interface RunProgress {
  runId: number;
  accountKey: string;
  status: RunStatus;
  phase: RunPhase;
  done: number;
  total: number;
  buylistPrints: number;
  buylistCash: number;
  buylistCredit: number;
  message?: string;
}

/** A row's category. Rows saved before 'not_bought' existed say 'bulk' with a $0 value. */
export const categoryOf = (it: Pick<Item, 'category' | 'buyCash'>): Category | undefined =>
  it.category === 'bulk' && !((it.buyCash ?? 0) > 0) ? 'not_bought' : it.category;

/** A row's match. Rows saved before 'unlisted' existed say 'not_found' for oversized cards too. */
export const matchOf = (it: Pick<Item, 'match' | 'typeLine'>): MatchStatus | undefined =>
  it.match === 'not_found' && isOversized(it.typeLine ?? '') ? 'unlisted' : it.match;

export const emptyTotals = (): RunTotals => ({
  entries: 0,
  prints: 0,
  copies: 0,
  done: 0,
  errors: 0,
  buylistPrints: 0,
  buylistCopies: 0,
  bulkPrints: 0,
  bulkCopies: 0,
  notFound: 0,
  unlisted: 0,
  loose: 0,
  priceCheck: 0,
  buylistCash: 0,
  buylistCredit: 0,
  bulkCash: 0,
  bulkCredit: 0,
  buylistRetail: 0,
  buylistCashWithRetail: 0,
  buylistCreditWithRetail: 0,
  buylistNoRetail: 0,
  bulkRetail: 0,
  bulkCashWithRetail: 0,
  bulkCreditWithRetail: 0,
  medianPctCash: null,
  meanPctCash: null,
  medianPctCredit: null,
  meanPctCredit: null,
});
