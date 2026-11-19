/**
 * Finds card-shaped quads in a photo (sandbox, OpenCV). Two passes look for closed outlines:
 * Canny edges (thresholds from the photo's median brightness), and an adaptive threshold (both
 * polarities: dark borders on a light table, light on dark). Each outline that is a convex
 * quadrilateral, or close to its minimum-area rectangle (rounded corners), and has a card's
 * proportions and a plausible size, is a candidate. A third pass builds quads from long straight
 * edges (lines.ts), for cards whose outline touches other edges (art, toploader, pocket).
 * Duplicates are merged, then the binder grid fills the cells the passes missed.
 */
import {
  CARD_RATIO,
  DEFAULT_LIMITS,
  dedupe,
  dropFragments,
  dropGroups,
  inferGridCells,
  orderCorners,
  polygonArea,
  quadSize,
  rejectReason,
  scaleQuad,
  type Point,
  type Quad,
} from '../geometry';
import { lineQuads, mergeSegments, type Line, type LineQuad, type Segment } from '../lines';
import type { CardSource, DetectedCard, RejectedShape } from '../protocol';
import { free, type CV, type Mat } from './opencv';

/** How far approxPolyDP may simplify an outline, as a share of its perimeter. */
const APPROX_EPSILON = 0.02;
/** Contour area ÷ its minimum-area rectangle above which a rounded outline counts as a rectangle. */
const MIN_RECTANGULARITY = 0.85;
/** At most this many rejected shapes are sent back for the debug view (largest first). */
const MAX_REJECTED = 300;

interface Candidate {
  quad: Quad;
  score: number;
  source: CardSource;
}

function medianOf(data: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  let acc = 0;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= data.length / 2) return v;
  }
  return 128;
}

function matPoints(m: Mat): Point[] {
  const d: Int32Array = m.data32S;
  const pts: Point[] = [];
  for (let i = 0; i < d.length; i += 2) pts.push({ x: d[i], y: d[i + 1] });
  return pts;
}

/** Outlines of one binary image → card candidates and rejected shapes (at detection size). */
function collect(cv: CV, binary: Mat, source: CardSource, imageArea: number, out: Candidate[], rejected: { quad: Quad; reason: RejectedShape['reason']; area: number }[]) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  try {
    cv.findContours(binary, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const minArea = imageArea * DEFAULT_LIMITS.minAreaShare;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const approx = new cv.Mat();
      try {
        const area = cv.contourArea(c);
        if (area < minArea) continue;
        const peri = cv.arcLength(c, true);
        cv.approxPolyDP(c, approx, APPROX_EPSILON * peri, true);
        let pts: Point[] | null = null;
        let rectangularity = 0;
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          pts = matPoints(approx);
          rectangularity = Math.min(1, area / Math.max(1, polygonArea(pts)));
        } else {
          const rr = cv.minAreaRect(c);
          const rectArea = rr.size.width * rr.size.height;
          rectangularity = rectArea > 0 ? area / rectArea : 0;
          if (rectangularity >= MIN_RECTANGULARITY) pts = cv.RotatedRect.points(rr).map((p: Point) => ({ x: p.x, y: p.y }));
        }
        if (!pts) continue;
        const quad = orderCorners(pts);
        const reason = rejectReason(quad, imageArea);
        if (reason) {
          rejected.push({ quad, reason, area });
          continue;
        }
        const { ratio } = quadSize(quad);
        const score = rectangularity * Math.max(0, 1 - Math.abs(ratio - CARD_RATIO) / CARD_RATIO);
        out.push({ quad, score, source });
      } finally {
        free(c, approx);
      }
    }
  } finally {
    free(contours, hierarchy);
  }
}

/** At most this many line quads (best first) join the candidates. */
const MAX_LINE_QUADS = 150;

/** The long straight edges of an edge map (lines.ts), and the quads they make, best first. */
export function findLineQuads(cv: CV, edges: Mat, maxLines?: number): { lines: Line[]; quads: LineQuad[] } {
  const w = edges.cols;
  const h = edges.rows;
  const size = Math.min(w, h);
  const segsMat = new cv.Mat();
  const near = new cv.Mat();
  const k5 = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5));
  try {
    cv.HoughLinesP(edges, segsMat, 1, Math.PI / 180, 50, Math.round(size * 0.1), Math.round(size * 0.015));
    const d: Int32Array = segsMat.data32S;
    const segs: Segment[] = [];
    for (let i = 0; i + 3 < d.length; i += 4) segs.push({ x1: d[i], y1: d[i + 1], x2: d[i + 2], y2: d[i + 3] });
    // Sides are checked against the edges thickened by 2 px (tilt, slight curvature).
    cv.dilate(edges, near, k5);
    const px: Uint8Array = near.data;
    const onEdge = (x: number, y: number) => {
      const xi = Math.round(x);
      const yi = Math.round(y);
      return xi >= 0 && yi >= 0 && xi < w && yi < h && px[yi * w + xi] > 0;
    };
    const lines = mergeSegments(segs, Math.max(w, h) * 0.008);
    return { lines, quads: lineQuads(lines, { width: w, height: h, onEdge, maxLines }).slice(0, MAX_LINE_QUADS) };
  } finally {
    free(segsMat, near, k5);
  }
}

/** Pass C: quads made of long straight edges, kept when their sides lie on edges. */
function collectLines(cv: CV, edges: Mat, imageArea: number, out: Candidate[], rejected: { quad: Quad; reason: RejectedShape['reason']; area: number }[]) {
  for (const q of findLineQuads(cv, edges).quads) {
    const reason = rejectReason(q.quad, imageArea);
    if (reason) rejected.push({ quad: q.quad, reason, area: polygonArea(q.quad) });
    else out.push({ quad: q.quad, score: q.score, source: 'lines' });
  }
}

/** Canny edges of the photo (thresholds: `lo` and `hi` times its median brightness), on its blurred grey. */
export function cannyEdges(cv: CV, small: Mat, lo = 0.66, hi = 1.33): Mat {
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  try {
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);
    const med = medianOf(blur.data);
    cv.Canny(blur, edges, Math.max(10, lo * med), Math.min(255, Math.max(30, hi * med)));
    return edges;
  } finally {
    free(gray, blur);
  }
}

export interface DetectOutput {
  cards: DetectedCard[];
  rejected: RejectedShape[];
  edges?: ImageData;
}

/**
 * `small` is the photo shrunk for detection (RGBA Mat); `scale` turns its pixels back into the
 * full photo's. Every quad returned is in full-resolution pixels.
 */
export function detectCards(cv: CV, small: Mat, scale: number, debug: boolean): DetectOutput {
  const w = small.cols;
  const h = small.rows;
  const imageArea = w * h;
  const gray = new cv.Mat();
  const blur = new cv.Mat();
  const edges = new cv.Mat();
  const thresh = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const cands: Candidate[] = [];
  const rejected: { quad: Quad; reason: RejectedShape['reason']; area: number }[] = [];
  let edgesImage: ImageData | undefined;
  try {
    cv.cvtColor(small, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(5, 5), 0);

    const med = medianOf(blur.data);
    cv.Canny(blur, edges, Math.max(10, 0.66 * med), Math.min(255, Math.max(40, 1.33 * med)));

    // Pass C (on the raw edges, before pass A thickens them): straight lines.
    collectLines(cv, edges, imageArea, cands, rejected);

    // Pass A: closed outlines of the edges.
    cv.dilate(edges, edges, kernel);
    collect(cv, edges, 'edges', imageArea, cands, rejected);

    // Pass B: adaptive threshold, both polarities.
    const block = Math.max(15, Math.round(Math.max(w, h) / 40) | 1);
    cv.adaptiveThreshold(blur, thresh, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, block, 7);
    cv.morphologyEx(thresh, thresh, cv.MORPH_OPEN, kernel);
    collect(cv, thresh, 'threshold', imageArea, cands, rejected);
    cv.bitwise_not(thresh, thresh);
    collect(cv, thresh, 'threshold', imageArea, cands, rejected);

    if (debug) {
      const rgba = new cv.Mat();
      cv.cvtColor(edges, rgba, cv.COLOR_GRAY2RGBA);
      edgesImage = new ImageData(new Uint8ClampedArray(rgba.data), w, h);
      rgba.delete();
    }
  } finally {
    free(gray, blur, edges, thresh, kernel);
  }

  // Groups of touching cards first (dedupe would keep the group and drop its cards), then
  // duplicates, then pieces of cards; the binder grid fills what's left, and drops the pieces
  // found inside its cells.
  const ungrouped = dropGroups(cands);
  const unique = dedupe(ungrouped);
  const deduped = dropFragments(unique);
  const grid = inferGridCells(deduped.map((c) => c.quad)).map((g): Candidate => ({ quad: g.quad, score: 0, source: 'grid' }));
  const kept = dropFragments(deduped, grid.map((g) => g.quad));

  const cards = [...kept, ...grid].map((c) => ({ quad: scaleQuad(c.quad, scale), score: c.score, source: c.source }));
  let rejectedOut: RejectedShape[] = [];
  if (debug) {
    const sets = { ungrouped: new Set(ungrouped), unique: new Set(unique), kept: new Set(kept) };
    const dropped = cands
      .filter((c) => !sets.kept.has(c))
      .map((c): RejectedShape => ({
        quad: scaleQuad(c.quad, scale),
        reason: !sets.ungrouped.has(c) ? 'group' : !sets.unique.has(c) ? 'duplicate' : 'fragment',
      }));
    rejectedOut = [
      ...rejected.sort((a, b) => b.area - a.area).slice(0, MAX_REJECTED).map((r) => ({ quad: scaleQuad(r.quad, scale), reason: r.reason })),
      ...dropped.slice(0, MAX_REJECTED),
    ];
  }
  return { cards, rejected: rejectedOut, edges: edgesImage };
}
