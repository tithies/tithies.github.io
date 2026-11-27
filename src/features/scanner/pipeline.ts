/**
 * One photo through the prototype: decode (phone orientation applied), optionally shrink it (to
 * find the smallest card size that still works), detect the cards, then for each card take its
 * features (upright and turned 180°) and name them (a Namer: the reference set built from the collection with every
 * method, or the every-print index). Each method keeps the way up whose best hit scores higher.
 */
import type { ScannerEngine } from './engine-client';
import { cleanupShapes, type CleanupReason } from './cleanup';
import { boundingBox, centroid, quadSize, type Box, type Quad } from './geometry';
import { nameMargin, type Hit } from './match';
import { ALL_METHODS } from './models';
import type { CardFeatures, CardSource, DetectOptions, RejectedShape } from './protocol';
import type { PrintInfo } from './reference';
import { CHECK_METHOD, CHECKED_METHOD, checkCard, type CardCheck, type TextModels } from './scanner-check';
import { searchIndex, type RefIndex } from './search-index';

export const TOP_K = 5;
/** Cards per engine call: 4 cards × 2 ways up × 2 model runs = one batch of 16 pictures. */
const CARD_GROUP = 4;

export interface CardMatch extends PrintInfo {
  score: number;
}

export interface MethodResult {
  candidates: CardMatch[];
  /** The every-print index's top 20 (phase 3 picks among the same-art prints there). */
  more?: CardMatch[];
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
  /** Phase 3: the print among same-art reprints and the language (scanner-check.ts). */
  check?: CardCheck;
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
  /** Phase 3 (every-print index only): the print among same-art reprints, the language. */
  check?: CheckOptions | null;
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

/**
 * What names cards: the reference set built from the collection (every method, searched here), or the every-print
 * index (padded · CLS, searched in the search worker). One call names many cards (the search reads the index once).
 */
export interface Namer {
  /** Pictures it names against. */
  size: number;
  /** Its prints (the labelling mode's print picker). */
  prints: readonly PrintInfo[];
  name(cards: readonly Pick<CardFeatures, 'upright' | 'turned'>[]): Promise<Record<string, MethodResult>[]>;
}

/** The reference set built from the collection (reference.ts). */
export function refNamer(index: RefIndex): Namer {
  return { size: index.size, prints: index.prints, name: async (cards) => cards.map((f) => nameCard(index, f)) };
}

/** Queries of each card, upright then turned, to search: [upright 0, turned 0, upright 1, …]. */
export const sideQueries = (cards: readonly Pick<CardFeatures, 'upright' | 'turned'>[], method: string) => cards.flatMap((f) => [f.upright.vectors[method], f.turned.vectors[method]]);

/** Hits of [upright, turned] pairs → each card's result, keeping the way up whose best hit scores higher (as nameCard). */
export function pairResults(hits: readonly Hit[][], prints: readonly PrintInfo[]): MethodResult[] {
  const out: MethodResult[] = [];
  for (let i = 0; i + 1 < hits.length; i += 2) {
    const up = hits[i];
    const down = hits[i + 1];
    const turned = (down[0]?.score ?? -Infinity) > (up[0]?.score ?? -Infinity);
    const h = turned ? down : up;
    const all = h.map((x) => ({ ...prints[x.index], score: x.score }));
    // Shown, scored and used for the margin: the first TOP_K, as always; the rest is phase 3's pool.
    const top = h.slice(0, TOP_K);
    out.push({ candidates: all.slice(0, TOP_K), ...(h.length > TOP_K ? { more: all } : {}), margin: nameMargin(top, (j) => prints[j].name), turned });
  }
  return out;
}

/** Names cards at corners placed by hand, in a photo already loaded in the engine (full-resolution pixels). */
export async function nameQuads(engine: ScannerEngine, photoId: string, quads: readonly Quad[], namer: Namer | null): Promise<{ crop: ImageBitmap; heightPx: number; byMethod: Record<string, MethodResult> }[]> {
  const feats: CardFeatures[] = [];
  for (let g = 0; g < quads.length; g += CARD_GROUP) feats.push(...(await engine.call({ type: 'cardFeatures', photoId, quads: quads.slice(g, g + CARD_GROUP) })).cards);
  const named = namer?.size ? await namer.name(feats) : feats.map(() => ({}));
  return feats.map((f, i) => ({ crop: f.crop, heightPx: f.heightPx, byMethod: named[i] }));
}

let nextPhoto = 1;

/**
 * Decodes a photo (phone orientation applied), shrinks it to `scale`, and loads it into the engine under a new id
 * (release it with `releasePhoto`). Quads are in the loaded photo's pixels: full resolution at scale 1.
 */
export async function loadPhoto(engine: ScannerEngine, file: Blob, scale = 1): Promise<{ id: string; width: number; height: number }> {
  let bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  if (scale < 1) {
    const small = await createImageBitmap(bitmap, {
      resizeWidth: Math.max(1, Math.round(bitmap.width * scale)),
      resizeHeight: Math.max(1, Math.round(bitmap.height * scale)),
      resizeQuality: 'high',
    });
    bitmap.close();
    bitmap = small;
  }
  const id = `p${nextPhoto++}`;
  const { width, height } = await engine.call({ type: 'loadPhoto', photoId: id, bitmap }, [bitmap]);
  return { id, width, height };
}

/** Phase 3's options: the print among same-art reprints, the language. */
export interface CheckOptions {
  models: TextModels;
  prints: boolean;
  language: boolean;
}

/**
 * Phase 3 on cards of a photo loaded in the engine: each card's print and language (scanner-check.ts), from its
 * search result (it needs the every-print index's top 20, `more`). Cards without one are skipped.
 */
export async function checkCards(
  engine: ScannerEngine,
  photoId: string,
  cards: readonly { quad: Quad; result: MethodResult | undefined }[],
  opts: CheckOptions,
  onCard: (k: number, out: { result: MethodResult; check: CardCheck }) => void | Promise<void>,
  stop?: () => boolean,
): Promise<void> {
  if (!opts.prints && !opts.language) return;
  for (const [k, c] of cards.entries()) {
    if (stop?.()) return;
    if (!c.result?.more) continue;
    await onCard(k, await checkCard(engine, opts.models, photoId, c.quad, c.result, opts));
  }
}

/**
 * Phase 3 on a photo named earlier (the Scanner page names every photo first, then checks): the photo is loaded
 * again at full resolution, its cards checked, then released.
 */
export async function checkPhoto(
  engine: ScannerEngine,
  file: Blob,
  cards: readonly { quad: Quad; result: MethodResult | undefined }[],
  opts: CheckOptions,
  onCard: (k: number, out: { result: MethodResult; check: CardCheck }) => void | Promise<void>,
  /** Stops between two cards (the page: a new photo waits to be named). */
  stop?: () => boolean,
): Promise<void> {
  const { id } = await loadPhoto(engine, file);
  try {
    await checkCards(engine, id, cards, opts, onCard, stop);
  } finally {
    await engine.call({ type: 'releasePhoto', photoId: id }).catch(() => undefined);
  }
}

export async function scanPhoto(
  engine: ScannerEngine,
  file: File,
  namer: Namer | null,
  opts: ScanOptions,
  onProgress?: (done: number, total: number) => void,
  onCheck?: (done: number, total: number) => void,
): Promise<ScannedPhoto> {
  const t0 = performance.now();
  const { id, width, height } = await loadPhoto(engine, file, opts.scale);
  const t1 = performance.now();
  try {
    const det = await engine.call({ type: 'detect', photoId: id, options: { modelThreshold: opts.modelThreshold } });
    const t2 = performance.now();
    const ordered = readingOrder(det.cards);
    const cards: ScannedCard[] = [];
    const feats: CardFeatures[] = [];
    for (let g = 0; g < ordered.length; g += CARD_GROUP) {
      const group = ordered.slice(g, g + CARD_GROUP);
      const tc = performance.now();
      const res = await engine.call({ type: 'cardFeatures', photoId: id, quads: group.map((c) => c.quad) });
      const each = (performance.now() - tc) / group.length;
      group.forEach((c, k) => {
        const f = res.cards[k];
        feats.push(f);
        cards.push({ n: g + k + 1, quad: c.quad, box: boundingBox(c.quad), source: c.source, shapeScore: c.score, heightPx: f.heightPx, crop: f.crop, byMethod: {}, ms: each });
      });
      onProgress?.(cards.length, ordered.length);
    }
    // Every card of the photo named in one search; its time shared among them.
    const tn = performance.now();
    if (namer?.size && feats.length) {
      const named = await namer.name(feats);
      const each = (performance.now() - tn) / feats.length;
      cards.forEach((c, i) => {
        c.byMethod = named[i];
        c.ms += each;
      });
    }
    const t3 = performance.now();
    // Bad shapes go once named: an outline around neighbours, a second outline of one card.
    const drop =
      opts.cleanup !== false && namer?.size
        ? cleanupShapes(cards.map((c) => ({ quad: c.quad, score: c.byMethod[CLEANUP_METHOD]?.candidates[0]?.score ?? 0, name: c.byMethod[CLEANUP_METHOD]?.candidates[0]?.name })))
        : new Map<number, CleanupReason>();
    const kept = cards.filter((_, i) => !drop.has(i)).map((c, k) => ({ ...c, n: k + 1 }));
    // Phase 3, on the kept cards, while the photo is still in the engine.
    if (opts.check) {
      await checkCards(engine, id, kept.map((c) => ({ quad: c.quad, result: c.byMethod[CHECKED_METHOD] })), opts.check, (k, { result, check }) => {
        const c = kept[k];
        c.byMethod = { ...c.byMethod, [CHECK_METHOD]: result };
        c.check = check;
        onCheck?.(k + 1, kept.length);
      });
    }
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
      rejected: dropped,
      timings: { loadMs: t1 - t0, detectMs: t2 - t1, cardsMs: t3 - t2, totalMs: t3 - t0 },
    };
  } finally {
    await engine.call({ type: 'releasePhoto', photoId: id }).catch(() => undefined);
  }
}

/** Frees a scanned photo's bitmaps. */
export function disposePhoto(p: ScannedPhoto) {
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
      ...(c.check
        ? {
            check: {
              print: c.check.print && { how: c.check.print.how, margin: c.check.print.margin === undefined ? undefined : round(c.check.print.margin), read: c.check.print.read },
              language: c.check.language,
              ms: Math.round(c.check.ms),
              times: c.check.times,
            },
          }
        : {}),
      byMethod: Object.fromEntries(
        Object.entries(c.byMethod).map(([m, r]) => [
          m,
          { turned: r.turned, margin: round(r.margin), candidates: r.candidates.map((x) => ({ name: x.name, set: x.set, cn: x.cn, score: round(x.score) })) },
        ]),
      ),
    })),
  };
}
