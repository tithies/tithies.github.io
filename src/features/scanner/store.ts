/**
 * The Scanner's own IndexedDB database ("tithies-scanner"), apart from the main one so its schema
 * can change freely. It holds the reference vectors of prints (Scryfall prints: shared by every
 * account, so forgetting an account leaves them), the labelling mode's drafts (labels.ts), and the
 * Scanner page's scan session (scan-session.ts). Model files live in Cache Storage (model-cache.ts).
 * Settings → Remove all data deletes all of it.
 */
import Dexie, { type EntityTable } from 'dexie';
import type { PhotoLabels } from './labels';
import type { StoredPhoto } from './scan-session';
import { clearModelCache } from './model-cache';
import { DINO_FILE, RUNS } from './models';

/**
 * The downloaded DINOv2's vectors. Vectors made with another model or other runs are not
 * comparable: each model has its own key (a tuned model's: tunedModelKey).
 */
export const MODEL_KEY = `${DINO_FILE.id}|${RUNS.map((r) => r.id).join(',')}|v1`;

/** A tuned recognition model's key: its size and a sample of its bytes (another file, other vectors). */
export function tunedModelKey(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes);
  let h = 2166136261;
  const mix = (b: number) => (h = Math.imul(h ^ b, 16777619) >>> 0);
  for (let i = 0; i < u8.length; i += 997) mix(u8[i]);
  for (let i = Math.max(0, u8.length - 256); i < u8.length; i++) mix(u8[i]);
  return `tuned|${u8.length}|${h.toString(16)}|${RUNS.map((r) => r.id).join(',')}`;
}

/**
 * A row's key: the print's Scryfall id, "~back" for the back face of a double-faced card,
 * prefixed by the model key for any model but the downloaded DINOv2 (whose rows came first).
 */
export function rowKey(modelKey: string, scryfallId: string, back: boolean): string {
  const id = back ? `${scryfallId}~back` : scryfallId;
  return modelKey === MODEL_KEY ? id : `${modelKey}#${id}`;
}

export interface RefRow {
  /** The row's key (rowKey): for the first rows, just the print's Scryfall id. */
  scryfallId: string;
  /** The print's Scryfall id, when the key isn't just that. */
  printId?: string;
  /** The picture is the card's back face. */
  back?: boolean;
  modelKey: string;
  name: string;
  set: string;
  setName: string;
  cn: string;
  lang?: string;
  /** The Scryfall id whose picture made the vectors, when not the print's own (reference.ts: pictureStandIns). */
  picture?: string;
  /** One normalized vector per variant (models.ts). */
  vectors: Record<string, Float32Array>;
  /** The pHash of rows made before 2026-11-27 (no longer used). */
  phash?: Uint32Array;
  addedAt: number;
}

export interface ScannerMeta {
  key: string;
  value: unknown;
}

/** A photo's labels as last edited (the labelling mode saves as you go). */
export interface LabelDraft {
  file: string;
  /** The photo file's size, to notice another photo with the same name. */
  size: number;
  labels: PhotoLabels;
  updatedAt: number;
}

export class ScannerDB extends Dexie {
  refs!: EntityTable<RefRow, 'scryfallId'>;
  /** 'noBack': Scryfall ids of two-named prints with no back picture (adventures, split cards). */
  meta!: EntityTable<ScannerMeta, 'key'>;
  labels!: EntityTable<LabelDraft, 'file'>;
  /** The Scanner page's scan session: one row per photo (scan-session.ts). */
  scanPhotos!: EntityTable<StoredPhoto, 'id'>;

  constructor(name = 'tithies-scanner') {
    super(name);
    this.version(1).stores({ refs: 'scryfallId, modelKey' });
    this.version(2).stores({ meta: 'key' });
    this.version(3).stores({ labels: 'file' });
    this.version(4).stores({ scanPhotos: 'id, addedAt' });
  }
}

export const scannerDb = new ScannerDB();

/** Reference pictures made with a model (row keys: rowKey). */
export const currentRefs = (modelKey = MODEL_KEY): Promise<RefRow[]> => scannerDb.refs.where('modelKey').equals(modelKey).toArray();
export const currentRefIds = async (modelKey = MODEL_KEY): Promise<Set<string>> => new Set(await scannerDb.refs.where('modelKey').equals(modelKey).primaryKeys());

/** Removes the reference rows of tuned models other than `keep`: a newly dropped tuned file replaces the old one. */
export async function dropOtherTuned(keep: string): Promise<number> {
  return scannerDb.refs.where('modelKey').startsWith('tuned|').and((r) => r.modelKey !== keep).delete();
}

export async function noBackIds(): Promise<Set<string>> {
  return new Set(((await scannerDb.meta.get('noBack'))?.value as string[] | undefined) ?? []);
}

export async function addNoBack(ids: Iterable<string>): Promise<void> {
  const all = await noBackIds();
  for (const id of ids) all.add(id);
  await scannerDb.meta.put({ key: 'noBack', value: [...all] });
}

export const labelDrafts = (): Promise<LabelDraft[]> => scannerDb.labels.toArray();

export async function saveLabelDraft(file: string, size: number, labels: PhotoLabels): Promise<void> {
  await scannerDb.labels.put({ file, size, labels, updatedAt: Date.now() });
}

/** When labels.json was last downloaded (drafts edited after it are "not downloaded"). */
export async function labelsDownloadedAt(): Promise<number> {
  return ((await scannerDb.meta.get('labelsDownloadedAt'))?.value as number | undefined) ?? 0;
}

export async function markLabelsDownloaded(at = Date.now()): Promise<void> {
  await scannerDb.meta.put({ key: 'labelsDownloadedAt', value: at });
}

/** Bytes the reference vectors and the label drafts take, and how many prints. */
export async function measureScannerData(): Promise<{ prints: number; bytes: number }> {
  let prints = 0;
  let bytes = 0;
  await scannerDb.refs.each((r) => {
    prints++;
    bytes += Object.values(r.vectors).reduce((s, v) => s + v.byteLength, 0) + (r.phash?.byteLength ?? 0) + 120;
  });
  await scannerDb.labels.each((d) => {
    bytes += 200 + d.labels.cards.length * 220;
  });
  return { prints, bytes };
}

/** Deletes every reference vector, label draft and cached model file (the scan session stays: clearScannerSession). */
export async function clearScannerData(): Promise<void> {
  await scannerDb.refs.clear();
  await scannerDb.meta.clear();
  await scannerDb.labels.clear();
  if (typeof caches !== 'undefined') await clearModelCache();
}
