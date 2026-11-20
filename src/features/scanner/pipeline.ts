/**
 * One photo through the prototype: decode (phone orientation applied), optionally shrink it (to
 * find the smallest card size that still works), detect the cards, then for each card take its
 * features (upright and turned 180°) and search the reference set with every method. Each
 * method keeps the way up whose best hit scores higher.
 */
import type { ScannerEngine } from './engine-client';
import { cleanupShapes, type CleanupReason } from './cleanup';
import { boundingBox, centroid, quadSize, type Box, type Quad } from './geometry';
import { nameMargin } from './match';
import { ALL_METHODS } from './models';
import type { CardFeatures, CardSource, DetectOptions, RejectedShape } from './protocol';
import type { PrintInfo } from './reference';
import { searchIndex, type RefIndex } from './search-index';

export const TOP_K = 5;
/** Cards per engine call: 4 cards × 2 ways up × 2 model runs = one batch of 16 pictures. */
const CARD_GROUP = 4;

export interface CardMatch extends PrintInfo {
  score: number;
}

export interface MethodResult {
  candidates: CardMatch[];
  /** Lead of the best hit over the first other card name. */
  margin: number;
  /** The card matched better turned 180° (it was upside down in the photo). */
  turned: boolean;
}

export interface ScannedCard {
  /** Number shown on the photo (1-based, top to bottom then left to right). */
  n: number;
  quad: Quad;
  box: Box;
  source: CardSource;
  shapeScore: number;
  heightPx: number;
  crop: ImageBitmap;
  byMethod: Record<string, MethodResult>;
  /** Features + search time (its share of its group's). */
  ms: number;
}

export interface ScannedPhoto {
  id: string;
  file: string;
  /** Size scanned (after the simulated resolution). */
  width: number;
  height: number;
  /** Share of the original resolution scanned (1 = full). */
  scale: number;
  cards: ScannedCard[];
  rejected: RejectedShape[];
  edges?: ImageBitmap;
  timings: { loadMs: number; detectMs: number; cardsMs: number; totalMs: number };
  /** The recognition model the cards were named with (its scores need their own limits). */
  recognizer?: Recognizer;
}

export type Recognizer = 'dino' | 'tuned';

export interface ScanOptions extends DetectOptions {
  /** Share of the photo's resolution to scan (1, 0.5, 0.33, 0.25). */
  scale: number;
  /** Drop bad shapes once named (cleanup.ts; default on). */
  cleanup?: boolean;
}

/** The method the cleanup reads names and scores from (the one kept: padded · CLS). */
export const CLEANUP_METHOD = 'dino-pad-cls';

/** Numbering order: rows top to bottom (a row: centres within half a card height), then left to right. */
function readingOrder<T extends { quad: Quad }>(cards: T[]): T[] {
  if (!cards.length) return cards;
  const hs = cards.map((c) => quadSize(c.quad).h).sort((a, b) => a - b);
  const rowH = Math.max(1, hs[hs.length >> 1] * 0.5);
  return [...cards].sort((a, b) => {
    const ca = centroid(a.quad);
    const cb = centroid(b.quad);
    return Math.round(ca.y / rowH) - Math.round(cb.y / rowH) || ca.x - cb.x;
  });
}

/** A card's best prints by every method, each keeping the way up whose best hit scores higher. */
export function nameCard(index: RefIndex | null, f: Pick<CardFeatures, 'upright' | 'turned'>): Record<string, MethodResult> {
  const byMethod: Record<string, MethodResult> = {};
  if (!index?.size) return byMethod;
  for (const m of ALL_METHODS) {
    const up = searchIndex(index, f.upright, m.id, TOP_K);
    const down = searchIndex(index, f.turned, m.id, TOP_K);
    const turned = (down[0]?.score ?? -Infinity) > (up[0]?.score ?? -Infinity);
    const hits = turned ? down : up;
    byMethod[m.id] = {
      candidates: hits.map((h) => ({ ...index.prints[h.index], score: h.score })),
      margin: nameMargin(hits, (i) => index.prints[i].name),
      turned,
    };
  }
  return byMethod;
}

/** Names cards at corners placed by hand, in a photo already loaded in the engine (full-resolution pixels). */
export async function nameQuads(engine: ScannerEngine, photoId: string, quads: readonly Quad[], index: RefIndex | null): Promise<{ crop: ImageBitmap; heightPx: number; byMethod: Record<string, MethodResult> }[]> {
  const out = [];
  for (let g = 0; g < quads.length; g += CARD_GROUP) {
    const res = await engine.call({ type: 'cardFeatures', photoId, quads: quads.slice(g, g + CARD_GROUP) });
    for (const f of res.cards) out.push({ crop: f.crop, heightPx: f.heightPx, byMethod: nameCard(index, f) });
  }
  return out;
}

let nextPhoto = 1;

export async function scanPhoto(
  engine: ScannerEngine,
  file: File,
  index: RefIndex | null,
  opts: ScanOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<ScannedPhoto> {
  const t0 = performance.now();
  let bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  if (opts.scale < 1) {
    const small = await createImageBitmap(bitmap, {
      resizeWidth: Math.max(1, Math.round(bitmap.width * opts.scale)),
      resizeHeight: Math.max(1, Math.round(bitmap.height * opts.scale)),
      resizeQuality: 'high',
    });
    bitmap.close();
    bitmap = small;
  }
  const id = `p${nextPhoto++}`;
  const { width, height } = await engine.call({ type: 'loadPhoto', photoId: id, bitmap }, [bitmap]);
  const t1 = performance.now();
  try {
    const det = await engine.call({ type: 'detect', photoId: id, options: { maxSide: opts.maxSide, debug: opts.debug, method: opts.method, modelThreshold: opts.modelThreshold } });
    const t2 = performance.now();
    const ordered = readingOrder(det.cards);
    const cards: ScannedCard[] = [];
    for (let g = 0; g < ordered.length; g += CARD_GROUP) {
      const group = ordered.slice(g, g + CARD_GROUP);
      const tc = performance.now();
      const res = await engine.call({ type: 'cardFeatures', photoId: id, quads: group.map((c) => c.quad) });
      const each = (performance.now() - tc) / group.length;
      group.forEach((c, k) => {
        const f = res.cards[k];
        cards.push({ n: g + k + 1, quad: c.quad, box: boundingBox(c.quad), source: c.source, shapeScore: c.score, heightPx: f.heightPx, crop: f.crop, byMethod: nameCard(index, f), ms: each });
      });
      onProgress?.(cards.length, ordered.length);
    }
    const t3 = performance.now();
    // Bad shapes go once named: an outline around neighbours, a second outline of one card.
    const drop =
      opts.cleanup !== false && index?.size
        ? cleanupShapes(cards.map((c) => ({ quad: c.quad, score: c.byMethod[CLEANUP_METHOD]?.candidates[0]?.score ?? 0, name: c.byMethod[CLEANUP_METHOD]?.candidates[0]?.name })))
        : new Map<number, CleanupReason>();
    const kept = cards.filter((_, i) => !drop.has(i)).map((c, k) => ({ ...c, n: k + 1 }));
    const dropped: RejectedShape[] = [...drop].map(([i, reason]) => {
      cards[i].crop.close();
      return { quad: cards[i].quad, reason };
    });
    return {
      id,
      file: file.name,
      width,
      height,
      scale: opts.scale,
      cards: kept,
      rejected: [...det.rejected, ...dropped],
      edges: det.edges,
      timings: { loadMs: t1 - t0, detectMs: t2 - t1, cardsMs: t3 - t2, totalMs: t3 - t0 },
    };
  } finally {
    await engine.call({ type: 'releasePhoto', photoId: id }).catch(() => undefined);
  }
}

/** Frees a scanned photo's bitmaps. */
export function disposePhoto(p: ScannedPhoto) {
  p.edges?.close();
  for (const c of p.cards) c.crop.close();
}

/** Confidence of one method's answer, for the outline colours (thresholds to tune from the measurements). */
export type Confidence = 'sure' | 'review' | 'unknown';

/**
 * Limits on the best score (and its margin over the next other name) per recognition model.
 * The tuned model's, from the 19 test photos (2026-11-20): every right card but one is "sure",
 * and the shapes that span two cards or double a card score below 0.55.
 */
const LIMITS: Record<Recognizer, { sure: number; margin: number; review: number }> = {
  dino: { sure: 0.5, margin: 0.05, review: 0.3 },
  tuned: { sure: 0.6, margin: 0.08, review: 0.4 },
};

export function confidence(r: MethodResult | undefined, method: string, recognizer: Recognizer = 'dino'): Confidence {
  const top = r?.candidates[0];
  if (!r || !top) return 'unknown';
  if (method === 'phash') return top.score >= 0.8 ? 'sure' : top.score >= 0.7 ? 'review' : 'unknown';
  const l = LIMITS[recognizer];
  return top.score >= l.sure && r.margin >= l.margin ? 'sure' : top.score >= l.review ? 'review' : 'unknown';
}

/** The results without pixels, for "Copy results JSON". */
export function photoToJson(p: ScannedPhoto) {
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    file: p.file,
    width: p.width,
    height: p.height,
    scale: p.scale,
    recognizer: p.recognizer ?? 'dino',
    timings: Object.fromEntries(Object.entries(p.timings).map(([k, v]) => [k, Math.round(v)])),
    cards: p.cards.map((c) => ({
      n: c.n,
      quad: c.quad.map((pt) => [Math.round(pt.x), Math.round(pt.y)]),
      source: c.source,
      heightPx: Math.round(c.heightPx),
      ms: Math.round(c.ms),
      byMethod: Object.fromEntries(
        Object.entries(c.byMethod).map(([m, r]) => [
          m,
          { turned: r.turned, margin: round(r.margin), candidates: r.candidates.map((x) => ({ name: x.name, set: x.set, cn: x.cn, score: round(x.score) })) },
        ]),
      ),
    })),
  };
}
