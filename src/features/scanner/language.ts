/**
 * Phase 3: a card's language, from its own text. The same rules as the trainer's trainer/verify.py
 * (tithies-scanner-trainer repo), which measures them; the word lists are languages.json, a copy of the trainer's.
 * 1. The Latin reading: type words (3 points) and common words (1 point) between the art and the bottom line,
 *    a shared word split between its languages; the copyright and artist lines (English on every card) don't count.
 *    2+ points: that language (the bottom line's code wins a close call).
 * 2. Otherwise the name, type line and rules text read again by the other scripts' recognizers: kana → ja,
 *    hangul → ko, Cyrillic → ru, Han → zhs or zht (the code, else characters only one of them uses, else the name).
 *    A script needs 8+ of its characters (noise on a small English card gives 1–3).
 * 3. Otherwise the bottom line's code, read right after the print's set code.
 * 4. Otherwise the name read against the card's printed name in each language (Scryfall).
 * 5. Otherwise a few words' best language, else English.
 */
import type { TextBoxGeo, TextLineRead } from './protocol';
import RULES from './languages.json';

export type Lang = 'en' | 'fr' | 'de' | 'it' | 'es' | 'pt' | 'ja' | 'ko' | 'ru' | 'zhs' | 'zht' | 'ph';

/** Lowercase, no accents (é → e, ß → ss). */
export function plain(s: string): string {
  return s.toLowerCase().replace(/ß/g, 'ss').normalize('NFKD').replace(/\p{M}/gu, '');
}

export const words = (s: string): string[] => plain(s).match(/[a-z]+/g) ?? [];

function weights(table: Record<string, string[]>): Map<string, Record<string, number>> {
  const langs = new Map<string, Set<string>>();
  for (const [lang, ws] of Object.entries(table)) for (const w of ws) (langs.get(plain(w)) ?? langs.set(plain(w), new Set()).get(plain(w))!).add(lang);
  return new Map([...langs].map(([w, ls]) => [w, Object.fromEntries([...ls].map((l) => [l, 1 / ls.size]))]));
}

const TYPE_W = weights(RULES.types);
const COMMON_W = weights(RULES.common);
const SIMP = new Set([...RULES.simplified].filter((c) => !RULES.traditional.includes(c)));
const TRAD = new Set([...RULES.traditional].filter((c) => !RULES.simplified.includes(c)));
const CODES = RULES.codes as Record<string, Lang>;
const LATIN_LANGS = Object.keys(RULES.types) as Lang[];

export type Script = 'kana' | 'hangul' | 'cyrillic' | 'han' | 'latin';

/** The script most characters of `text` are in; Japanese (kana) as soon as kana make a real share. */
export function scriptOf(text: string): Script | null {
  const counts: Record<Script, number> = { kana: 0, hangul: 0, cyrillic: 0, han: 0, latin: 0 };
  for (const ch of text) {
    const o = ch.codePointAt(0)!;
    if ((o >= 0x3040 && o <= 0x30ff) || (o >= 0x31f0 && o <= 0x31ff)) counts.kana++;
    else if ((o >= 0xac00 && o <= 0xd7af) || (o >= 0x1100 && o <= 0x11ff) || (o >= 0x3130 && o <= 0x318f)) counts.hangul++;
    else if (o >= 0x0400 && o <= 0x04ff) counts.cyrillic++;
    else if (o >= 0x4e00 && o <= 0x9fff) counts.han++;
    else if (o < 0x250 && /\p{L}/u.test(ch)) counts.latin++;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return null;
  if (counts.kana >= Math.max(2, 0.1 * total)) return 'kana';
  let best: Script = 'kana';
  for (const k of Object.keys(counts) as Script[]) if (counts[k] > counts[best]) best = k;
  return best;
}

/** A set code as OCR reads it: the same, one character more or less at either end, or one character different. */
export function nearCode(found: string, code: string): boolean {
  if (found === code || (found.length === code.length && [...found].filter((c, i) => c !== code[i]).length <= 1)) return true;
  if (found.length === code.length + 1) return found.startsWith(code) || found.endsWith(code);
  if (found.length === code.length - 1 && found.length >= 2) return code.startsWith(found) || code.endsWith(found);
  return false;
}

const LANG_AFTER = /[·•*★.\-_]?(EN|FR|DE|IT|ES|SP|PT|JP|JA|KR|KO|RU|CS|CT|PH)/y;

/** The bottom line's language code, read right after one of `sets` (the set codes the card may print). */
export function bottomCode(lines: readonly TextLineRead[], sets: readonly string[]): Lang | null {
  for (const l of lines) {
    if (l.y < 0.86 || l.conf < 0.6) continue;
    // Read without spaces ('TDC · EN' is often 'TDCEN'), but a set code must start a word: not right after a
    // letter, as 'RIC' in 'ERIC DESCHAMPS' (a near MIC, then DE) on a frame with no code at all.
    const u = l.text.toUpperCase();
    let t = '';
    const starts: boolean[] = [];
    for (let j = 0; j < u.length; j++) {
      if (u[j] === ' ') continue;
      starts.push(j === 0 || !/\p{L}/u.test(u[j - 1]));
      t += u[j];
    }
    for (const x of sets) {
      for (let i = 0; i < t.length; i++) {
        if (!starts[i]) continue;
        for (const n of [x.length, x.length + 1, x.length - 1]) {
          if (n < 2 || !nearCode(t.slice(i, i + n), x)) continue;
          LANG_AFTER.lastIndex = i + n;
          const m = LANG_AFTER.exec(t);
          if (m) return CODES[m[1]];
        }
      }
    }
  }
  return null;
}

/** The copyright and artist lines are English on every card, in every language. */
const NOT_CARD_TEXT = /wizards|©|™|\billus|\btm\b|coast/i;

export function latinScores(lines: readonly TextLineRead[]): Record<string, number> {
  const scores: Record<string, number> = Object.fromEntries(LATIN_LANGS.map((l) => [l, 0]));
  for (const l of lines) {
    if (l.conf < 0.7 || !(l.y > 0.45 && l.y < 0.9) || NOT_CARD_TEXT.test(l.text)) continue;
    for (const w of words(l.text)) {
      for (const [lang, v] of Object.entries(TYPE_W.get(w) ?? {})) scores[lang] += 3 * v;
      for (const [lang, v] of Object.entries(COMMON_W.get(w) ?? {})) scores[lang] += v;
    }
  }
  return scores;
}

/** 1 − edit distance ÷ the longer length, on plain letters and digits. */
export function similarity(a: string, b: string): number {
  const keep = (s: string) => [...plain(s)].filter((c) => /[\p{L}\p{N}]/u.test(c));
  const A = keep(a);
  const B = keep(b);
  if (!A.length || !B.length) return 0;
  let prev = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) {
    const cur = [i];
    for (let j = 1; j <= B.length; j++) cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (A[i - 1] !== B[j - 1] ? 1 : 0)));
    prev = cur;
  }
  return 1 - prev[B.length] / Math.max(A.length, B.length);
}

/**
 * A card's text as read so far: every box found, and the boxes read (by index). Read in stages, as the trainer
 * does: stageFirst at once (the print and most cards' language), the rest of the rules text when the language is
 * still open, the name line for the printed-name lookup.
 */
export interface TextState {
  boxes: TextBoxGeo[];
  lines: Map<number, TextLineRead>;
}

export const stageFirst = (b: TextBoxGeo) => b.y >= 0.86 || (b.y > 0.45 && b.y < 0.72);
export const stageRules = (b: TextBoxGeo) => b.y > 0.45 && b.y < 0.9;
export const stageName = (b: TextBoxGeo) => b.y < 0.12;

/** The boxes of a stage, by index. */
export const boxesWhere = (s: TextState, f: (b: TextBoxGeo) => boolean) => s.boxes.flatMap((b, i) => (f(b) ? [i] : []));

/** The lines read so far, in box order. */
export const linesOf = (s: TextState): TextLineRead[] => [...s.lines.entries()].sort((a, b) => a[0] - b[0]).map(([, l]) => l);

/** Another script's reading of the card's boxes (`lines`: box indices). */
export interface OtherReading {
  script: Script;
  model: 'main' | 'korean' | 'cyrillic';
  conf: number;
  texts: string[];
  lines: number[];
}

export const MIN_SCRIPT_CHARS = 8;
export const SCRIPT_MODELS: { model: OtherReading['model']; want: Script[] }[] = [
  { model: 'main', want: ['kana', 'han'] },
  { model: 'korean', want: ['hangul'] },
  { model: 'cyrillic', want: ['cyrillic'] },
];

/** The boxes the other scripts read: the name, type line and rules text (above 90 %), at most 14. */
export const otherScriptLines = (boxes: readonly TextBoxGeo[]) => boxes.flatMap((b, i) => (b.y < 0.9 ? [i] : [])).slice(0, 14);

/**
 * The best non-Latin reading, given a function that reads the lines with one model (lazily: the next model runs
 * only when the reading so far is not clearly one script).
 */
export async function otherScripts(boxes: readonly TextBoxGeo[], read: (model: OtherReading['model'], idx: number[]) => Promise<{ text: string; conf: number }[]>): Promise<OtherReading | null> {
  const idx = otherScriptLines(boxes);
  if (!idx.length) return null;
  let best: OtherReading | null = null;
  for (const { model, want } of SCRIPT_MODELS) {
    const reads = await read(model, idx);
    const text = reads.filter((r) => r.conf > 0.5).map((r) => r.text).join('');
    const sc = scriptOf(text);
    const conf = reads.length ? reads.reduce((s, r) => s + r.conf, 0) / reads.length : 0;
    let n = 0;
    for (const r of reads) for (const ch of r.text) {
      const s = scriptOf(ch);
      if (s && (want.includes(s) || (model === 'main' && (s === 'kana' || s === 'han')))) n++;
    }
    if (n < MIN_SCRIPT_CHARS) continue;
    if (sc && want.includes(sc) && (!best || conf > best.conf)) best = { script: sc, model, conf, texts: reads.map((r) => r.text), lines: idx };
    if (best && best.conf > 0.85) break;
  }
  return best;
}

/** The card's name as read: the top line (above 12 %), in the script it was read in. */
export function nameText(state: TextState, other: OtherReading | null): string | null {
  if (other) {
    for (let k = 0; k < other.texts.length; k++) if (state.boxes[other.lines[k]].y < 0.12 && other.texts[k]) return other.texts[k];
  }
  const tops = linesOf(state).filter((l) => l.y < 0.12 && l.conf > 0.5 && l.text.length >= 3);
  if (!tops.length) return null;
  return tops.reduce((a, b) => (b.h > a.h || (b.h === a.h && b.text.length > a.text.length) ? b : a)).text;
}

/** The language whose printed name matches the name read, when it clearly does (lead 0.05, at least 0.6). */
export function languageByName(text: string | null, names: Record<string, string[]> | null, among?: readonly Lang[], lead = 0.05, least = 0.6): Lang | null {
  if (!text || !names) return null;
  const best: [Lang, number][] = [];
  for (const [lang, ns] of Object.entries(names)) {
    if (among && !among.includes(lang as Lang)) continue;
    best.push([lang as Lang, Math.max(...ns.map((n) => similarity(text, n)))]);
  }
  if (!best.length) return null;
  best.sort((a, b) => b[1] - a[1]);
  const second = best[1]?.[1] ?? 0;
  return best[0][1] >= least && best[0][1] - second >= lead ? best[0][0] : null;
}

export interface LanguageResult {
  lang: Lang;
  how: string;
}

export interface LanguageDeps {
  /** Reads more boxes with the Latin recognizer, into the state (those not read yet, in box order). */
  readLatin: (idx: number[]) => Promise<void>;
  /** The other scripts' reading of the boxes (otherScripts with the engine's recognizers). */
  otherScripts: () => Promise<OtherReading | null>;
  /** The card's printed names, by language (Scryfall). */
  printedNames: (name: string) => Promise<Record<string, string[]> | null>;
}

export async function languageOf(state: TextState, opts: { sets: readonly string[]; name: string | null; deps: LanguageDeps; strong?: number }): Promise<LanguageResult> {
  const strong = opts.strong ?? 2;
  let code = bottomCode(linesOf(state), opts.sets);
  let scores = latinScores(linesOf(state));
  const argmax = () => {
    let b = LATIN_LANGS[0] as Lang;
    for (const l of LATIN_LANGS) if (scores[l] > scores[b]) b = l;
    return b;
  };
  let best = argmax();
  if (scores[best] < strong) {
    // Still open: the rest of the rules text.
    await opts.deps.readLatin(boxesWhere(state, stageRules));
    code = bottomCode(linesOf(state), opts.sets);
    scores = latinScores(linesOf(state));
    best = argmax();
  }
  if (scores[best] >= strong) {
    if (code && code in scores && code !== best && scores[best] < 2 * strong) best = code;
    return { lang: best, how: 'words' + (code ? ` (code ${code})` : '') };
  }
  const other = await opts.deps.otherScripts();
  // Scryfall is asked only when a name was read (as the trainer does).
  const byName = async (among?: readonly Lang[]) => {
    const text = nameText(state, other);
    if (!text || !opts.name) return null;
    return languageByName(text, await opts.deps.printedNames(opts.name), among);
  };
  if (other) {
    if (other.script === 'kana') return { lang: 'ja', how: 'script' };
    if (other.script === 'hangul') return { lang: 'ko', how: 'script' };
    if (other.script === 'cyrillic') return { lang: 'ru', how: 'script' };
    if (code === 'zhs' || code === 'zht') return { lang: code, how: 'script + code' };
    if (code === 'ja') return { lang: 'ja', how: 'code (script han)' };
    const text = other.texts.join('');
    let si = 0;
    let tr = 0;
    for (const c of text) {
      si += SIMP.has(c) ? 1 : 0;
      tr += TRAD.has(c) ? 1 : 0;
    }
    if (Math.abs(si - tr) < 2) {
      const n = await byName(['zhs', 'zht']);
      if (n) return { lang: n, how: `script + name (simplified ${si}, traditional ${tr})` };
    }
    return { lang: tr > si ? 'zht' : 'zhs', how: `script (simplified ${si}, traditional ${tr})` };
  }
  if (code) return { lang: code, how: 'code' };
  if (opts.name) await opts.deps.readLatin(boxesWhere(state, stageName));
  const n = await byName();
  if (n) return { lang: n, how: 'name' };
  if (scores[best] > 0) return { lang: best, how: 'few words' };
  return { lang: 'en', how: 'nothing read' };
}
