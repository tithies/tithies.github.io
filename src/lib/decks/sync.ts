/**
 * Moxfield deck cache: one request for the deck list, then one per new or changed deck
 * (compared on the list's `lastUpdatedAtUtc`). Every deck is committed as soon as it arrives,
 * so an interrupted sync carries on where it stopped. Reusable by any feature that needs decks.
 */
import { db, getMeta, putMeta } from '@/lib/db';
import { DECK_CARDS_VERSION } from '@/lib/moxfield/decks';
import { describeMoxError, MoxAuthError, MoxCancelledError, MoxError, MoxNotFoundError, MoxRateLimitError, type DeckSource } from '@/lib/moxfield/client';
import { META_DECKS, type DeckRow, type DeckSyncSummary, type DecksMeta } from './types';

export interface DeckSyncProgress {
  phase: 'deckList' | 'decks';
  done: number;
  total: number;
  current?: string;
}

export interface DeckSyncControl {
  signal?: AbortSignal;
  onProgress?: (p: DeckSyncProgress) => void | Promise<void>;
}

/** Errors that stop the whole sync (other per-deck errors are recorded on the deck and skipped). */
const isFatal = (e: unknown) =>
  e instanceof MoxAuthError ||
  e instanceof MoxRateLimitError ||
  e instanceof MoxCancelledError ||
  (e instanceof MoxError && (e.code === 'no_tab' || e.code === 'tab_lost'));

const MAX_CONSECUTIVE_DECK_FAILURES = 3;

/** True when the cached cards don't match the deck list's current version of the deck. */
export const isDeckStale = (d: Pick<DeckRow, 'cardsUpdatedAt' | 'cardsV' | 'lastUpdatedAt'>) =>
  d.cardsUpdatedAt !== d.lastUpdatedAt || d.cardsV !== DECK_CARDS_VERSION;

export async function syncDecks(client: DeckSource, ctl: DeckSyncControl = {}): Promise<DeckSyncSummary> {
  const progress = async (p: DeckSyncProgress) => {
    await ctl.onProgress?.(p);
  };
  const checkCancelled = () => {
    if (ctl.signal?.aborted) throw new MoxCancelledError();
  };

  await progress({ phase: 'deckList', done: 0, total: 0 });
  const list = await client.deckList();
  checkCancelled();

  const meta = (await getMeta<DecksMeta>(META_DECKS)) ?? {};
  const firstSync = !meta.lastSuccessAt;
  const existing = await db.decks.toArray();
  // An empty answer next to a full cache is far more likely a Moxfield hiccup than 200 deleted decks.
  if (!list.length && existing.length) throw new Error('Moxfield returned an empty deck list; the cached decks were kept.');

  const now = Date.now();
  const known = new Map(existing.map((d) => [d.id, d]));
  const listed = new Set(list.map((d) => d.id));
  const removed = existing.filter((d) => !listed.has(d.id)).map((d) => d.id);
  let added = 0;
  const rows: DeckRow[] = list.map((s) => {
    const old = known.get(s.id);
    if (old) return { ...old, ...s };
    added++;
    return { ...s, firstSeenAt: now, isNew: !firstSync };
  });
  await db.transaction('rw', db.decks, db.deckCards, async () => {
    if (removed.length) {
      await db.decks.bulkDelete(removed);
      await db.deckCards.bulkDelete(removed);
    }
    await db.decks.bulkPut(rows);
  });

  // New decks first, then changed ones (list order within each group).
  const stale = rows.filter(isDeckStale).sort((a, b) => Number(known.has(a.id)) - Number(known.has(b.id)));
  const failed: DeckSyncSummary['failed'] = [];
  let changed = 0;
  let fetched = 0;
  let gone = 0;
  let consecutiveFailures = 0;

  for (let i = 0; i < stale.length; i++) {
    const deck = stale[i];
    checkCancelled();
    await progress({ phase: 'decks', done: i, total: stale.length, current: deck.name });
    try {
      const { cards } = await client.deck(deck.publicId);
      const fetchedAt = Date.now();
      await db.transaction('rw', db.decks, db.deckCards, async () => {
        await db.deckCards.put({ deckId: deck.id, v: DECK_CARDS_VERSION, updatedAt: deck.lastUpdatedAt, fetchedAt, cards });
        await db.decks.update(deck.id, {
          cardsUpdatedAt: deck.lastUpdatedAt,
          cardsV: DECK_CARDS_VERSION,
          cardsFetchedAt: fetchedAt,
          cardCount: cards.reduce((s, c) => s + c.qty, 0),
          error: undefined,
        });
      });
      fetched++;
      if (known.has(deck.id)) changed++;
      consecutiveFailures = 0;
    } catch (e) {
      if (e instanceof MoxNotFoundError) {
        // Deleted between the list and now.
        await db.transaction('rw', db.decks, db.deckCards, async () => {
          await db.decks.delete(deck.id);
          await db.deckCards.delete(deck.id);
        });
        gone++;
        continue;
      }
      if (isFatal(e)) throw e;
      const error = describeMoxError(e);
      await db.decks.update(deck.id, { error });
      failed.push({ id: deck.id, name: deck.name, error });
      if (++consecutiveFailures >= MAX_CONSECUTIVE_DECK_FAILURES) {
        throw new Error(`${MAX_CONSECUTIVE_DECK_FAILURES} decks in a row couldn't be read (last: ${error}).`);
      }
    }
  }
  await progress({ phase: 'decks', done: stale.length, total: stale.length });

  const finishedAt = Date.now();
  await putMeta(META_DECKS, { lastSuccessAt: finishedAt, initialSyncAt: meta.initialSyncAt ?? finishedAt } satisfies DecksMeta);
  return { total: rows.length - gone, added, changed, removed: removed.length + gone, fetched, failed };
}

/** Clears the "New" flag of every deck (or of the given ones). */
export async function markDecksSeen(ids?: string[]): Promise<void> {
  const rows = ids ? (await db.decks.bulkGet(ids)).filter((d): d is DeckRow => !!d) : await db.decks.filter((d) => d.isNew).toArray();
  if (!rows.length) return;
  await db.decks.bulkPut(rows.map((d) => ({ ...d, isNew: false })));
}

export async function getDecksMeta(): Promise<DecksMeta> {
  return (await getMeta<DecksMeta>(META_DECKS)) ?? {};
}
