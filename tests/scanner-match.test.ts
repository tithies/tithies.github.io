import { l2normalize, nameMargin, topKCosine, topKHamming } from '@/features/scanner/match';
import { grayFromRGBA, hamming, phash, phash32, resizeGray } from '@/features/scanner/phash';

describe('pHash', () => {
  /** A 64×64 grey picture: a bright square on a gradient. */
  function picture(shift = 0, noise = 0): Float32Array {
    const out = new Float32Array(64 * 64);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * noise;
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) out[y * 64 + x] = x * 2 + (x > 20 + shift && x < 44 + shift && y > 16 && y < 40 ? 120 : 0) + rand();
    return out;
  }

  it('is stable under noise and differs for another picture', () => {
    const a = phash(picture(), 64, 64);
    expect(hamming(a, phash(picture(0, 8), 64, 64))).toBeLessThanOrEqual(4);
    const other = new Float32Array(64 * 64).map((_, i) => ((i % 64) < 32 ? 200 : 20) + Math.floor(i / 64));
    expect(hamming(a, phash(other, 64, 64))).toBeGreaterThan(12);
  });

  it('needs a 32×32 input for the core hash', () => {
    expect(() => phash32(new Float32Array(10))).toThrow();
  });

  it('converts RGBA to grey and shrinks by averaging', () => {
    const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
    expect(Array.from(grayFromRGBA(rgba, 2, 1)).map(Math.round)).toEqual([255, 0]);
    expect(Array.from(resizeGray(new Float32Array([0, 10, 20, 30]), 2, 2, 1, 1))).toEqual([15]);
  });
});

describe('nearest prints', () => {
  const refs = [l2normalize(new Float32Array([1, 0, 0])), l2normalize(new Float32Array([0.9, 0.1, 0])), l2normalize(new Float32Array([0, 1, 0])), l2normalize(new Float32Array([0, 0, 1]))];
  const matrix = new Float32Array(refs.flatMap((r) => Array.from(r)));

  it('ranks by cosine, best first', () => {
    const hits = topKCosine(l2normalize(new Float32Array([1, 0.05, 0])), matrix, 3, 3);
    expect(hits.map((h) => h.index)).toEqual([0, 1, 2]);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
    expect(() => topKCosine(new Float32Array(2), matrix, 3, 1)).toThrow();
  });

  it('ranks hashes by differing bits', () => {
    const hashes = new Uint32Array([0, 0, 0xff, 0, 0xffffffff, 0xffffffff]);
    const hits = topKHamming(new Uint32Array([1, 0]), hashes, 2);
    expect(hits.map((h) => h.index)).toEqual([0, 1]);
    expect(hits[0].score).toBeCloseTo(1 - 1 / 64, 6);
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
