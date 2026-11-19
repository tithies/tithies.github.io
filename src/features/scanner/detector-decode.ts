/**
 * Reads cards out of the trained detector's outputs (scanner-train/model.py): a heat map of
 * card centres on a grid of `stride`-pixel cells, and for each cell the card's 4 corners as
 * offsets from the cell's centre. A card is a local maximum of the heat map above the
 * threshold; overlapping answers for one card are merged (the best score wins).
 */
import { isConvex, orderCorners, polygonArea, quadIoU, type Quad } from './geometry';

export interface DecodedCard {
  quad: Quad;
  score: number;
}

export interface DecodeOptions {
  stride: number;
  threshold: number;
  maxCards?: number;
  /** Two answers overlapping more than this are one card. */
  nmsIou?: number;
}

/** `heat`: gh × gw probabilities; `corners`: 8 × gh × gw offsets in input pixels (x0, y0, … x3, y3). */
export function decodeDetector(heat: Float32Array, corners: Float32Array, gw: number, gh: number, o: DecodeOptions): DecodedCard[] {
  const plane = gw * gh;
  if (heat.length < plane || corners.length < 8 * plane) throw new Error('Detector outputs have the wrong size');
  const peaks: { x: number; y: number; s: number }[] = [];
  for (let y = 0; y < gh; y++)
    for (let x = 0; x < gw; x++) {
      const s = heat[y * gw + x];
      if (s < o.threshold) continue;
      let top = true;
      for (let dy = -1; dy <= 1 && top; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const yy = y + dy;
          const xx = x + dx;
          if ((dx || dy) && yy >= 0 && xx >= 0 && yy < gh && xx < gw && heat[yy * gw + xx] > s) {
            top = false;
            break;
          }
        }
      if (top) peaks.push({ x, y, s });
    }
  peaks.sort((a, b) => b.s - a.s);
  const max = o.maxCards ?? 100;
  const nms = o.nmsIou ?? 0.5;
  const out: DecodedCard[] = [];
  for (const p of peaks) {
    if (out.length >= max) break;
    const cx = (p.x + 0.5) * o.stride;
    const cy = (p.y + 0.5) * o.stride;
    const at = p.y * gw + p.x;
    const pts = [0, 1, 2, 3].map((k) => ({ x: cx + corners[2 * k * plane + at], y: cy + corners[(2 * k + 1) * plane + at] }));
    const quad = orderCorners(pts);
    if (!isConvex(quad) || polygonArea(quad) < 16) continue;
    if (out.some((c) => quadIoU(c.quad, quad) > nms)) continue;
    out.push({ quad, score: p.s });
  }
  return out;
}
