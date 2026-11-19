/**
 * Card-shaped quadrilaterals found in a photo: corner order, shape checks, overlaps, duplicates,
 * and the binder-page grid (cells the detector missed, inferred from the cards it found).
 * Pure functions (no OpenCV), so they are unit-tested in Node.
 */

export interface Point {
  x: number;
  y: number;
}

/** Corners clockwise from the card's top-left: top-left, top-right, bottom-right, bottom-left (card upright, short side on top). */
export type Quad = [Point, Point, Point, Point];

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A Magic card is 63 × 88 mm: width ÷ height. */
export const CARD_RATIO = 63 / 88;

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

export function centroid(pts: readonly Point[]): Point {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/**
 * Orders 4 corners clockwise (on screen, y down) starting from the top-left-most one, then turns
 * the order a quarter if needed so the first side (top-left → top-right) is a short side: the card
 * reads upright, or upside down (which matching tells apart).
 */
export function orderCorners(pts: readonly Point[]): Quad {
  if (pts.length !== 4) throw new Error(`A card has 4 corners, got ${pts.length}`);
  const c = centroid(pts);
  // atan2 grows clockwise on screen (y points down).
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x));
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  let q = [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]) as Quad;
  if (dist(q[0], q[1]) + dist(q[2], q[3]) > dist(q[1], q[2]) + dist(q[3], q[0])) q = [q[1], q[2], q[3], q[0]];
  return q;
}

/** Mean width and height (opposite sides averaged), and width ÷ height. */
export function quadSize(q: Quad): { w: number; h: number; ratio: number } {
  const w = (dist(q[0], q[1]) + dist(q[2], q[3])) / 2;
  const h = (dist(q[1], q[2]) + dist(q[3], q[0])) / 2;
  return { w, h, ratio: h > 0 ? w / h : 0 };
}

/** Polygon area (shoelace), always positive. */
export function polygonArea(pts: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

export function isConvex(pts: readonly Point[]): boolean {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const c = pts[(i + 2) % pts.length];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-9) continue;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

export function boundingBox(pts: readonly Point[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function scaleQuad(q: Quad, s: number): Quad {
  return q.map((p) => ({ x: p.x * s, y: p.y * s })) as Quad;
}

/** Signed area of a polygon, positive when clockwise on screen (y down). */
function signedArea(pts: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** The part of convex polygon `subject` inside convex polygon `clip` (Sutherland–Hodgman). */
function clipConvex(subject: readonly Point[], clip: readonly Point[]): Point[] {
  const cw = signedArea(clip) > 0;
  let out = [...subject];
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i];
    const b = clip[(i + 1) % clip.length];
    const side = (p: Point) => {
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
      return cw ? cross : -cross;
    };
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const p = input[j];
      const q = input[(j + 1) % input.length];
      const sp = side(p);
      const sq = side(q);
      if (sp >= 0) out.push(p);
      if ((sp >= 0) !== (sq >= 0)) {
        const t = sp / (sp - sq);
        out.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
      }
    }
  }
  return out;
}

/** Area shared by two convex quads. */
export function intersectionArea(a: Quad, b: Quad): number {
  const inter = clipConvex(a, b);
  return inter.length >= 3 ? polygonArea(inter) : 0;
}

/** Intersection over union of two convex quads (0: apart, 1: the same). */
export function quadIoU(a: Quad, b: Quad): number {
  const inter = intersectionArea(a, b);
  const union = polygonArea(a) + polygonArea(b) - inter;
  return union > 0 ? inter / union : 0;
}

/** How much of `inner` lies inside `outer` (0–1). */
export function coverage(inner: Quad, outer: Quad): number {
  const area = polygonArea(inner);
  return area > 0 ? intersectionArea(inner, outer) / area : 0;
}

export interface ShapeLimits {
  /** Width ÷ height range a card may show (perspective and tilt allowed). */
  minRatio: number;
  maxRatio: number;
  /** Card area range, as a share of the photo's area. */
  minAreaShare: number;
  maxAreaShare: number;
}

export const DEFAULT_LIMITS: ShapeLimits = { minRatio: 0.55, maxRatio: 0.9, minAreaShare: 0.0008, maxAreaShare: 0.9 };

export type RejectReason = 'notConvex' | 'ratio' | 'tooSmall' | 'tooLarge';

/** Why a quad can't be a card in a photo of `imageArea` pixels, or null when it can. */
export function rejectReason(q: Quad, imageArea: number, limits: ShapeLimits = DEFAULT_LIMITS): RejectReason | null {
  if (!isConvex(q)) return 'notConvex';
  const share = polygonArea(q) / imageArea;
  if (share < limits.minAreaShare) return 'tooSmall';
  if (share > limits.maxAreaShare) return 'tooLarge';
  const { ratio } = quadSize(q);
  if (ratio < limits.minRatio || ratio > limits.maxRatio) return 'ratio';
  return null;
}

export interface Candidate {
  quad: Quad;
  /** Higher is better: how card-like the shape is (see detect.ts). */
  score: number;
}

/**
 * Keeps one quad per card. A quad mostly inside a bigger one of the same shape (a card in its
 * sleeve, or the art box inside a card) is the card when they're about the same size, else the
 * bigger one wins; other overlapping quads keep the best score.
 */
export function dedupe<T extends Candidate>(cands: readonly T[]): T[] {
  const byArea = [...cands].sort((a, b) => polygonArea(b.quad) - polygonArea(a.quad));
  const kept: T[] = [];
  for (const c of byArea) {
    const area = polygonArea(c.quad);
    let drop = false;
    for (let i = 0; i < kept.length; i++) {
      const k = kept[i];
      const cov = coverage(c.quad, k.quad);
      if (cov < 0.5) continue;
      const sizeRatio = area / polygonArea(k.quad);
      if (cov > 0.9 && sizeRatio > 0.82) {
        // Same card, slightly smaller: the card inside its sleeve (or a tighter outline). Keep the inner one.
        kept[i] = c;
      } else if (cov > 0.9) {
        // Something much smaller inside a card (art box, text box): not a card of its own.
      } else if (c.score > k.score) {
        kept[i] = c;
      }
      drop = true;
      break;
    }
    if (!drop) kept.push(c);
  }
  return kept;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Groups sorted values into clusters split at gaps larger than `gap`; returns each value's cluster index. */
function clusterIndex(values: number[], gap: number): { index: number[]; centers: number[] } {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const index = new Array<number>(values.length);
  const sums: number[] = [];
  const counts: number[] = [];
  let k = -1;
  let prev = -Infinity;
  for (const [v, i] of order) {
    if (v - prev > gap) {
      k++;
      sums.push(0);
      counts.push(0);
    }
    index[i] = k;
    sums[k] += v;
    counts[k]++;
    prev = v;
  }
  return { index, centers: sums.map((s, i) => s / counts[i]) };
}

/** Solves the 3×3 system m·x = v (Cramer's rule); null when singular. */
function solve3(m: number[][], v: number[]): number[] | null {
  const det = (a: number[][]) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (Math.abs(d) < 1e-9) return null;
  return [0, 1, 2].map((col) => det(m.map((row, r) => row.map((x, c) => (c === col ? v[r] : x)))) / d);
}

export interface GridCell {
  quad: Quad;
  /** Column and row in the grid. */
  col: number;
  row: number;
}

/**
 * Binder pages: when at least `minCards` cards of about the same size and angle sit on a regular
 * grid, returns the quads of the grid's empty cells (inside the found cards' rows and columns),
 * which the detector likely missed (touching cards, glare). An empty pocket also shows up here:
 * matching tells. Returns nothing when the cards don't form a clean grid.
 */
export function inferGridCells(quads: readonly Quad[], minCards = 4): GridCell[] {
  if (quads.length < minCards) return [];
  const sizes = quads.map(quadSize);
  const w = median(sizes.map((s) => s.w));
  const h = median(sizes.map((s) => s.h));
  // Only cards of the grid's size (±25 %).
  const area = w * h;
  const cards = quads.filter((_, i) => Math.abs((sizes[i].w * sizes[i].h) / area - 1) < 0.25);
  if (cards.length < minCards) return [];
  // The grid's axes, from the cards' top sides (angle mod π, so upside-down cards agree).
  const angles = cards.map((q) => {
    const a = Math.atan2(q[1].y - q[0].y, q[1].x - q[0].x);
    return ((a % Math.PI) + Math.PI) % Math.PI;
  });
  // Average angles on a doubled circle so 179° and 1° agree.
  const sx = angles.reduce((s, a) => s + Math.cos(2 * a), 0);
  const sy = angles.reduce((s, a) => s + Math.sin(2 * a), 0);
  const theta = Math.atan2(sy, sx) / 2;
  if (angles.some((a) => Math.abs(Math.sin(a - theta)) > Math.sin((10 * Math.PI) / 180))) return [];
  const ex = { x: Math.cos(theta), y: Math.sin(theta) };
  const ey = { x: -Math.sin(theta), y: Math.cos(theta) };
  const centers = cards.map(centroid);
  const a = centers.map((c) => c.x * ex.x + c.y * ex.y);
  const b = centers.map((c) => c.x * ey.x + c.y * ey.y);
  const cols = clusterIndex(a, w * 0.5);
  const rows = clusterIndex(b, h * 0.5);
  const nCols = cols.centers.length;
  const nRows = rows.centers.length;
  if (nCols * nRows > 25 || nCols * nRows <= cards.length) return [];
  // A regular grid: steady pitch, about one card (plus a gap) apart.
  const pitchOk = (centers: number[], size: number) =>
    centers.length < 2 || centers.slice(1).every((c, i) => {
      const p = c - centers[i];
      return p > size * 0.9 && p < size * 1.4;
    });
  if (!pitchOk(cols.centers, w) || !pitchOk(rows.centers, h)) return [];
  const taken = new Set<string>();
  for (let i = 0; i < cards.length; i++) {
    const key = `${cols.index[i]},${rows.index[i]}`;
    if (taken.has(key)) return []; // two cards in one cell: not a grid
    taken.add(key);
  }
  // Least-squares affine fit: center = O + col·U + row·V (perspective is ignored: binder photos are mostly flat).
  const fit = (pick: (p: Point) => number): number[] | null => {
    const m = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    const v = [0, 0, 0];
    centers.forEach((c, i) => {
      const row = [1, cols.index[i], rows.index[i]];
      for (let r = 0; r < 3; r++) {
        for (let k = 0; k < 3; k++) m[r][k] += row[r] * row[k];
        v[r] += row[r] * pick(c);
      }
    });
    return solve3(m, v);
  };
  const fx = fit((p) => p.x);
  const fy = fit((p) => p.y);
  if (!fx || !fy) return [];
  // The average card shape around its center (corners are in the same order for every card).
  const offsets = [0, 1, 2, 3].map((k) => {
    const dx = cards.map((q, i) => q[k].x - centers[i].x);
    const dy = cards.map((q, i) => q[k].y - centers[i].y);
    return { x: median(dx), y: median(dy) };
  });
  const cells: GridCell[] = [];
  for (let col = 0; col < nCols; col++) {
    for (let row = 0; row < nRows; row++) {
      if (taken.has(`${col},${row}`)) continue;
      const cx = fx[0] + fx[1] * col + fx[2] * row;
      const cy = fy[0] + fy[1] * col + fy[2] * row;
      cells.push({ col, row, quad: offsets.map((o) => ({ x: cx + o.x, y: cy + o.y })) as Quad });
    }
  }
  return cells;
}
