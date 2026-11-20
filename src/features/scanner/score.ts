/**
 * Scores scan results against hand-checked labels (labels.ts). Only cards a person checked, or
 * from an older labels file, count: a draft made by the scanner itself proves nothing.
 * - Labels with checked corners are paired with the cards found by overlap (IoU ≥ 0.5): "found"
 *   measures the detection alone, and the names and prints are judged on those pairs. Corners
 *   nobody checked yet (copied from a scan into a draft) would find themselves: they don't count.
 * - Labels without corners are paired by name (the card's top 5 must hold it), exact print first.
 * - "Mostly hidden" labels are neither counted nor missed, and a card found on one isn't extra.
 */
import { quadIoU, scaleQuad, type Quad } from './geometry';
import { pairByName, sameName, samePrint, type Labels } from './labels';

export { sameName };

export interface ScoredCandidate {
  name: string;
  set: string;
  cn: string;
}

export interface ScoredDetection {
  /** Card height in the photo, in pixels. */
  heightPx: number;
  /** Corners in the scanned photo's pixels. */
  quad?: Quad;
  /** Best candidates first, for each model. */
  byModel: Record<string, readonly ScoredCandidate[]>;
}

export interface ScoredPhoto {
  file: string;
  /** Share of the full resolution scanned (label corners are at full resolution). */
  scale?: number;
  detections: readonly ScoredDetection[];
}

/** Card height buckets (pixels in the photo) for the hit rate by size. */
export const HEIGHT_BUCKETS = [150, 250, 400, 600] as const;

export function heightBucket(px: number): string {
  let lo = 0;
  for (const hi of HEIGHT_BUCKETS) {
    if (px < hi) return `${lo}–${hi}`;
    lo = hi;
  }
  return `≥${lo}`;
}

export interface ModelScore {
  /** Cards labelled (not mostly hidden). */
  labelled: number;
  detections: number;
  /** Cards found that are no labelled card: extra shapes, or (without corners) named wrong beyond the top 5. */
  unpaired: number;
  /** Labels with corners, and how many of them a found card overlaps. */
  withQuad: number;
  found: number;
  nameTop1: number;
  nameTop5: number;
  /** Labels with a set and number, and how many of those had the print right. */
  withPrint: number;
  printTop1: number;
  printTop5: number;
  /** Top-1 name hits by card height (paired labels only). */
  byHeight: Record<string, { cards: number; nameTop1: number }>;
}

export const IOU_MIN = 0.5;

/** Label index -> detection index, by overlap, best first. */
function pairByOverlap(quads: readonly (Quad | undefined)[], dets: readonly ScoredDetection[], skip: Set<number>): Map<number, number> {
  const pairs: { l: number; d: number; iou: number }[] = [];
  quads.forEach((q, l) => {
    if (!q) return;
    dets.forEach((det, d) => {
      if (skip.has(d) || !det.quad) return;
      const iou = quadIoU(q, det.quad);
      if (iou >= IOU_MIN) pairs.push({ l, d, iou });
    });
  });
  pairs.sort((a, b) => b.iou - a.iou);
  const out = new Map<number, number>();
  for (const p of pairs) {
    if (out.has(p.l) || skip.has(p.d)) continue;
    out.set(p.l, p.d);
    skip.add(p.d);
  }
  return out;
}

export function scorePhotos(photos: readonly ScoredPhoto[], labels: Labels, model: string, topK = 5): ModelScore {
  const s: ModelScore = { labelled: 0, detections: 0, unpaired: 0, withQuad: 0, found: 0, nameTop1: 0, nameTop5: 0, withPrint: 0, printTop1: 0, printTop5: 0, byHeight: {} };
  for (const photo of photos) {
    const truth = (labels[photo.file]?.cards ?? []).filter((c) => c.checked || c.manual);
    if (!truth.length) continue;
    const scale = photo.scale ?? 1;
    const atScan = (q: Quad | undefined) => (q ? (scale === 1 ? q : scaleQuad(q, scale)) : undefined);
    const quadOf = (c: (typeof truth)[number]) => (c.checked ? c.quad : undefined);
    const visible = truth.filter((c) => !c.hidden);
    const used = new Set<number>();
    const byOverlap = pairByOverlap(visible.map((c) => atScan(quadOf(c))), photo.detections, used);
    // A card found on a mostly hidden label is that card, not an extra shape.
    pairByOverlap(truth.filter((c) => c.hidden).map((c) => atScan(quadOf(c))), photo.detections, used);
    const loose = visible.map((c, l) => ({ c, l })).filter(({ c }) => !quadOf(c));
    const byName = pairByName(
      loose.map(({ c }) => c),
      photo.detections.map((d) => d.byModel[model] ?? []),
      topK,
      used,
    );
    const pairs = new Map(byOverlap);
    for (const [k, d] of byName) {
      pairs.set(loose[k].l, d);
      used.add(d);
    }

    s.labelled += visible.length;
    s.detections += photo.detections.length;
    s.withQuad += visible.filter((c) => quadOf(c)).length;
    s.found += byOverlap.size;
    s.withPrint += visible.filter((c) => c.set && c.cn).length;
    for (const [l, d] of pairs) {
      const card = visible[l];
      const det = photo.detections[d];
      const cands = (det.byModel[model] ?? []).slice(0, topK);
      const rank = cands.findIndex((c) => sameName(card.name, c.name));
      const bucket = heightBucket(det.heightPx);
      const b = (s.byHeight[bucket] ??= { cards: 0, nameTop1: 0 });
      b.cards++;
      if (rank >= 0) s.nameTop5++;
      if (rank === 0) {
        s.nameTop1++;
        b.nameTop1++;
      }
      if (card.set && card.cn) {
        if (cands[0] && samePrint(card, cands[0])) s.printTop1++;
        if (cands.some((c) => samePrint(card, c))) s.printTop5++;
      }
    }
    s.unpaired += photo.detections.length - used.size;
  }
  return s;
}
