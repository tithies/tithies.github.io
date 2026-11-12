import { isScanListing, nmVariant, type F2FDoc } from '@/lib/f2f/api';
import type { Finish } from '@/lib/cards/types';
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

const F2F_FINISH: Record<Finish, string> = { nonFoil: 'Non-Foil', foil: 'Foil', etched: 'Etched Foil' };

export interface PrintRef {
  set: string;
  setName: string;
  cn: string;
  finish: Finish;
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

/** Regular listing first, then on the buylist, then with a buy price; one-off scanned copies last. */
const docRank = (d: F2FDoc) => (isScanListing(d) ? 0 : 4) + (d.publishedF2FSell ? 2 : 0) + ((nmVariant(d)?.buy ?? 0) > 0 ? 1 : 0);
/** Best candidates first (stable, so F2F's order breaks ties). */
const byRank = (docs: F2FDoc[]) => [...docs].sort((a, b) => docRank(b) - docRank(a));

const SCAN_NOTE = "F2F only lists individually scanned copies of this print, and doesn't buy it individually";
const withScanNote = (doc: F2FDoc, note?: string) => ({
  doc,
  note: isScanListing(doc) ? (note ? `${note}; ${SCAN_NOTE}` : SCAN_NOTE) : note,
});

/**
 * Picks the doc with the right finish. Foil prints may be listed under a special foil name
 * (Surge, Galaxy…). F2F can list dozens of scanned single copies next to the regular product,
 * so candidates are ranked rather than taken in F2F's order.
 */
function pickFinish(docs: F2FDoc[], finish: Finish): { doc: F2FDoc; note?: string } | null {
  const ranked = byRank(docs);
  const target = F2F_FINISH[finish].toLowerCase();
  const exact = ranked.find((d) => d.finish.toLowerCase() === target);
  if (exact) return withScanNote(exact);
  if (finish === 'foil') {
    const others = ranked.filter((d) => /foil/i.test(d.finish) && !/^non-?foil$/i.test(d.finish) && !/etched/i.test(d.finish));
    if (others.length) {
      const kinds = new Set(others.map((d) => d.finish.toLowerCase()));
      return withScanNote(others[0], `F2F lists this foil as "${others[0].finish}"${kinds.size > 1 ? ' (several foil types)' : ''}`);
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
  // Scanned copies of the same product don't make it ambiguous.
  const regular = byFinish.filter((d) => !isScanListing(d));
  const candidates = regular.length ? regular : byFinish;
  if (candidates.length === 1) {
    return { match: 'loose', ...withScanNote(candidates[0], `Collector number differs on F2F (#${candidates[0].cn})`) };
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

export const PRICE_CHECK_NOTE =
  "On F2F, but missing from F2F's search, so Tithies can't read its buy price. Check it on the card's F2F sell page.";

/**
 * Pass 3 matcher for docs from Shopify's product search (titles only, no variants yet). The
 * search is fuzzy, so only the exact print counts: same name, set, collector number and finish.
 * `f2fSetName` is F2F's own name for the print's set when known ("Duskmourn: House of Horror: Commander").
 */
export function matchShopify(p: PrintRef, docs: F2FDoc[], f2fSetName?: string): F2FDoc | null {
  for (const setName of new Set([p.setName, f2fSetName])) {
    if (!setName) continue;
    const r = matchByNumber({ ...p, setName }, docs);
    if (r.match === 'exact' && r.doc) return r.doc;
  }
  return null;
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
    const b = bulkValue({ ...item, doc: result.doc }, rates);
    category = b.value > 0 ? 'bulk' : 'not_bought';
    buyCash = b.value;
    const reason = `${b.reason.charAt(0).toLowerCase()}${b.reason.slice(1)}`;
    if (!result.doc) bulkReason = `F2F doesn't buy it individually — ${reason}`;
    else if (result.doc.source === 'shopify') bulkReason = `Buy price unknown (check it on F2F) — ${reason}`;
    else bulkReason = b.reason;
  }
  const buyCredit = round4(buyCash * (1 + creditBonus));
  return {
    category,
    retail,
    buyCash: round4(buyCash),
    buyCredit,
    // A buy ÷ sell ratio means nothing for cards F2F doesn't buy at all.
    pctCash: retail && category !== 'not_bought' ? round2((buyCash / retail) * 100) : null,
    pctCredit: retail && category !== 'not_bought' ? round2((buyCredit / retail) * 100) : null,
    stock,
    bulkReason,
  };
}
