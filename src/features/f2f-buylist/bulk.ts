import { nmVariant, type F2FDoc } from '@/lib/f2f/api';
import type { MoxFinish } from '@/lib/moxfield/normalize';
import type { BulkRates } from './types';

/** F2F MTG bulk rates observed on 2026-11-09, used only if a lot is missing from the live page. */
export const DEFAULT_BULK_RATES: Omit<BulkRates, 'fetchedAt' | 'usedDefaults' | 'sources'> = {
  cu: 0.002,
  rare: 0.07,
  mythic: 0.25,
  foilCu: 0.01,
  foilRare: 0.07,
  foilMythic: 0.5,
  basic: 0.01,
  foilBasic: 0.01,
  fullArtBasic: 0.1,
  promo: 0.02,
};

type RateKey = keyof typeof DEFAULT_BULK_RATES;

/** Bulk lot → rate key, by SKU first and title as a fallback. */
const LOTS: { key: RateKey; sku: RegExp; title: RegExp }[] = [
  { key: 'cu', sku: /^MTG_Bulk_CU/i, title: /^magic.*\bcommons?\/uncommons?\b(?!.*foil)/i },
  { key: 'foilCu', sku: /^MTG_Bulk_Foil_CU/i, title: /foil common\/uncommon/i },
  { key: 'rare', sku: /^MTG_Bulk_Rare/i, title: /^magic[^-]*- rare\b/i },
  { key: 'foilRare', sku: /^MTG_Bulk_Foil_R$/i, title: /foil rare/i },
  { key: 'mythic', sku: /^MTG_Bulk_Mythic/i, title: /^magic[^-]*- mythic rare/i },
  { key: 'foilMythic', sku: /^MTG_Bulk_Foil_M$/i, title: /foil mythic/i },
  { key: 'basic', sku: /^MTG_Bulk_Basic$/i, title: /\b1000 basic lands\b/i },
  { key: 'foilBasic', sku: /^MTG_Bulk_Foil_Basic/i, title: /foil basic land/i },
  { key: 'fullArtBasic', sku: /^SIN-MTG-WHO-FA-BASIC-NF/i, title: /full art basic land/i },
  { key: 'promo', sku: /PROMO$/i, title: /promotional card/i },
];

/** "1000 Commons" → 1000, "100 Full Art Basic Lands" → 100, otherwise 1. */
const lotSize = (title: string) => {
  const m = /(?:^|\s|-\s)(\d{2,5})\s+[a-z]/i.exec(title);
  return m ? Number(m[1]) : 1;
};

/** Parses the wholesale-bulk collection docs (buy index) into per-card rates. */
export function parseBulkRates(docs: F2FDoc[], now = Date.now()): BulkRates {
  const found: Partial<Record<RateKey, number>> = {};
  const sources: BulkRates['sources'] = [];
  for (const doc of docs) {
    if (!/magic/i.test(doc.title)) continue;
    const v = nmVariant(doc);
    if (!v?.buy) continue;
    const lot = LOTS.find((l) => l.sku.test(v.sku)) ?? LOTS.find((l) => l.title.test(doc.title));
    if (!lot) continue;
    const perCard = v.buy / lotSize(doc.title);
    // Prefer the per-card product over a 100/1000 lot of the same kind (e.g. full-art basics).
    if (found[lot.key] === undefined || lotSize(doc.title) === 1) found[lot.key] = perCard;
    sources.push({ title: doc.title, sku: v.sku, sellPrice: v.buy, perCard });
  }
  const rates = { ...DEFAULT_BULK_RATES };
  let usedDefaults = false;
  for (const key of Object.keys(DEFAULT_BULK_RATES) as RateKey[]) {
    if (found[key] !== undefined) rates[key] = found[key]!;
    else usedDefaults = true;
  }
  return { ...rates, fetchedAt: now, usedDefaults, sources };
}

/** Oversized Archenemy schemes / Planechase planes etc.: F2F neither lists nor buys them. */
export const OVERSIZED_TYPE = /\b(scheme|plane|phenomenon|vanguard)\b/i;
export const isOversized = (typeLine: string) => OVERSIZED_TYPE.test(typeLine);
export const OVERSIZED_REASON = 'Oversized cards (Archenemy schemes, Planechase planes) are not sold or bought by F2F';

/** Sets F2F explicitly excludes from every MTG bulk lot. */
const EXCLUDED_SETS: Record<string, string> = { unf: 'Unfinity', ust: 'Unstable', und: 'Unsanctioned', unk: 'Unknown Event' };

export interface BulkInput {
  set: string;
  setType: string;
  finish: MoxFinish;
  /** Moxfield rarity (common/uncommon/rare/mythic/special/bonus). */
  rarity: string;
  typeLine: string;
  isToken: boolean;
  doc?: F2FDoc | null;
}

const normRarity = (r: string) => {
  const s = r.toLowerCase();
  if (s.startsWith('mythic')) return 'mythic';
  if (s.startsWith('rare') || s === 'special' || s === 'bonus') return 'rare';
  if (s.startsWith('uncommon') || s.startsWith('common')) return 'cu';
  if (s.startsWith('promo')) return 'promo';
  if (s.startsWith('token')) return 'token';
  return s;
};

/** Per-card bulk value and a human explanation. */
export function bulkValue(input: BulkInput, rates: BulkRates): { value: number; reason: string } {
  const foil = input.finish !== 'nonFoil';
  const f = foil ? 'Foil ' : '';
  const excluded = EXCLUDED_SETS[input.set];
  if (excluded) return { value: 0, reason: `${excluded} is excluded from F2F bulk` };
  if (input.isToken || /\btoken\b/i.test(input.typeLine)) return { value: 0, reason: 'Tokens are not bought as bulk' };
  if (isOversized(input.typeLine)) return { value: 0, reason: OVERSIZED_REASON };
  if (/^basic\b.*\bland\b/i.test(input.typeLine)) {
    return foil
      ? { value: rates.foilBasic, reason: 'Bulk rate: foil basic land' }
      : { value: rates.basic, reason: 'Bulk rate: basic land (full-art basics pay more)' };
  }
  // F2F's own rarity wins when we matched a doc (it labels promos as "Promotional").
  const rarity = normRarity(input.doc?.rarity || input.rarity);
  if (rarity === 'promo' || input.setType === 'promo') return { value: rates.promo, reason: 'Bulk rate: promotional card' };
  if (rarity === 'token') return { value: 0, reason: 'Tokens are not bought as bulk' };
  if (rarity === 'mythic') return { value: foil ? rates.foilMythic : rates.mythic, reason: `Bulk rate: ${f}mythic rare` };
  if (rarity === 'rare') return { value: foil ? rates.foilRare : rates.rare, reason: `Bulk rate: ${f}rare` };
  if (rarity === 'cu') return { value: foil ? rates.foilCu : rates.cu, reason: `Bulk rate: ${f}common/uncommon` };
  return { value: 0, reason: `No bulk rate for rarity "${input.doc?.rarity || input.rarity}"` };
}
