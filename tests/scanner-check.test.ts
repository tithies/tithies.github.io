import { readFileSync } from 'node:fs';
import { languageOf, nearCode, scriptOf, similarity, type OtherReading } from '@/features/scanner/language';
import type { CardMatch } from '@/features/scanner/pipeline';
import { afterVisual, beforeVisual, digits, printed, readBottom } from '@/features/scanner/print-check';
import type { TextLineRead } from '@/features/scanner/protocol';

// Written by the trainer from real readings: python -m trainer verify fixture --out tests/fixtures/scanner-check.
// Each case holds the lines read (and the other scripts' readings, printed names and visual results it used) and
// what the trainer's rules decided; the extension's rules must decide the same.
interface Cases {
  language: { lines: TextLineRead[]; sets: string[]; name: string | null; other: OtherReading | null; names: Record<string, string[]> | null; want: string; how: string; truth: string | null }[];
  print: { hits: CardMatch[]; lines: TextLineRead[]; used: number[]; visual: { winner: number | null; margin: number } | null; pick: number; how: string }[];
}
const cases = JSON.parse(readFileSync(`${__dirname}/fixtures/scanner-check/cases.json`, 'utf8')) as Cases;

describe('phase 3 rules decide as the trainer does', () => {
  it('languages', async () => {
    expect(cases.language.length).toBeGreaterThan(20);
    const diff: string[] = [];
    for (const c of cases.language) {
      const got = await languageOf(c.lines, { sets: c.sets, name: c.name, deps: { otherScripts: async () => c.other, printedNames: async () => c.names } });
      if (got.lang !== c.want || got.how !== c.how) diff.push(`${c.name}: ${got.lang} (${got.how}) instead of ${c.want} (${c.how})`);
    }
    expect(diff).toEqual([]);
  });

  it('prints', () => {
    expect(cases.print.length).toBeGreaterThan(5);
    const diff: string[] = [];
    for (const c of cases.print) {
      const b = beforeVisual(c.hits, c.lines);
      const d = b.decided ?? afterVisual(b.pool, b.narrowed, c.used, c.visual, b.read);
      if (d.pick !== c.pick || d.how !== c.how) diff.push(`${c.hits[0].name}: ${d.pick} (${d.how}) instead of ${c.pick} (${c.how})`);
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
    expect(similarity('Cotte de mithril', 'Cotte de mithril')).toBe(1);
    expect(similarity('Mithril Coat', 'Cotte de mithril')).toBeLessThan(0.3);
  });
});
