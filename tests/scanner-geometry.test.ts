import {
  CARD_RATIO,
  boundingBox,
  coverage,
  dedupe,
  dropFragments,
  dropGroups,
  inferGridCells,
  isConvex,
  orderCorners,
  polygonArea,
  quadIoU,
  quadSize,
  rejectReason,
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

  it('rejects shapes that are not cards', () => {
    const area = 1000 * 1000;
    expect(rejectReason(card(500, 500, 200), area)).toBeNull();
    expect(rejectReason(card(500, 500, 10), area)).toBe('tooSmall');
    expect(rejectReason(card(500, 500, 900), area)).toBe('tooLarge');
    const square: Quad = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 300, y: 300 },
      { x: 0, y: 300 },
    ];
    expect(rejectReason(square, area)).toBe('ratio');
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

describe('dedupe', () => {
  it('keeps the card inside its sleeve, drops what is inside a card, keeps separate cards', () => {
    const sleeve = { quad: card(100, 100, 66), score: 0.9, id: 'sleeve' };
    const inner = { quad: card(100, 100, 63), score: 0.8, id: 'card' };
    const artBox = { quad: card(100, 85, 50), score: 0.7, id: 'art' };
    const other = { quad: card(300, 100, 63), score: 0.5, id: 'other' };
    const kept = dedupe([artBox, sleeve, other, inner]).map((c) => c.id);
    expect(kept.sort()).toEqual(['card', 'other']);
  });

  it('keeps the better of two overlapping shapes', () => {
    const a = { quad: card(100, 100, 63), score: 0.4, id: 'a' };
    const b = { quad: card(110, 100, 63), score: 0.9, id: 'b' };
    expect(dedupe([a, b]).map((c) => c.id)).toEqual(['b']);
  });
});

describe('inferGridCells', () => {
  const pitchX = 70;
  const pitchY = 95;
  /** A 3×3 binder page, rotated a little, with some cells missing. */
  function page(missing: [number, number][], deg = 3): { found: Quad[]; all: Map<string, Quad> } {
    const a = (deg * Math.PI) / 180;
    const all = new Map<string, Quad>();
    for (let col = 0; col < 3; col++)
      for (let row = 0; row < 3; row++) {
        const dx = col * pitchX;
        const dy = row * pitchY;
        all.set(`${col},${row}`, orderCorners(card(300 + dx * Math.cos(a) - dy * Math.sin(a), 200 + dx * Math.sin(a) + dy * Math.cos(a), 63, deg)));
      }
    const skip = new Set(missing.map(([c, r]) => `${c},${r}`));
    return { found: [...all].filter(([k]) => !skip.has(k)).map(([, q]) => q), all };
  }

  it('fills the empty cells of a binder page', () => {
    const { found, all } = page([
      [1, 1],
      [2, 0],
    ]);
    const cells = inferGridCells(found);
    expect(cells.map((c) => `${c.col},${c.row}`).sort()).toEqual(['1,1', '2,0']);
    for (const c of cells) {
      const truth = all.get(`${c.col},${c.row}`)!;
      expect(quadIoU(c.quad, truth)).toBeGreaterThan(0.9);
    }
  });

  it('infers nothing for a full grid, too few cards, or cards that are not on a grid', () => {
    expect(inferGridCells(page([]).found)).toEqual([]);
    expect(inferGridCells(page([[0, 0]]).found.slice(0, 3))).toEqual([]);
    const scattered = [card(100, 100, 63, 0), card(400, 130, 63, 25), card(180, 420, 63, -40), card(500, 500, 63, 70), card(260, 260, 63, 10)].map(orderCorners);
    expect(inferGridCells(scattered)).toEqual([]);
  });

  it('ignores cards of another size', () => {
    const { found } = page([[1, 1]]);
    const cells = inferGridCells([...found, orderCorners(card(1000, 1000, 200))]);
    expect(cells.map((c) => `${c.col},${c.row}`)).toEqual(['1,1']);
  });
});

describe('dropGroups', () => {
  const rect = (x0: number, y0: number, x1: number, y1: number): Quad =>
    orderCorners([
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ]);

  it('drops the outline around two touching cards, keeps the cards', () => {
    const left = { quad: rect(0, 0, 63, 88), score: 0.9, id: 'left' };
    const right = { quad: rect(65, 0, 128, 88), score: 0.9, id: 'right' };
    // The pair's outline: 128 × 88, a "sideways card" (0.69).
    const pair = { quad: rect(0, 0, 128, 88), score: 0.95, id: 'pair' };
    expect(quadSize(pair.quad).ratio).toBeGreaterThan(0.6);
    expect(dropGroups([pair, left, right]).map((c) => c.id).sort()).toEqual(['left', 'right']);
  });

  it('drops a 2×2 block of cards', () => {
    const cards = [rect(0, 0, 63, 88), rect(65, 0, 128, 88), rect(0, 90, 63, 178), rect(65, 90, 128, 178)].map((quad, i) => ({ quad, score: 0.9, id: `c${i}` }));
    const block = { quad: rect(0, 0, 128, 178), score: 0.9, id: 'block' };
    expect(dropGroups([block, ...cards]).map((c) => c.id)).not.toContain('block');
  });

  it('keeps a card that holds one card-shaped part (its art box)', () => {
    const c = { quad: rect(0, 0, 63, 88), score: 0.9, id: 'card' };
    const art = { quad: rect(5, 10, 58, 48), score: 0.8, id: 'art' };
    expect(dropGroups([c, art]).map((x) => x.id).sort()).toEqual(['art', 'card']);
  });
});

describe('dropFragments', () => {
  it('drops pieces much smaller than the other cards, and pieces inside a grid cell', () => {
    const cards = [card(100, 100, 63), card(200, 100, 63), card(300, 100, 63)].map((quad, i) => ({ quad, score: 0.9, id: `c${i}` }));
    const piece = { quad: card(400, 100, 20), score: 0.9, id: 'piece' };
    expect(dropFragments([...cards, piece]).map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);
    // Two cards only: sizes can't be judged.
    expect(dropFragments([cards[0], piece])).toHaveLength(2);
    // Inside an inferred cell.
    expect(dropFragments([cards[0], piece], [card(400, 100, 63)]).map((c) => c.id)).toEqual(['c0']);
  });
});
