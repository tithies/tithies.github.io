/**
 * Phase 3: the right print among same-art reprints. Pure rules, the same as the trainer's trainer/verify.py
 * (tithies-scanner-trainer repo), which measures them:
 * - candidates: the same-name, same-art prints among the search's top 20 (same face);
 * - the bottom line read decides when its number (and set code, when one is read) matches exactly one candidate;
 *   a number one digit off counts when the set code is read;
 * - otherwise the visual check (engine/print-visual.ts) overrides the search's pick only on a margin above TAU,
 *   or when the read ruled the pick out.
 */
import type { CardMatch } from './pipeline';
import type { TextLineRead } from './protocol';

/** The visual check's margin to override the search (the best on the trainer's train split). */
export const TAU = 0.04;
/** Pictures the visual check compares at most. */
export const MAX_PICTURES = 6;

/** A collector number's digits without leading zeros ('0283' → '283', '38p' → '38', 'C13-29' → '29'). */
export function digits(cn: string): string {
  const m = /0*(\d+)\D*$/.exec(cn) ?? /0*(\d+)/.exec(cn);
  return m ? m[1] : cn;
}

/** What a print shows on its bottom line: [set code, number]. The List prints the original card's; promo sets
 * (p + a set code) print the main set's code. */
export function printed(p: Pick<CardMatch, 'set' | 'cn'>): [string, string] {
  const s = p.set.toUpperCase();
  const cn = String(p.cn);
  if (s === 'PLST' && cn.includes('-')) {
    const [orig, num] = cn.split(/-(.*)/s);
    return [orig.toUpperCase(), digits(num)];
  }
  if (s.length === 4 && s.startsWith('P')) return [s.slice(1), digits(cn)];
  return [s, digits(cn)];
}

export interface BottomRead {
  numbers: Set<string>;
  text: string;
}

/** The numbers and text of the bottom line's left part (where the collector number and set code are). */
export function readBottom(lines: readonly TextLineRead[]): BottomRead {
  const numbers = new Set<string>();
  const text: string[] = [];
  for (const l of lines) {
    if (l.y < 0.86 || l.conf < 0.5 || l.x > 0.55) continue;
    let t = l.text.toUpperCase();
    text.push(t);
    // A 4-digit number's leading 0 read as O, Q or D ('C Q199' for 'C 0199'), alone or after a rarity letter.
    t = t.replace(/(?<![A-Z0-9])([CURMLST]?)[OQD](?=\d{3}(?!\d))/g, '$10');
    // A rarity letter glued to a 4-digit number ('U0040') is split off; set codes such as C21 have 2 digits.
    t = t.replace(/(?<![A-Z0-9])([CURMLST])(?=\d{4}(?!\d))/g, '$1 ');
    for (const m of t.matchAll(/(©|@|\b(?:19|20)\d\d\b)|(?<![0-9A-Z])0*(\d{1,4})(?:\/\d{1,4})?(?!\d)/g)) {
      if (m[1] || m[2] === undefined) continue;
      if (/^(19|20)\d\d$/.test(m[0])) continue;
      numbers.add(m[2]);
    }
  }
  return { numbers, text: text.join(' ') };
}

const oneOff = (a: string, b: string) => a.length === b.length && [...a].filter((c, i) => c !== b[i]).length === 1;
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The candidates (indices into `cands`) the bottom line agrees with: their number read, and their set code too
 * when one of them has it in the text. With no exact number: one whose set code was read and number is one digit off. */
export function ocrAgrees(cands: readonly Pick<CardMatch, 'set' | 'cn'>[], bottom: BottomRead): number[] {
  const t = bottom.text.replace(/[^A-Z0-9]/g, ' ');
  const hasSet = (i: number) => new RegExp(`(?<![A-Z0-9])${escape(printed(cands[i])[0])}`).test(t);
  const all = cands.map((_, i) => i);
  const byNum = all.filter((i) => bottom.numbers.has(printed(cands[i])[1]));
  if (!byNum.length) {
    const near = all.filter((i) => hasSet(i) && [...bottom.numbers].some((n) => oneOff(printed(cands[i])[1], n)));
    return near.length === 1 ? near : [];
  }
  const withSet = byNum.filter(hasSet);
  return withSet.length ? withSet : byNum;
}

/** Indices into `hits` of the same-name, same-art prints (same face) among the first 20, best first. */
export function candidates(hits: readonly CardMatch[], k = 20): number[] {
  if (!hits.length) return [];
  const best = hits[0];
  const art = (h: CardMatch) => (h as CardMatch & { art?: number }).art;
  const out: number[] = [];
  const seen = new Set<string>();
  hits.slice(0, k).forEach((h, i) => {
    const key = `${h.scryfallId}|${h.back ? 1 : 0}`;
    if (h.name === best.name && art(h) === art(best) && !!h.back === !!best.back && !seen.has(key)) {
      seen.add(key);
      out.push(i);
    }
  });
  return out;
}

export type PrintHow = 'only print' | 'read' | 'read + checked' | 'checked' | 'checked: kept' | 'unsure' | 'search' | 'no pictures';

export interface PrintDecision {
  /** Index into the hits of the print chosen. */
  pick: number;
  how: PrintHow;
  /** The numbers and text read on the bottom line. */
  read?: { numbers: string[]; text: string };
  margin?: number;
}

/** The pool the visual check compares (indices into hits), after the bottom line's read; or a decision already. */
export function beforeVisual(hits: readonly CardMatch[], lines: readonly TextLineRead[] | null): { decided?: PrintDecision; pool: number[]; narrowed: boolean; read?: PrintDecision['read'] } {
  const cands = candidates(hits);
  if (cands.length < 2) return { decided: { pick: 0, how: 'only print' }, pool: [], narrowed: false };
  if (!lines) return { pool: cands, narrowed: false };
  const bottom = readBottom(lines);
  const read = { numbers: [...bottom.numbers].sort(), text: bottom.text };
  const agree = ocrAgrees(cands.map((i) => hits[i]), bottom).map((k) => cands[k]);
  if (agree.length === 1) return { decided: { pick: agree[0], how: 'read', read }, pool: [], narrowed: true, read };
  return agree.length > 1 ? { pool: agree, narrowed: true, read } : { pool: cands, narrowed: false, read };
}

/**
 * The decision after the visual check. `used`: the pool's candidates whose picture was compared (at most
 * MAX_PICTURES, in pool order); `visual.winner` indexes `used`; null when fewer than 2 pictures were there.
 */
export function afterVisual(pool: readonly number[], narrowed: boolean, used: readonly number[], visual: { winner: number | null; margin: number } | null, read?: PrintDecision['read']): PrintDecision {
  const pick = 0;
  if (!visual || used.length < 2) return { pick, how: 'no pictures', read };
  if (visual.winner === null) return { pick: pool[0], how: 'unsure', read };
  const w = used[visual.winner];
  // The read ruled the search's pick out: the best of the pool it left.
  if (narrowed && !pool.includes(pick)) return { pick: w, how: 'read + checked', margin: visual.margin, read };
  if (w !== pick && visual.margin > TAU) return { pick: w, how: 'checked', margin: visual.margin, read };
  return { pick, how: w === pick ? 'checked: kept' : 'unsure', margin: visual.margin, read };
}
