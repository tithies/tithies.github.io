import { cleanupShapes, type NamedShape } from '@/features/scanner/cleanup';
import type { Quad } from '@/features/scanner/geometry';

const quad = (x: number, y: number, w = 100, h = 140): Quad => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + h },
  { x, y: y + h },
];
const shape = (q: Quad, score: number, name?: string): NamedShape => ({ quad: q, score, name });

describe('scanner shape cleanup', () => {
  it('drops an outline around two better-named neighbours', () => {
    const shapes = [shape(quad(0, 0, 210, 140), 0.45, 'Junk'), shape(quad(0, 0), 0.9, 'A'), shape(quad(110, 0), 0.85, 'B')];
    expect([...cleanupShapes(shapes)]).toEqual([[0, 'spanning']]);
  });

  it('keeps a big shape when what it covers is named worse, or only one card', () => {
    expect(cleanupShapes([shape(quad(0, 0, 210, 140), 0.95, 'Big'), shape(quad(0, 0), 0.5, 'A'), shape(quad(110, 0), 0.5, 'B')]).size).toBe(0);
    expect(cleanupShapes([shape(quad(0, 0, 210, 140), 0.45, 'Junk'), shape(quad(0, 0), 0.9, 'A')]).size).toBe(0);
  });

  it('keeps the better of two outlines of one card', () => {
    // Offset by a third of the card: IoU just over 0.25.
    const shapes = [shape(quad(0, 0), 0.54, 'Pay No Heed'), shape(quad(40, 30), 0.9, 'Pay No Heed')];
    expect([...cleanupShapes(shapes)]).toEqual([[0, 'double']]);
  });

  it('keeps two copies of a card lying apart, and overlapping cards of different names', () => {
    expect(cleanupShapes([shape(quad(0, 0), 0.9, 'Forest'), shape(quad(200, 0), 0.8, 'Forest')]).size).toBe(0);
    expect(cleanupShapes([shape(quad(0, 0), 0.9, 'Opt'), shape(quad(20, 20), 0.8, 'Shock')]).size).toBe(0);
  });
});
