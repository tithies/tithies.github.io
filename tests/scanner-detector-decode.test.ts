import { decodeDetector } from '@/features/scanner/detector-decode';
import { quadIoU, type Quad } from '@/features/scanner/geometry';

const STRIDE = 4;

/** Detector outputs with one card per entry: its centre cell, corners (input pixels) and score. */
function outputs(gw: number, gh: number, cards: { quad: Quad; score: number }[]) {
  const heat = new Float32Array(gw * gh);
  const corners = new Float32Array(8 * gw * gh);
  for (const c of cards) {
    const cx = c.quad.reduce((s, p) => s + p.x, 0) / 4;
    const cy = c.quad.reduce((s, p) => s + p.y, 0) / 4;
    const x = Math.floor(cx / STRIDE);
    const y = Math.floor(cy / STRIDE);
    // A small blob around the centre, peak at the centre cell; corners stored there and around it.
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const i = (y + dy) * gw + (x + dx);
        heat[i] = Math.max(heat[i], dx || dy ? c.score * 0.6 : c.score);
        c.quad.forEach((p, k) => {
          corners[2 * k * gw * gh + i] = p.x - (x + dx + 0.5) * STRIDE;
          corners[(2 * k + 1) * gw * gh + i] = p.y - (y + dy + 0.5) * STRIDE;
        });
      }
  }
  return { heat, corners };
}

const rect = (x: number, y: number, w: number, h: number): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];

describe('decodeDetector', () => {
  it('reads each card at its peak, best first, with its corners', () => {
    const a = rect(20, 20, 63, 88);
    const b = rect(150, 40, 63, 88);
    const { heat, corners } = outputs(64, 48, [
      { quad: a, score: 0.7 },
      { quad: b, score: 0.95 },
    ]);
    const found = decodeDetector(heat, corners, 64, 48, { stride: STRIDE, threshold: 0.3 });
    expect(found.map((f) => Math.round(f.score * 100) / 100)).toEqual([0.95, 0.7]);
    expect(quadIoU(found[0].quad, b)).toBeGreaterThan(0.99);
    expect(quadIoU(found[1].quad, a)).toBeGreaterThan(0.99);
  });

  it('drops answers under the threshold, and duplicates of one card', () => {
    const a = rect(20, 20, 63, 88);
    const { heat, corners } = outputs(64, 48, [{ quad: a, score: 0.2 }]);
    expect(decodeDetector(heat, corners, 64, 48, { stride: STRIDE, threshold: 0.3 })).toEqual([]);
    // Two peaks (a plateau) for the same card: one answer.
    const o = outputs(64, 48, [{ quad: a, score: 0.8 }]);
    const x = Math.floor((20 + 31.5) / STRIDE);
    const y = Math.floor((20 + 44) / STRIDE);
    o.heat[y * 64 + x + 1] = 0.8;
    expect(decodeDetector(o.heat, o.corners, 64, 48, { stride: STRIDE, threshold: 0.3 })).toHaveLength(1);
  });

  it('refuses outputs of the wrong size', () => {
    expect(() => decodeDetector(new Float32Array(4), new Float32Array(8), 64, 48, { stride: 4, threshold: 0.3 })).toThrow();
  });
});
