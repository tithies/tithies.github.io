import { nmVariant, type F2FDoc } from '@/lib/f2f/api';
import type { MoxFinish } from '@/lib/moxfield/normalize';
import { bulkValue } from './bulk';
import type { BulkRates, Category, Item, MatchStatus } from './types';

/** "Secrets of Strixhaven: Promos" ≈ "Secrets of Strixhaven Promos" */
export const normSet = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
export const normName = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
export const normCn = (s: string) => s.trim().toLowerCase().replace(/^0+(?=\d)/, '');

const F2F_FINISH: Record<MoxFinish, string> = { nonFoil: 'Non-Foil', foil: 'Foil', etched: 'Etched Foil' };

export interface PrintRef {
  set: string;
  setName: string;
  cn: string;
  finish: MoxFinish;
  faces: string[];
  name: string;
  /** Alternate printed name; F2F titles these "Flavor Name - Card Name". */
  flavorName?: string;
}

/** Names to send to F2F's exact "Card Name" filter: the front face, plus F2F's "Flavor - Name" form. */
export function f2fSearchNames(p: { frontName: string; flavorName?: string }): string[] {
  return p.flavorName ? [p.frontName, `${p.flavorName} - ${p.frontName}`] : [p.frontName];
}

export interface MatchResult {
  match: MatchStatus;
  doc: F2FDoc | null;
  note?: string;
}

const isEnglish = (d: F2FDoc) => !d.language || d.language.toLowerCase() === 'english';

/** Every normalised name a print may appear under on F2F. */
function wantedNames(p: PrintRef): Set<string> {
  const out = new Set([p.name, ...p.faces].map(normName));
  if (p.flavorName) {
    out.add(normName(p.flavorName));
    for (const n of [p.faces[0] ?? p.name, p.name]) out.add(normName(`${p.flavorName} - ${n}`));
  }
  return out;
}

/** F2F names (and their parts: "The Imperial City of Archades - Wall of Omens" → both halves). */
function docNames(d: F2FDoc): string[] {
  const all = [d.name, ...d.names];
  return [...new Set([...all, ...all.flatMap((n) => n.split(' - '))].map(normName).filter(Boolean))];
}

const nameMatches = (d: F2FDoc, p: PrintRef) => {
  const wanted = wantedNames(p);
  return docNames(d).some((n) => wanted.has(n));
};
const setMatches = (d: F2FDoc, p: PrintRef) =>
  (d.skuSet != null && d.skuSet === p.set.toLowerCase()) || (Boolean(d.setName) && normSet(d.setName) === normSet(p.setName));

/** Picks the doc with the right finish. Foil prints may be listed under a special foil name (Surge, Galaxy…). */
function pickFinish(docs: F2FDoc[], finish: MoxFinish): { doc: F2FDoc; note?: string } | null {
  const target = F2F_FINISH[finish];
  const exact = docs.find((d) => d.finish.toLowerCase() === target.toLowerCase());
  if (exact) return { doc: exact };
  if (finish === 'foil') {
    const others = docs.filter((d) => /foil/i.test(d.finish) && !/^non-?foil$/i.test(d.finish) && !/etched/i.test(d.finish));
    if (others.length >= 1) {
      return { doc: others[0], note: `F2F lists this foil as "${others[0].finish}"${others.length > 1 ? ' (several foil types)' : ''}` };
    }
  }
  return null;
}

/**
 * Finds the exact F2F product for one Moxfield print among candidate docs.
 * exact = same set, collector number, name and finish; loose = same set/name/finish but the
 * collector number differs (only accepted when unambiguous).
 */
export function matchPrint(p: PrintRef, docs: F2FDoc[]): MatchResult {
  const pool = docs.filter((d) => isEnglish(d) && nameMatches(d, p) && setMatches(d, p));
  const sameCn = pool.filter((d) => normCn(d.cn) === normCn(p.cn));
  const exact = pickFinish(sameCn, p.finish);
  if (exact) return { match: 'exact', doc: exact.doc, note: exact.note };

  const otherCn = pool.filter((d) => normCn(d.cn) !== normCn(p.cn));
  const byFinish = otherCn.filter((d) => d.finish.toLowerCase() === F2F_FINISH[p.finish].toLowerCase());
  if (byFinish.length === 1) {
    return { match: 'loose', doc: byFinish[0], note: `Collector number differs on F2F (#${byFinish[0].cn})` };
  }
  return { match: 'not_found', doc: null };
}

/**
 * Fallback matcher for docs fetched by set + collector number (no name filter). Same print =
 * same set, number and finish; if F2F's name doesn't match ours it's reported as a loose match.
 */
export function matchByNumber(p: PrintRef, docs: F2FDoc[]): MatchResult {
  const sameCn = docs.filter((d) => isEnglish(d) && setMatches(d, p) && normCn(d.cn) === normCn(p.cn));
  const named = sameCn.filter((d) => nameMatches(d, p));
  const picked = pickFinish(named, p.finish) ?? pickFinish(sameCn, p.finish);
  if (!picked) return { match: 'not_found', doc: null };
  if (nameMatches(picked.doc, p)) return { match: 'exact', doc: picked.doc, note: picked.note };
  return { match: 'loose', doc: picked.doc, note: `Found by set and number; F2F calls it "${picked.doc.name}"` };
}

export interface Evaluation {
  category: Category;
  retail: number | null;
  buyCash: number;
  buyCredit: number;
  pctCash: number | null;
  pctCredit: number | null;
  stock: number | null;
  bulkReason?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** Turns a match into prices. Cards F2F doesn't buy are valued at the wholesale bulk rate. */
export function evaluate(
  item: Pick<Item, 'set' | 'setType' | 'finish' | 'rarity' | 'typeLine' | 'isToken'>,
  result: MatchResult,
  rates: BulkRates,
  creditBonus: number,
): Evaluation {
  const nm = result.doc ? nmVariant(result.doc) : null;
  const retail = nm?.retail ?? null;
  const stock = nm ? nm.stock : null;
  const buylist = Boolean(result.doc?.publishedF2FSell && nm?.buy && nm.buy > 0);
  let category: Category;
  let buyCash: number;
  let bulkReason: string | undefined;
  if (buylist) {
    category = 'buylist';
    buyCash = nm!.buy!;
  } else {
    category = 'bulk';
    const b = bulkValue({ ...item, doc: result.doc }, rates);
    buyCash = b.value;
    bulkReason = result.doc ? b.reason : `Not on F2F's buylist — ${b.reason.charAt(0).toLowerCase()}${b.reason.slice(1)}`;
  }
  const buyCredit = round4(buyCash * (1 + creditBonus));
  return {
    category,
    retail,
    buyCash: round4(buyCash),
    buyCredit,
    pctCash: retail ? round2((buyCash / retail) * 100) : null,
    pctCredit: retail ? round2((buyCredit / retail) * 100) : null,
    stock,
    bulkReason,
  };
}
