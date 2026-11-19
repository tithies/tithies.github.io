/**
 * Scores scan results against hand-made labels (scanner-samples/labels.json):
 *   { "IMG_0001.jpg": [{ "name": "Sol Ring", "set": "cmm", "cn": "410" }, { "name": "Counterspell" }] }
 * One entry per physical card; set and cn are optional (the print is scored only when given).
 * For each model, labels are paired greedily with detections whose top 5 has that name, best rank first.
 */

export interface LabelCard {
  name: string;
  set?: string;
  cn?: string;
}

export type Labels = Record<string, LabelCard[]>;

export interface ScoredCandidate {
  name: string;
  set: string;
  cn: string;
}

export interface ScoredDetection {
  /** Card height in the photo, in pixels. */
  heightPx: number;
  /** Best candidates first, for each model. */
  byModel: Record<string, readonly ScoredCandidate[]>;
}

export interface ScoredPhoto {
  file: string;
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
  labelled: number;
  detections: number;
  /** Detections paired with no label: false detections, or a card named wrong beyond the top 5. */
  unpaired: number;
  nameTop1: number;
  nameTop5: number;
  /** Labels with a set and number, and how many of those had the print right. */
  withPrint: number;
  printTop1: number;
  printTop5: number;
  /** Top-1 name hits by card height (paired labels only). */
  byHeight: Record<string, { cards: number; nameTop1: number }>;
}

const norm = (s: string) => s.trim().toLowerCase();
/** Same card: same name, or the label names the front face of a double-faced card ("A // B"). */
export const sameName = (label: string, candidate: string) => {
  const l = norm(label);
  const c = norm(candidate);
  return l === c || c.split(' // ')[0] === l || l.split(' // ')[0] === c;
};
const samePrint = (l: LabelCard, c: ScoredCandidate) => norm(l.set ?? '') === norm(c.set) && norm(l.cn ?? '') === norm(c.cn);

export function scorePhotos(photos: readonly ScoredPhoto[], labels: Labels, model: string, topK = 5): ModelScore {
  const s: ModelScore = { labelled: 0, detections: 0, unpaired: 0, nameTop1: 0, nameTop5: 0, withPrint: 0, printTop1: 0, printTop5: 0, byHeight: {} };
  for (const photo of photos) {
    const cards = labels[photo.file];
    if (!cards) continue;
    s.labelled += cards.length;
    s.detections += photo.detections.length;
    s.withPrint += cards.filter((c) => c.set && c.cn).length;
    // Every (label, detection, rank) where the detection's top K has the label's name.
    const pairs: { l: number; d: number; rank: number }[] = [];
    cards.forEach((card, l) =>
      photo.detections.forEach((det, d) => {
        const rank = (det.byModel[model] ?? []).slice(0, topK).findIndex((c) => sameName(card.name, c.name));
        if (rank >= 0) pairs.push({ l, d, rank });
      }),
    );
    pairs.sort((a, b) => a.rank - b.rank);
    const usedL = new Set<number>();
    const usedD = new Set<number>();
    for (const p of pairs) {
      if (usedL.has(p.l) || usedD.has(p.d)) continue;
      usedL.add(p.l);
      usedD.add(p.d);
      const card = cards[p.l];
      const det = photo.detections[p.d];
      const cands = (det.byModel[model] ?? []).slice(0, topK);
      s.nameTop5++;
      if (p.rank === 0) s.nameTop1++;
      const bucket = heightBucket(det.heightPx);
      const b = (s.byHeight[bucket] ??= { cards: 0, nameTop1: 0 });
      b.cards++;
      if (p.rank === 0) b.nameTop1++;
      if (card.set && card.cn) {
        if (cands[0] && samePrint(card, cands[0])) s.printTop1++;
        if (cands.some((c) => samePrint(card, c))) s.printTop5++;
      }
    }
    s.unpaired += photo.detections.length - usedD.size;
  }
  return s;
}

/** Reads labels.json, checking its shape. */
export function parseLabels(text: string): Labels {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('labels.json must be an object: { "photo.jpg": [{ "name": … }] }');
  const out: Labels = {};
  for (const [file, cards] of Object.entries(raw)) {
    if (!Array.isArray(cards)) throw new Error(`labels.json: "${file}" must be a list of cards`);
    out[file] = cards.map((c, i) => {
      if (!c || typeof c.name !== 'string' || !c.name.trim()) throw new Error(`labels.json: card ${i + 1} of "${file}" has no name`);
      return { name: c.name, ...(c.set ? { set: String(c.set) } : {}), ...(c.cn ? { cn: String(c.cn) } : {}) };
    });
  }
  return out;
}
