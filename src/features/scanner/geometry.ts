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
