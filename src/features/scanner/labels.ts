/**
 * Hand-checked labels of the Scanner's test and training photos (real/labels.json in the
 * tithies-scanner-trainer repo).
 *
 * Format 2 (written by the labelling mode):
 *   { "IMG_0001.jpg": { "width": 4000, "height": 3000, "checked": true, "cards": [
 *       { "name": "Sol Ring", "set": "cmm", "cn": "410", "scryfallId": "…", "back": false,
 *         "quad": [[x, y], [x, y], [x, y], [x, y]], "hidden": false, "checked": true, "manual": true } ] } }
 * - checked: a person looked at this card, its corners and its print.
 * - manual: its print was given by a person (or came from a format-1 file); it counts when
 *   scoring even before its corners are checked, and moving its corners keeps it.
 * - quad: corners in the photo's full-resolution pixels, phone orientation applied (as the page
 *   shows it), clockwise from the card's own top-left, so a cut-out along them is upright.
 * - A fanned or covered card is outlined whole, where it lies; "hidden" marks one mostly covered:
 *   it is neither a miss nor an extra shape when scoring, and not a recognition pair.
 * Format 1 (still read): { "IMG_0001.jpg": [{ "name": "Sol Ring", "set": "cmm", "cn": "410" }] }.
 */
import type { Point, Quad } from './geometry';
import { quadIoU, scaleQuad } from './geometry';
import type { MethodResult, ScannedPhoto } from './pipeline';

export interface LabelCard {
  name: string;
  set?: string;
  cn?: string;
  scryfallId?: string;
  /** The card shows its back face. */
  back?: boolean;
  quad?: Quad;
  hidden?: boolean;
  /** A person looked at it (outline and print). */
  checked?: boolean;
  /** The print was given by a person (or an older labels file): moving the corners keeps it. */
  manual?: boolean;
  /** Stable id while editing (not written to the file). */
  id?: string;
}

export interface PhotoLabels {
  /** Full-resolution size, orientation applied. */
  width?: number;
  height?: number;
  cards: LabelCard[];
}

export type Labels = Record<string, PhotoLabels>;

let nextId = 1;
export const newLabelId = () => `l${nextId++}`;

const round1 = (v: number) => Math.round(v * 10) / 10;

function readQuad(v: unknown, where: string): Quad | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length !== 4 || !v.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === 'number' && Number.isFinite(n))))
    throw new Error(`labels.json: ${where} has a "quad" that isn't 4 [x, y] corners`);
  return (v as [number, number][]).map(([x, y]) => ({ x, y })) as Quad;
}

function readCard(c: unknown, where: string, oldFormat: boolean): LabelCard {
  const r = c as Record<string, unknown> | null;
  if (!r || typeof r.name !== 'string' || !r.name.trim()) throw new Error(`labels.json: ${where} has no name`);
  const card: LabelCard = { name: r.name, id: newLabelId() };
  if (r.set) card.set = String(r.set);
  if (r.cn) card.cn = String(r.cn);
  if (r.scryfallId) card.scryfallId = String(r.scryfallId);
  if (r.back) card.back = true;
  const quad = readQuad(r.quad, where);
  if (quad) card.quad = quad;
  if (r.hidden) card.hidden = true;
  if (r.checked) card.checked = true;
  // Prints in an older file, or given or checked by a person, are kept when the corners move.
  if (oldFormat || r.manual || card.checked) card.manual = true;
  return card;
}

/** Reads labels.json (format 1 or 2), checking its shape. */
export function parseLabels(text: string): Labels {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('labels.json must be an object: { "photo.jpg": … }');
  const out: Labels = {};
  for (const [file, v] of Object.entries(raw)) {
    if (Array.isArray(v)) {
      out[file] = { cards: v.map((c, i) => readCard(c, `card ${i + 1} of "${file}"`, true)) };
      continue;
    }
    const p = v as Record<string, unknown> | null;
    if (!p || typeof p !== 'object' || !Array.isArray(p.cards)) throw new Error(`labels.json: "${file}" must be a list of cards, or { "cards": [...] }`);
    out[file] = {
      ...(typeof p.width === 'number' ? { width: p.width } : {}),
      ...(typeof p.height === 'number' ? { height: p.height } : {}),
      cards: p.cards.map((c, i) => readCard(c, `card ${i + 1} of "${file}"`, false)),
    };
  }
  return out;
}

/** A photo is checked when every card is, and every card that isn't mostly hidden has corners. */
export const photoChecked = (p: PhotoLabels) => p.cards.length > 0 && p.cards.every((c) => c.checked && (c.quad || c.hidden));

/** labels.json, format 2 (photos sorted by name). */
export function serializeLabels(labels: Labels): string {
  const out: Record<string, unknown> = {};
  for (const file of Object.keys(labels).sort()) {
    const p = labels[file];
    out[file] = {
      ...(p.width ? { width: p.width, height: p.height } : {}),
      checked: photoChecked(p),
      cards: p.cards.map((c) => ({
        name: c.name,
        ...(c.set ? { set: c.set } : {}),
        ...(c.cn ? { cn: c.cn } : {}),
        ...(c.scryfallId ? { scryfallId: c.scryfallId } : {}),
        ...(c.back ? { back: true } : {}),
        ...(c.quad ? { quad: c.quad.map((q) => [round1(q.x), round1(q.y)]) } : {}),
        ...(c.hidden ? { hidden: true } : {}),
        ...(c.checked ? { checked: true } : {}),
        ...(c.manual ? { manual: true } : {}),
      })),
    };
  }
  return JSON.stringify(out, null, 1);
}

/** The same corners starting from the opposite one: the card turned 180°. */
export const turnQuad = (q: Quad): Quad => [q[2], q[3], q[0], q[1]];

/** Corners from the scanned size to the photo's full resolution. */
export const toFullSize = (q: Quad, scan: Pick<ScannedPhoto, 'scale'>): Quad => (scan.scale === 1 ? q : scaleQuad(q, 1 / scan.scale));

/** A card's best match as label fields: the print, and the corners from the card's own top-left. */
export function fromMatch(quad: Quad, r: MethodResult | undefined): Pick<LabelCard, 'name' | 'set' | 'cn' | 'scryfallId' | 'back' | 'quad'> {
  const top = r?.candidates[0];
  const q = r?.turned ? turnQuad(quad) : quad;
  if (!top) return { name: '?', quad: q };
  return { name: top.name, set: top.set, cn: top.cn, scryfallId: top.scryfallId, ...(top.back ? { back: true } : {}), quad: q };
}

const norm = (s: string) => s.trim().toLowerCase();
/** Same card: same name, or one names a face of the other's double-faced card ("A // B"). */
export const sameName = (label: string, candidate: string) => {
  const l = norm(label);
  const c = norm(candidate);
  return l === c || c.split(' // ').includes(l) || l.split(' // ')[0] === c;
};
export const samePrint = (l: Pick<LabelCard, 'set' | 'cn'>, c: { set: string; cn: string }) => !!l.set && norm(l.set) === norm(c.set) && norm(l.cn ?? '') === norm(c.cn);

/**
 * Pairs labels with cards by name: each card's top `k` must hold the label's name. Best rank
 * first, then the exact print (so two Forests of different prints pair the right way round),
 * then the better match (a card outlined twice: the label takes the outline that matches best).
 * Returns label index -> card index.
 */
export function pairByName(labels: readonly Pick<LabelCard, 'name' | 'set' | 'cn'>[], cands: readonly (readonly { name: string; set: string; cn: string; score?: number }[])[], k = 5, skip: ReadonlySet<number> = new Set()): Map<number, number> {
  const pairs: { l: number; d: number; rank: number; exact: boolean; score: number }[] = [];
  labels.forEach((label, l) =>
    cands.forEach((cs, d) => {
      if (skip.has(d)) return;
      const rank = cs.slice(0, k).findIndex((c) => sameName(label.name, c.name));
      if (rank >= 0) pairs.push({ l, d, rank, exact: samePrint(label, cs[rank]), score: cs[rank].score ?? 0 });
    }),
  );
  pairs.sort((a, b) => a.rank - b.rank || Number(b.exact) - Number(a.exact) || b.score - a.score);
  const out = new Map<number, number>();
  const usedD = new Set<number>();
  for (const p of pairs) {
    if (out.has(p.l) || usedD.has(p.d)) continue;
    out.set(p.l, p.d);
    usedD.add(p.d);
  }
  return out;
}

/** A label being edited, with what the scanner saw there (not saved). */
export interface CardMatchView {
  crop?: ImageBitmap;
  heightPx?: number;
  result?: MethodResult;
}

/**
 * Draft labels for a scanned photo: one card per card found (its corners and best match,
 * unchecked). With older labels (names only), those are paired with the cards found by name and
 * keep their print; the ones left get no corners ("needs an outline"). The matches come back too,
 * keyed by label id, for the editor.
 */
export function draftFromScan(scan: ScannedPhoto, method: string, old?: readonly LabelCard[]): { photo: PhotoLabels; matches: Map<string, CardMatchView> } {
  const matches = new Map<string, CardMatchView>();
  const cards: LabelCard[] = [];
  const view = (i: number): CardMatchView => ({ crop: scan.cards[i].crop, heightPx: scan.cards[i].heightPx, result: scan.cards[i].byMethod[method] });
  // Only labels without corners are paired by name.
  const loose = (old ?? []).map((o, l) => ({ o, l })).filter(({ o }) => !o.quad);
  const paired = loose.length ? pairByName(loose.map(({ o }) => o), scan.cards.map((c) => c.byMethod[method]?.candidates ?? [])) : new Map<number, number>();
  const pairs = new Map([...paired].map(([k, d]) => [loose[k].l, d]));
  const used = new Set(pairs.values());
  // Cards found where a label already has corners are that label.
  for (const o of old ?? []) {
    if (!o.quad) continue;
    scan.cards.forEach((c, i) => {
      if (!used.has(i) && quadIoU(toFullSize(c.quad, scan), o.quad!) >= 0.5) used.add(i);
    });
  }
  (old ?? []).forEach((o, l) => {
    const d = pairs.get(l);
    const card: LabelCard = { ...o, id: o.id ?? newLabelId(), manual: o.manual ?? true };
    if (d !== undefined) {
      const r = scan.cards[d].byMethod[method];
      card.quad = fromMatch(toFullSize(scan.cards[d].quad, scan), r).quad;
      matches.set(card.id!, view(d));
    }
    cards.push(card);
  });
  scan.cards.forEach((c, i) => {
    if (used.has(i)) return;
    const r = c.byMethod[method];
    const card: LabelCard = { ...fromMatch(toFullSize(c.quad, scan), r), id: newLabelId() };
    matches.set(card.id!, view(i));
    cards.push(card);
  });
  return { photo: { width: Math.round(scan.width / scan.scale), height: Math.round(scan.height / scan.scale), cards }, matches };
}

/** Corners of a point list, for SVG. */
export const svgPoints = (pts: readonly Point[]) => pts.map((p) => `${p.x},${p.y}`).join(' ');
