import { readFileSync } from 'node:fs';
import { bottomCode, boxesWhere, languageOf, linesOf, nearCode, scriptOf, similarity, stageFirst, type OtherReading, type TextState } from '@/features/scanner/language';
import type { CardMatch } from '@/features/scanner/pipeline';
import { afterVisual, beforeVisual, digits, printed, readBottom } from '@/features/scanner/print-check';
import type { TextBoxGeo } from '@/features/scanner/protocol';

// Written by the trainer from real readings: python -m trainer verify fixture --out tests/fixtures/scanner-check.
// Each case is one card read in stages as the page does: the boxes found, the Latin readings of the boxes the
// trainer read (box → text), the other scripts' reading, the printed names and the visual check's result it used,
// and what its rules decided. The extension's rules must read the same boxes and decide the same.
interface Case {
  boxes: TextBoxGeo[];
  first: number[];
  latin: Record<string, { text: string; conf: number }>;
  sets: string[];
  name: string | null;
  other: OtherReading | null;
  names: Record<string, string[]> | null;
  lang: string;
  how: string;
  truth: string | null;
  print?: { hits: CardMatch[]; used: number[]; visual: { winner: number | null; margin: number } | null; pick: number; how: string };
}
const cases = (JSON.parse(readFileSync(`${__dirname}/fixtures/scanner-check/cases.json`, 'utf8')) as { cases: Case[] }).cases;

/** A case's text state with the first stage read, and a reader that reads more from the trainer's readings. */
function staged(c: Case) {
  const state: TextState = { boxes: c.boxes, lines: new Map() };
  const missing: number[] = [];
  const readLatin = async (idx: number[]) => {
    for (const i of idx) {
      if (state.lines.has(i)) continue;
      const l = c.latin[String(i)];
      if (!l) missing.push(i);
      else state.lines.set(i, { ...c.boxes[i], ...l });
    }
  };
  return { state, missing, readLatin };
}

const label = (c: Case) => c.print?.hits[0]?.name ?? c.name ?? '?';

describe('phase 3 rules decide as the trainer does', () => {
  it('has the cases', () => {
    expect(cases.length).toBeGreaterThan(20);
    expect(cases.filter((c) => c.print).length).toBeGreaterThan(5);
  });

  it('reads the same boxes first', () => {
    const diff = cases.filter((c) => JSON.stringify(boxesWhere({ boxes: c.boxes, lines: new Map() }, stageFirst)) !== JSON.stringify(c.first)).map(label);
    expect(diff).toEqual([]);
  });

  it('prints', async () => {
    const diff: string[] = [];
    for (const c of cases) {
      if (!c.print) continue;
      const { state, readLatin } = staged(c);
      await readLatin(c.first);
      const b = beforeVisual(c.print.hits, linesOf(state));
      const d = b.decided ?? afterVisual(b.pool, b.narrowed, c.print.used, c.print.visual, b.read);
      if (d.pick !== c.print.pick || d.how !== c.print.how) diff.push(`${label(c)}: ${d.pick} (${d.how}) instead of ${c.print.pick} (${c.print.how})`);
    }
    expect(diff).toEqual([]);
  });

  it('languages, reading only the boxes the trainer read', async () => {
    const diff: string[] = [];
    for (const c of cases) {
      const { state, missing, readLatin } = staged(c);
      await readLatin(c.first);
      const got = await languageOf(state, { sets: c.sets, name: c.name, deps: { readLatin, otherScripts: async () => c.other, printedNames: async () => c.names } });
      if (got.lang !== c.lang || got.how !== c.how) diff.push(`${label(c)}: ${got.lang} (${got.how}) instead of ${c.lang} (${c.how})`);
      if (missing.length) diff.push(`${label(c)}: read boxes ${missing.join(', ')} the trainer didn't`);
      if (state.lines.size !== Object.keys(c.latin).length) diff.push(`${label(c)}: read ${state.lines.size} boxes, the trainer ${Object.keys(c.latin).length}`);
    }
    expect(diff).toEqual([]);
  });
});

describe('phase 3 helpers', () => {
  it('reads printed sets and numbers', () => {
    expect(digits('0283')).toBe('283');
    expect(digits('38p')).toBe('38');
    expect(printed({ set: 'plst', cn: 'C13-29' })).toEqual(['C13', '29']);
    expect(printed({ set: 'pbro', cn: '38p' })).toEqual(['BRO', '38']);
    const line = (text: string) => ({ y: 0.95, x: 0.07, h: 0.02, text, conf: 0.9 });
    expect([...readBottom([line('U0040'), line('MULENWOLFSKULLIACK')]).numbers]).toEqual(['40']);
    expect([...readBottom([line('283 R'), line('C21·ENJIM NELSON')]).numbers]).toEqual(['283']);
    expect([...readBottom([line('TM & © 2013 Wizards of the Coast 29/356')]).numbers]).toEqual(['29']);
  });

  it('tells scripts and near set codes', () => {
    expect(scriptOf('クリーチャー — 天使')).toBe('kana');
    expect(scriptOf('생물 — 천사')).toBe('hangul');
    expect(scriptOf('Существо — Ангел')).toBe('cyrillic');
    expect(scriptOf('生物 ～天使')).toBe('han');
    expect(nearCode('LTRO', 'LTR')).toBe(true);
    expect(nearCode('MM', 'CMM')).toBe(true);
    expect(nearCode('PTX', 'LTR')).toBe(false);
    const bottom = (text: string) => [{ y: 0.95, x: 0.07, h: 0.02, text, conf: 0.9 }];
    expect(bottomCode(bottom('ERIC DESCHAMPS TM & © 1993-2012 WIZARDS OF THE COAST LLC 24/244'), ['AVR', 'MIC'])).toBe(null);
    expect(bottomCode(bottom('R 0216 TDCENSVETLIN VELINOV'), ['TDC'])).toBe('en');
    expect(bottomCode(bottom('U0315CMMFR'), ['CMM'])).toBe('fr');
    expect(similarity('Cotte de mithril', 'Cotte de mithril')).toBe(1);
    expect(similarity('Mithril Coat', 'Cotte de mithril')).toBeLessThan(0.3);
  });
});
