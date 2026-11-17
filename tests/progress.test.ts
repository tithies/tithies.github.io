import { overallPercent, StepTally } from '@/lib/changes/progress';

describe('StepTally (one progress over every step)', () => {
  it('sizes steps by their estimates until they run, then by what they report', () => {
    const t = new StepTally([2, 3, 1]);
    expect(t.overall).toEqual({ done: 0, total: 6, step: 1, steps: 3 });
    t.report(0, 1, 2);
    expect(t.report(0, 2, 2)).toEqual({ done: 2, total: 6, step: 1, steps: 3 });
    // The read had more pages than estimated: the total grows.
    expect(t.report(0, 3, 5)).toEqual({ done: 3, total: 9, step: 1, steps: 3 });
  });

  it('an ended step counts what it did; a running one never less than its estimate', () => {
    const t = new StepTally([1, 4, 3]);
    t.report(0, 0, 0);
    // Only 0 pages read: once the next step runs, the first counts 0.
    expect(t.report(1, 0, 4)).toEqual({ done: 0, total: 7, step: 2, steps: 3 });
    t.report(1, 4, 4);
    // The check reports "1 page so far" while it reads: still sized 3 until it ends.
    expect(t.report(2, 0, 1)).toEqual({ done: 4, total: 7, step: 3, steps: 3 });
    expect(t.report(2, 1, 1)).toEqual({ done: 5, total: 7, step: 3, steps: 3 });
    expect(t.finish()).toEqual({ done: 5, total: 5, step: 3, steps: 3 });
  });

  it('a better estimate replaces one, for steps not started yet', () => {
    const t = new StepTally([1, 1, 1]);
    t.report(0, 1, 1);
    t.expect(0, 50);
    t.expect(1, 10);
    t.expect(2, 2);
    expect(t.overall).toEqual({ done: 1, total: 13, step: 1, steps: 3 });
  });

  it('a count going back down is another read within the step: it adds up, never back', () => {
    const t = new StepTally([0, 0, 2]);
    // Only the changes (2 pages), then every page (5) after a deletion.
    t.report(2, 1, 2);
    t.report(2, 2, 2);
    expect(t.report(2, 1, 5)).toEqual({ done: 3, total: 7, step: 3, steps: 3 });
    expect(t.report(2, 5, 5)).toEqual({ done: 7, total: 7, step: 3, steps: 3 });
  });

  it('ignores nonsense sizes', () => {
    const t = new StepTally([Number.NaN, -3, Infinity]);
    expect(t.overall).toEqual({ done: 0, total: 1, step: 1, steps: 3 });
  });

  it('shows 100% only once over', () => {
    expect(overallPercent({ done: 10, total: 10 })).toBe(99);
    expect(overallPercent({ done: 10, total: 10 }, true)).toBe(100);
    expect(overallPercent({ done: 1, total: 3 })).toBe(33);
    expect(overallPercent({ done: 0, total: 0 })).toBe(0);
  });
});
