/**
 * Drops bad shapes once the cards are named (the same rule as trainer/evaluate.py in the tithies-scanner-trainer repo, measured on
 * the labelled photos: 23 → 16 extra shapes on the test photos, no card lost):
 * - a shape covering two or more shapes that are named better: one outline around neighbours;
 * - of two outlines of one card (named the same, and overlapping, or one mostly inside the other),
 *   the better named stays.
 */
import { coverage, polygonArea, quadIoU, type Quad } from './geometry';

export interface NamedShape {
  quad: Quad;
  /** The best match's score and card name (none: not named). */
  score: number;
  name?: string;
}

export type CleanupReason = 'spanning' | 'double';

export const SPAN_COVERAGE = 0.8;
export const DOUBLE_IOU = 0.25;
export const DOUBLE_COVERAGE = 0.6;

/** Why each shape goes (index → reason); the others stay. */
export function cleanupShapes(shapes: readonly NamedShape[]): Map<number, CleanupReason> {
  const drop = new Map<number, CleanupReason>();
  shapes.forEach((a, i) => {
    const inside = shapes.filter((b, j) => j !== i && b.score > a.score && coverage(b.quad, a.quad) >= SPAN_COVERAGE);
    if (inside.length >= 2) drop.set(i, 'spanning');
  });
  for (let i = 0; i < shapes.length; i++)
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i];
      const b = shapes[j];
      if (drop.has(i) || drop.has(j) || !a.name || a.name !== b.name) continue;
      const [small, big] = polygonArea(a.quad) <= polygonArea(b.quad) ? [a, b] : [b, a];
      if (quadIoU(a.quad, b.quad) >= DOUBLE_IOU || coverage(small.quad, big.quad) >= DOUBLE_COVERAGE) drop.set(a.score >= b.score ? j : i, 'double');
    }
  return drop;
}
