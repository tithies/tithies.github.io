import { l2normalize, nameMargin, topKCosine } from '@/features/scanner/match';

describe('nearest prints', () => {
  const refs = [l2normalize(new Float32Array([1, 0, 0])), l2normalize(new Float32Array([0.9, 0.1, 0])), l2normalize(new Float32Array([0, 1, 0])), l2normalize(new Float32Array([0, 0, 1]))];
  const matrix = new Float32Array(refs.flatMap((r) => Array.from(r)));

  it('ranks by cosine, best first', () => {
    const hits = topKCosine(l2normalize(new Float32Array([1, 0.05, 0])), matrix, 3, 3);
    expect(hits.map((h) => h.index)).toEqual([0, 1, 2]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(() => topKCosine(new Float32Array(2), matrix, 3, 1)).toThrow();
  });

  it('measures the lead over the first other name', () => {
    const names = ['Sol Ring', 'Sol Ring', 'Counterspell'];
    const hits = [
      { index: 0, score: 0.9 },
      { index: 1, score: 0.85 },
      { index: 2, score: 0.6 },
    ];
    expect(nameMargin(hits, (i) => names[i])).toBeCloseTo(0.3, 6);
    expect(nameMargin(hits.slice(0, 2), (i) => names[i])).toBeCloseTo(0.05, 6);
    expect(nameMargin([], (i) => names[i])).toBe(0);
  });
});
