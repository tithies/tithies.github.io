/**
 * The Scanner page's scan session: every photo added, its cards as found and named, their print and language checks
 * and the user's corrections. It stays in IndexedDB ("tithies-scanner" → scanPhotos) until "Clear scan", so a reload
 * loses nothing. Pixels are kept as Blobs (an ImageBitmap can't be stored): the photo's own file, and each card's
 * cut-out as WebP. Quads are in the photo's full-resolution pixels (the page scans at full resolution).
 */
import type { Finish } from '@/lib/cards/types';
import type { Quad } from './geometry';
import type { CardMatch, MethodResult } from './pipeline';
import type { CardSource } from './protocol';
import type { CardCheck } from './scanner-check';
import { scannerDb } from './store';

/** What the user changed on a card. A correction is final: a later check never overwrites it. */
export interface CardEdit {
  /** "Not a card": left out of the list and the export. */
  removed?: boolean;
  /** The print picked by the user (an every-print index row: its finishes and artwork come along). */
  print?: CardMatch;
  /** Scryfall language code. */
  lang?: string;
  finish?: Finish;
}

export interface StoredCard {
  /** Number shown on the photo (1-based). */
  n: number;
  quad: Quad;
  heightPx: number;
  source: CardSource;
  /** The flattened card (488 × 680), WebP. */
  crop: Blob;
  /** The search's answer (padded · CLS), with the every-print index's top 20 (`more`) for the check and the print picker. */
  result: MethodResult;
  /** The print and language check (phase 3), once done; the text lines read are not kept. */
  check?: Omit<CardCheck, 'lines'>;
  edit?: CardEdit;
  /** When it went out in an export (it isn't sent twice). */
  sentAt?: number;
}

export type PhotoStatus = 'queued' | 'named' | 'failed';

export interface StoredPhoto {
  /** Stable id (the engine's photo ids are per page load). */
  id: string;
  name: string;
  size: number;
  type: string;
  /** The photo file itself. */
  blob: Blob;
  addedAt: number;
  /** Full-resolution size, once named (0 before). */
  width: number;
  height: number;
  status: PhotoStatus;
  error?: string;
  cards: StoredCard[];
}

/** The session's photos, oldest first. */
export async function sessionPhotos(): Promise<StoredPhoto[]> {
  return scannerDb.scanPhotos.orderBy('addedAt').toArray();
}

/** New photos, queued to be scanned (ids made here; `now` and `id` for the tests). */
export async function addSessionPhotos(files: readonly File[], now = Date.now(), id: () => string = () => crypto.randomUUID()): Promise<StoredPhoto[]> {
  const rows: StoredPhoto[] = files.map((f, i) => ({ id: id(), name: f.name, size: f.size, type: f.type, blob: f, addedAt: now + i, width: 0, height: 0, status: 'queued', cards: [] }));
  await scannerDb.scanPhotos.bulkAdd(rows);
  return rows;
}

export async function saveSessionPhoto(p: StoredPhoto): Promise<void> {
  await scannerDb.scanPhotos.put(p);
}

/** Changes one card (by its number) of a stored photo and returns the photo as saved, or null when it's gone. */
export async function updateSessionCard(photoId: string, n: number, change: (c: StoredCard) => StoredCard): Promise<StoredPhoto | null> {
  return scannerDb.transaction('rw', scannerDb.scanPhotos, async () => {
    const p = await scannerDb.scanPhotos.get(photoId);
    if (!p) return null;
    const next = { ...p, cards: p.cards.map((c) => (c.n === n ? change(c) : c)) };
    await scannerDb.scanPhotos.put(next);
    return next;
  });
}

export async function removeSessionPhoto(photoId: string): Promise<void> {
  await scannerDb.scanPhotos.delete(photoId);
}

export async function clearScannerSession(): Promise<void> {
  await scannerDb.scanPhotos.clear();
}

/** The session's size: photos, cards, and bytes (the photo files and the cut-outs). */
export async function measureScannerSession(): Promise<{ photos: number; cards: number; bytes: number }> {
  let photos = 0;
  let cards = 0;
  let bytes = 0;
  await scannerDb.scanPhotos.each((p) => {
    photos++;
    cards += p.cards.length;
    bytes += p.blob.size + p.cards.reduce((s, c) => s + c.crop.size + 2000, 0) + 500;
  });
  return { photos, cards, bytes };
}

/** A card cut-out as a WebP Blob (browser only: OffscreenCanvas). */
export async function cropBlob(bitmap: ImageBitmap, quality = 0.85): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D canvas');
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: 'image/webp', quality });
}
