import {
  CARD_RATIO,
  boundingBox,
  coverage,
  isConvex,
  orderCorners,
  polygonArea,
  quadIoU,
  quadSize,
  type Point,
  type Quad,
} from '@/features/scanner/geometry';

/** A card-shaped quad: centre, width (height from the card ratio), rotation in degrees. */
function card(cx: number, cy: number, w: number, deg = 0): Quad {
  const h = w / CARD_RATIO;
  const a = (deg * Math.PI) / 180;
  const pt = (dx: number, dy: number): Point => ({ x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) });
  return [pt(-w / 2, -h / 2), pt(w / 2, -h / 2), pt(w / 2, h / 2), pt(-w / 2, h / 2)];
}

const close = (a: Point, b: Point, eps = 1e-6) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps;

describe('orderCorners', () => {
  it('orders any permutation clockwise from the top-left, short side first', () => {
    const q = card(100, 100, 63);
    for (const perm of [
      [2, 0, 3, 1],
      [3, 2, 1, 0],
      [1, 3, 0, 2],
    ]) {
      const out = orderCorners(perm.map((i) => q[i]));
      out.forEach((p, i) => expect(close(p, q[i])).toBe(true));
    }
  });

  it('turns a card lying sideways so its first side is a short one', () => {
    const q = orderCorners(card(200, 200, 63, 90));
    const { w, h, ratio } = quadSize(q);
    expect(w).toBeLessThan(h);
    expect(ratio).toBeCloseTo(CARD_RATIO, 5);
  });

  it('refuses anything but 4 points', () => {
    expect(() => orderCorners([{ x: 0, y: 0 }])).toThrow();
  });
});

describe('shapes', () => {
  it('measures area, convexity and bounding box', () => {
    const sq: Quad = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(polygonArea(sq)).toBe(100);
    expect(isConvex(sq)).toBe(true);
    expect(isConvex([sq[0], sq[2], sq[1], sq[3]])).toBe(false);
    expect(boundingBox(card(50, 50, 20, 45))).toMatchObject({ x: expect.any(Number), w: expect.any(Number) });
  });

  it('computes the overlap of two quads', () => {
    expect(quadIoU(card(100, 100, 50), card(100, 100, 50))).toBeCloseTo(1, 6);
    expect(quadIoU(card(100, 100, 50), card(400, 100, 50))).toBe(0);
    const half = quadIoU(card(100, 100, 50), card(125, 100, 50));
    expect(half).toBeGreaterThan(0.3);
    expect(half).toBeLessThan(0.4);
    expect(coverage(card(100, 100, 40), card(100, 100, 50))).toBeCloseTo(1, 6);
  });
});
