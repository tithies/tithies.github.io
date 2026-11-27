/**
 * The order of the Scanner page's work, one engine job at a time: every photo is found and named first (well under
 * a second per card, so its rows show at once), then its cards are checked (print and language, about 3 s a card),
 * photo by photo. A check job stops between two cards when a new photo waits to be named.
 */
import type { StoredCard, StoredPhoto } from './scan-session';

export type ScanJob = { kind: 'name'; photoId: string } | { kind: 'check'; photoId: string; cards: number[] };

/** A card still to check: not removed, not checked yet, and with the every-print index's top 20 to check among. */
export const needsCheck = (c: StoredCard): boolean => !c.edit?.removed && !c.check && !!c.result.more;

/** The next job: the oldest photo to name, else (checks on) the oldest photo with cards to check, else nothing. */
export function nextJob(photos: readonly StoredPhoto[], opts: { check: boolean }): ScanJob | null {
  const byAge = [...photos].sort((a, b) => a.addedAt - b.addedAt);
  const toName = byAge.find((p) => p.status === 'queued');
  if (toName) return { kind: 'name', photoId: toName.id };
  if (!opts.check) return null;
  for (const p of byAge) {
    if (p.status !== 'named') continue;
    const cards = p.cards.filter(needsCheck).map((c) => c.n);
    if (cards.length) return { kind: 'check', photoId: p.id, cards };
  }
  return null;
}

/** Whether a running check job should stop: a photo is waiting to be named. */
export const shouldYield = (photos: readonly StoredPhoto[]): boolean => photos.some((p) => p.status === 'queued');
