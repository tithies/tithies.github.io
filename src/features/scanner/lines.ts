/**
 * Cards from straight lines: the line-based detection pass. Contours need a card's outline to be
 * closed and apart from everything else, which fails when the art's edges touch the border, or
 * a toploader, sleeve or binder pocket adds its own edges. Long straight edge segments (OpenCV's
 * HoughLinesP) are merged into lines; two pairs of near-parallel lines, roughly crossing, make a
 * quad; a quad is kept when its four sides lie mostly on edges. Pure functions (the edge map is
 * read through a callback), so they are unit-tested in Node.
 */
import { CARD_RATIO, isConvex, orderCorners, quadSize, type Point, type Quad } from './geometry';

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A line in normal form: direction angle θ in [0, π), normal n = (−sin θ, cos θ), and n·p = rho for its points. */
export interface Line {
  theta: number;
  rho: number;
  /** Total length of the segments merged into it. */
  length: number;
}

const DEG = Math.PI / 180;

/** Angle between two directions, modulo π (0…π/2). */
export function angleBetween(a: number, b: number): number {
  const d = Math.abs(a - b) % Math.PI;
  return Math.min(d, Math.PI - d);
}

function lineOf(s: Segment): Line {
  let theta = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  if (theta < 0) theta += Math.PI;
  if (theta >= Math.PI) theta -= Math.PI;
  return { theta, rho: -Math.sin(theta) * s.x1 + Math.cos(theta) * s.y1, length: Math.hypot(s.x2 - s.x1, s.y2 - s.y1) };
}

/** `b` expressed with an angle close to `a`'s (θ and θ ± π are the same line, with rho negated). */
function aligned(a: Line, b: Line): { theta: number; rho: number } {
  if (b.theta - a.theta > Math.PI / 2) return { theta: b.theta - Math.PI, rho: -b.rho };
  if (a.theta - b.theta > Math.PI / 2) return { theta: b.theta + Math.PI, rho: -b.rho };
  return b;
}

/**
 * Merges segments of one straight edge (broken by glare, text or a rounded corner) into lines:
 * within `maxAngle` of each other and `maxOffset` pixels apart. Longest lines first.
 */
export function mergeSegments(segs: readonly Segment[], maxOffset: number, maxAngle = 3 * DEG): Line[] {
  const lines: Line[] = [];
  for (const l of segs.map(lineOf).sort((a, b) => b.length - a.length)) {
    const hit = lines.find((m) => {
      const b = aligned(m, l);
      return Math.abs(b.theta - m.theta) < maxAngle && Math.abs(b.rho - m.rho) < maxOffset;
    });
    if (!hit) {
      lines.push({ ...l });
      continue;
    }
    const b = aligned(hit, l);
    const total = hit.length + l.length;
    hit.theta = (hit.theta * hit.length + b.theta * l.length) / total;
    hit.rho = (hit.rho * hit.length + b.rho * l.length) / total;
    hit.length = total;
    if (hit.theta < 0) {
      hit.theta += Math.PI;
      hit.rho = -hit.rho;
    } else if (hit.theta >= Math.PI) {
      hit.theta -= Math.PI;
      hit.rho = -hit.rho;
    }
  }
  return lines.sort((a, b) => b.length - a.length);
}

/** Where two lines cross, or null when they're (nearly) parallel. */
export function intersect(a: Line, b: Line): Point | null {
  const a1 = -Math.sin(a.theta);
  const b1 = Math.cos(a.theta);
  const a2 = -Math.sin(b.theta);
  const b2 = Math.cos(b.theta);
  const det = a1 * b2 - a2 * b1;
  if (Math.abs(det) < 1e-6) return null;
  return { x: (a.rho * b2 - b.rho * b1) / det, y: (a1 * b.rho - a2 * a.rho) / det };
}

/** Share of a side's points (its middle 80 %: corners are rounded) that lie on an edge. */
function sideSupport(a: Point, b: Point, onEdge: (x: number, y: number) => boolean, samples = 40): number {
  let hits = 0;
  for (let i = 0; i < samples; i++) {
    const t = 0.1 + (0.8 * (i + 0.5)) / samples;
    if (onEdge(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)) hits++;
  }
  return hits / samples;
}

export interface LineQuad {
  quad: Quad;
  /** Mean share of the four sides on edges (0–1). */
  support: number;
  score: number;
}

export interface LineQuadOptions {
  width: number;
  height: number;
  onEdge: (x: number, y: number) => boolean;
  /** Longest lines considered (the work grows with the 4th power). */
  maxLines?: number;
  /** Each side must be this much on edges, and the four on average `minSupport`. */
  minSideSupport?: number;
  minSupport?: number;
}

/** Card-shaped quads made of two pairs of near-parallel lines that cross at 55–125°, best first. */
export function lineQuads(lines: readonly Line[], o: LineQuadOptions): LineQuad[] {
  const size = Math.min(o.width, o.height);
  const top = lines.slice(0, o.maxLines ?? 40);
  const minSide = o.minSideSupport ?? 0.35;
  const minMean = o.minSupport ?? 0.6;
  // Pairs of near-parallel lines, far enough apart to be two sides of one card.
  const pairs: [Line, Line][] = [];
  for (let i = 0; i < top.length; i++)
    for (let j = i + 1; j < top.length; j++) {
      if (angleBetween(top[i].theta, top[j].theta) > 12 * DEG) continue;
      const b = aligned(top[i], top[j]);
      if (Math.abs(b.rho - top[i].rho) < size * 0.05) continue;
      pairs.push([top[i], top[j]]);
    }
  const out: LineQuad[] = [];
  const margin = size * 0.02;
  for (let p = 0; p < pairs.length; p++)
    for (let q = p + 1; q < pairs.length; q++) {
      const [a, b] = pairs[p];
      const [c, d] = pairs[q];
      const cross = angleBetween(a.theta, c.theta);
      if (cross < 55 * DEG) continue;
      const pts = [intersect(a, c), intersect(a, d), intersect(b, c), intersect(b, d)];
      if (pts.some((x) => !x || x.x < -margin || x.y < -margin || x.x > o.width + margin || x.y > o.height + margin)) continue;
      const quad = orderCorners(pts as Point[]);
      if (!isConvex(quad)) continue;
      const { ratio } = quadSize(quad);
      if (ratio < 0.5 || ratio > 0.95) continue;
      const sides = [0, 1, 2, 3].map((k) => sideSupport(quad[k], quad[(k + 1) % 4], o.onEdge));
      if (Math.min(...sides) < minSide) continue;
      const support = sides.reduce((s, x) => s + x, 0) / 4;
      if (support < minMean) continue;
      out.push({ quad, support, score: support * Math.max(0, 1 - Math.abs(ratio - CARD_RATIO) / CARD_RATIO) });
    }
  return out.sort((x, y) => y.score - x.score);
}
