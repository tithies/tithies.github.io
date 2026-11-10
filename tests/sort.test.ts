import { compareValues } from '@/lib/sort';

describe('compareValues', () => {
  it('treats none as the smallest value', () => {
    // (Array.sort always puts bare `undefined` elements last, so it's checked directly below.)
    const vals = [3, null, 1, NaN, 2];
    expect([...vals].sort(compareValues)).toEqual([null, NaN, 1, 2, 3]);
    expect([...vals].sort((a, b) => -compareValues(a, b))).toEqual([3, 2, 1, null, NaN]);
    expect(compareValues(undefined, 0)).toBeLessThan(0);
    expect(compareValues(undefined, null)).toBe(0);
    expect(['b', '', 'a10', 'a9'].sort(compareValues)).toEqual(['', 'a9', 'a10', 'b']);
  });
});
