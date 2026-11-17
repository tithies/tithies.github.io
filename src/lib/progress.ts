/**
 * One progress for a background job made of steps (an export: read, send the changes, check; a
 * sync: the deck list, the decks, the collection), counted in requests: pages read and changes
 * sent, which all go at the site's pace. A step is sized by an estimate
 * until it runs, then by what it reports, never less than the estimate while it runs (reads only
 * learn their page count as they go): the bar may jump forward when a step ends early, never back.
 */

/** A job's progress over all its steps, in requests (pages read, changes sent); `step` of `steps` runs. */
export interface OverallProgress {
  done: number;
  total: number;
  step: number;
  steps: number;
}

const size = (n: number) => (Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 1_000_000) : 0);

export class StepTally {
  private readonly steps: { done: number; total: number; expected: number; base: number; last: number }[];
  private current = -1;

  constructor(estimates: readonly number[]) {
    this.steps = estimates.map((e) => ({ done: 0, total: size(e), expected: size(e), base: 0, last: 0 }));
  }

  /** A better estimate of a step that hasn't started. */
  expect(step: number, total: number): void {
    const s = this.steps[step];
    if (!s || step <= this.current) return;
    s.expected = s.total = size(total);
  }

  /**
   * Step `step` has done `done` of `total`. Earlier steps are over: they count what they did. A
   * count that goes back down is another read within the step (every page after the changes):
   * it adds to what the step already did.
   */
  report(step: number, done: number, total: number): OverallProgress {
    const s = this.steps[step];
    if (!s) return this.overall;
    if (step > this.current) {
      for (let i = 0; i < step; i++) this.steps[i].total = this.steps[i].done;
      this.current = step;
    }
    const d = size(done);
    if (d < s.last) s.base += s.last;
    s.last = d;
    s.done = s.base + d;
    s.total = Math.max(s.base + size(total), s.done, s.expected);
    return this.overall;
  }

  /** Every step is over (the step stays the last one that ran: a step may not be needed). */
  finish(): OverallProgress {
    for (const s of this.steps) s.total = s.done;
    return this.overall;
  }

  get overall(): OverallProgress {
    const done = this.steps.reduce((t, s) => t + s.done, 0);
    const total = this.steps.reduce((t, s) => t + s.total, 0);
    return { done, total: Math.max(total, done, 1), step: Math.max(this.current, 0) + 1, steps: this.steps.length };
  }
}

/** Percent done, the same for every job: whole numbers, 99 at most until it is over (the last request is still to answer). */
export const overallPercent = (o: Pick<OverallProgress, 'done' | 'total'>, over = false): number =>
  over ? 100 : Math.min(99, Math.floor((100 * o.done) / Math.max(o.total, 1)));
