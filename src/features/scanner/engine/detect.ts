/**
 * Finds card-shaped quads in a photo (sandbox, OpenCV). Two passes look for closed outlines:
 * Canny edges (thresholds from the photo's median brightness), and an adaptive threshold (both
 * polarities: dark borders on a light table, light on dark). Each outline that is a convex
 * quadrilateral, or close to its minimum-area rectangle (rounded corners), and has a card's
 * proportions and a plausible size, is a candidate. Duplicates are merged, then the binder grid
 * fills the cells the passes missed.
 */
import {
  CARD_RATIO,
  DEFAULT_LIMITS,
  dedupe,
  inferGridCells,
  orderCorners,
  polygonArea,
  quadSize,
  rejectReason,
  scaleQuad,
  type Point,
  type Quad,
} from '../geometry';
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

    // Pass A: edges.
    const med = medianOf(blur.data);
    cv.Canny(blur, edges, Math.max(10, 0.66 * med), Math.min(255, Math.max(40, 1.33 * med)));
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

  const kept = dedupe(cands);
  const keptSet = new Set(kept);
  const dupes = cands.filter((c) => !keptSet.has(c));
  const grid = inferGridCells(kept.map((c) => c.quad)).map((g): Candidate => ({ quad: g.quad, score: 0, source: 'grid' }));

  const cards = [...kept, ...grid].map((c) => ({ quad: scaleQuad(c.quad, scale), score: c.score, source: c.source }));
  const rejectedOut: RejectedShape[] = debug
    ? [
        ...rejected.sort((a, b) => b.area - a.area).slice(0, MAX_REJECTED).map((r) => ({ quad: scaleQuad(r.quad, scale), reason: r.reason })),
        ...dupes.slice(0, MAX_REJECTED).map((d) => ({ quad: scaleQuad(d.quad, scale), reason: 'duplicate' as const })),
      ]
    : [];
  return { cards, rejected: rejectedOut, edges: edgesImage };
}
