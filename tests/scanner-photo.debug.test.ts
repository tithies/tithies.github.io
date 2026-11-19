/**
 * Detection on a real photo, in Node (no browser): for tuning the Scanner prototype.
 * Skipped unless SCANNER_PHOTO names a PNG, e.g.
 *   SCANNER_PHOTO=scanner-samples/Untitled2.png npx vitest run tests/scanner-photo.debug.test.ts
 * Writes <photo>.debug.png next to it (scanner-samples is gitignored): cards found in green
 * (dashed blue: inferred from the binder grid), line quads in orange, the 40 longest lines in
 * blue; and <photo>.debug.txt with the cards found.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { cannyEdges, detectCards, findLineQuads } from '@/features/scanner/engine/detect';
import { free, loadOpenCv } from '@/features/scanner/engine/opencv';
import { quadIoU, quadSize, type Quad } from '@/features/scanner/geometry';
import { decodePng, encodePng } from './helpers/png';

// Node's ESM loader exposes OpenCV's Module `then` on the module namespace, so importing it
// loops forever (see engine/opencv.ts); load it with CommonJS require instead.
vi.mock('@techstark/opencv-js', async () => {
  const { createRequire } = await import('node:module');
  return { default: createRequire(import.meta.url)('@techstark/opencv-js') };
});

const photo = process.env.SCANNER_PHOTO;
const MAX_SIDE = Number(process.env.SCANNER_MAX_SIDE ?? 2000);

describe.skipIf(!photo)('scanner detection on a photo', () => {
  it('detects cards', { timeout: 120_000 }, async () => {
    const { cv } = await loadOpenCv();
    const img = decodePng(readFileSync(photo!));
    const full = cv.matFromImageData(img);
    const scale = Math.max(1, Math.max(img.width, img.height) / MAX_SIDE);
    const small = new cv.Mat();
    cv.resize(full, small, new cv.Size(Math.round(img.width / scale), Math.round(img.height / scale)), 0, 0, cv.INTER_AREA);
    const t0 = performance.now();
    const out = detectCards(cv, small, scale, false);
    const ms = performance.now() - t0;
    const [lo, hi] = (process.env.SCANNER_CANNY ?? '0.66,1.33').split(',').map(Number);
    const edges = cannyEdges(cv, small, lo, hi);
    const { lines, quads } = findLineQuads(cv, edges, process.env.SCANNER_MAX_LINES ? Number(process.env.SCANNER_MAX_LINES) : undefined);
    // SCANNER_EXPECT="x0,y0,x1,y1" (detection pixels): the line quad closest to that box.
    const expect = process.env.SCANNER_EXPECT?.split(',').map(Number);
    let closest = '';
    if (expect) {
      const box: Quad = [{ x: expect[0], y: expect[1] }, { x: expect[2], y: expect[1] }, { x: expect[2], y: expect[3] }, { x: expect[0], y: expect[3] }];
      const best = quads.map((q, rank) => ({ q, rank, iou: quadIoU(q.quad, box) })).sort((a, b) => b.iou - a.iou)[0];
      closest = best ? `\n closest to the expected box: IoU ${best.iou.toFixed(2)}, rank ${best.rank}, support ${best.q.support.toFixed(2)}, score ${best.q.score.toFixed(2)}, ratio ${quadSize(best.q.quad).ratio.toFixed(3)} ${best.q.quad.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ')}` : '\n no line quad near the expected box';
    }

    const color = (r: number, g: number, b: number) => new cv.Scalar(r, g, b, 255);
    const poly = (q: Quad, c: unknown, thick: number, s = 1) => {
      for (let k = 0; k < 4; k++) {
        const a = q[k];
        const b = q[(k + 1) % 4];
        cv.line(small, new cv.Point(a.x / s, a.y / s), new cv.Point(b.x / s, b.y / s), c, thick);
      }
    };
    for (const l of lines.slice(0, 40)) {
      const n = { x: -Math.sin(l.theta), y: Math.cos(l.theta) };
      const d = { x: Math.cos(l.theta), y: Math.sin(l.theta) };
      const p = { x: n.x * l.rho, y: n.y * l.rho };
      const L = 4000;
      cv.line(small, new cv.Point(p.x - d.x * L, p.y - d.y * L), new cv.Point(p.x + d.x * L, p.y + d.y * L), color(60, 140, 255), 1);
    }
    for (const q of quads.slice(0, 10)) poly(q.quad, color(255, 150, 0), 2);
    for (const c of out.cards) poly(c.quad, c.source === 'grid' ? color(80, 80, 255) : color(0, 220, 0), 4, scale);
    writeFileSync(photo!.replace(/\.png$/i, '.debug.png'), encodePng({ width: small.cols, height: small.rows, data: new Uint8ClampedArray(small.data) }));

    writeFileSync(
      photo!.replace(/\.png$/i, '.debug.txt'),
      `${img.width}×${img.height}, detection at ${small.cols}×${small.rows}, ${Math.round(ms)} ms: ${out.cards.length} cards, ${lines.length} lines, ${quads.length} line quads\n` +
        out.cards.map((c) => `  ${c.source} score ${c.score.toFixed(2)} ${Math.round(quadSize(c.quad).w)}×${Math.round(quadSize(c.quad).h)} ratio ${quadSize(c.quad).ratio.toFixed(3)}`).join('\n') +
        '\n line quads (top 5):\n' +
        quads.slice(0, 5).map((q) => `  support ${q.support.toFixed(2)} score ${q.score.toFixed(2)} ratio ${quadSize(q.quad).ratio.toFixed(3)} ${q.quad.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(' ')}`).join('\n') +
        closest,
    );
    free(full, small, edges);
  });
});
