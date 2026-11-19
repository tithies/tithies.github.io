import { CARD_RATIO, quadIoU, type Point, type Quad } from '@/features/scanner/geometry';
import { angleBetween, intersect, lineQuads, mergeSegments, type Segment } from '@/features/scanner/lines';

const DEG = Math.PI / 180;

/** An edge map: points within 2 px of the given segments. */
function edgeMap(segs: Segment[]) {
  return (x: number, y: number) =>
    segs.some((s) => {
      const dx = s.x2 - s.x1;
      const dy = s.y2 - s.y1;
      const t = Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(s.x1 + t * dx - x, s.y1 + t * dy - y) <= 2;
    });
}

const sides = (q: Point[]): Segment[] => q.map((p, i) => ({ x1: p.x, y1: p.y, x2: q[(i + 1) % 4].x, y2: q[(i + 1) % 4].y }));

/** An upright card's corners: top-left, width (height from the card ratio). */
function cardAt(x: number, y: number, w: number): Quad {
  const h = w / CARD_RATIO;
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

describe('lines', () => {
  it('merges the broken pieces of one edge, across the 0/π wrap', () => {
    const lines = mergeSegments(
      [
        { x1: 0, y1: 100, x2: 200, y2: 101 },
        { x1: 260, y1: 101, x2: 500, y2: 102 },
        // The same edge drawn the other way (angle ≈ π).
        { x1: 900, y1: 104, x2: 600, y2: 103 },
        { x1: 0, y1: 300, x2: 500, y2: 300 },
      ],
      5,
    );
    expect(lines).toHaveLength(2);
    expect(lines[0].length).toBeCloseTo(200 + 240 + 300, -1);
    expect(angleBetween(lines[0].theta, 0)).toBeLessThan(DEG);
  });

  it('crosses two lines', () => {
    const [h] = mergeSegments([{ x1: 0, y1: 50, x2: 100, y2: 50 }], 5);
    const [v] = mergeSegments([{ x1: 30, y1: 0, x2: 30, y2: 100 }], 5);
    const p = intersect(h, v)!;
    expect(p.x).toBeCloseTo(30, 6);
    expect(p.y).toBeCloseTo(50, 6);
    expect(intersect(h, h)).toBeNull();
  });

  it('finds a card among clutter, and its toploader, but not quads with a side on nothing', () => {
    const cardQ = cardAt(200, 150, 400);
    const top = cardAt(160, 100, 480);
    // Card sides broken in places (glare), the toploader's full outline, two clutter lines.
    const segs: Segment[] = [
      ...sides(cardQ).flatMap((s) => [
        { x1: s.x1, y1: s.y1, x2: s.x1 + (s.x2 - s.x1) * 0.45, y2: s.y1 + (s.y2 - s.y1) * 0.45 },
        { x1: s.x1 + (s.x2 - s.x1) * 0.55, y1: s.y1 + (s.y2 - s.y1) * 0.55, x2: s.x2, y2: s.y2 },
      ]),
      ...sides(top),
      { x1: 0, y1: 900, x2: 800, y2: 880 },
      { x1: 700, y1: 0, x2: 720, y2: 900 },
    ];
    const quads = lineQuads(mergeSegments(segs, 6), { width: 800, height: 1000, onEdge: edgeMap(segs) });
    const best = (q: Quad) => Math.max(...quads.map((x) => quadIoU(x.quad, q)));
    expect(best(cardQ)).toBeGreaterThan(0.95);
    expect(best(top)).toBeGreaterThan(0.95);
    // Every quad found has all four sides on edges: none uses a clutter line as a side
    // without support (the clutter lines cross the photo, so their quads miss edges).
    for (const q of quads) expect(q.support).toBeGreaterThanOrEqual(0.6);
    expect(quads.every((q) => q.quad.every((p) => p.y < 960))).toBe(true);
  });
});
