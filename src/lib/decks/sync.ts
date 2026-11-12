/**
 * Deck cache of one account: one request for the deck list, then one per new or changed deck
 * (compared on the list's last-updated time). Every deck is committed as soon as it arrives,
 * so an interrupted sync carries on where it stopped. Reusable by any feature that needs decks.
 *
 * Every answer is checked by the client to come from the account being synced before anything is
 * written: an answer from another account (the site's login changed meanwhile) stops the sync
 * with what was already read kept, and never deletes a deck.
 */
import type { AccountData } from '@/lib/accounts/data';
import { CancelledError, describeSiteError, SiteAuthError, SiteError, SiteNotFoundError, SiteRateLimitError, type DeckSource } from '@/lib/sites/client';
import type { SiteProvider } from '@/lib/sites/provider';
import type { DeckRow, DeckSyncSummary, DecksMeta } from './types';

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
  e instanceof SiteAuthError ||
  e instanceof SiteRateLimitError ||
  e instanceof CancelledError ||
  (e instanceof SiteError && (e.code === 'no_tab' || e.code === 'tab_lost' || e.code === 'wrong_account'));

const MAX_CONSECUTIVE_DECK_FAILURES = 3;

/** True when the cached cards don't match the deck list's current version of the deck (or an older normaliser read them). */
export const isDeckStale = (d: Pick<DeckRow, 'cardsUpdatedAt' | 'cardsV' | 'lastUpdatedAt'>, cardsVersion: number) =>
  d.cardsUpdatedAt !== d.lastUpdatedAt || d.cardsV !== cardsVersion;

export async function syncDecks(
  site: Pick<SiteProvider, 'label' | 'deckCardsVersion'>,
  data: AccountData,
  client: DeckSource,
  ctl: DeckSyncControl = {},
): Promise<DeckSyncSummary> {
  const cardsVersion = site.deckCardsVersion;
  const progress = async (p: DeckSyncProgress) => {
    await ctl.onProgress?.(p);
  };
  const checkCancelled = () => {
    if (ctl.signal?.aborted) throw new CancelledError();
  };

  await progress({ phase: 'deckList', done: 0, total: 0 });
  const list = await client.deckList();
  checkCancelled();

  const meta = (await data.meta.get('decks')) ?? {};
  const firstSync = !meta.lastSuccessAt;
  const existing = await data.decks.list();
  // An empty answer next to a full cache is far more likely a site hiccup than 200 deleted decks.
  if (!list.length && existing.length) throw new Error(`${site.label} returned an empty deck list; the cached decks were kept.`);

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
  await data.write(async (w) => {
    await w.decks.remove(removed);
    await w.decks.putMany(rows);
  });

  // New decks first, then changed ones (list order within each group).
  const stale = rows.filter((d) => isDeckStale(d, cardsVersion)).sort((a, b) => Number(known.has(a.id)) - Number(known.has(b.id)));
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
      await data.write(async (w) => {
        await w.deckCards.put({ deckId: deck.id, v: cardsVersion, updatedAt: deck.lastUpdatedAt, fetchedAt, cards });
        await w.decks.update(deck.id, {
          cardsUpdatedAt: deck.lastUpdatedAt,
          cardsV: cardsVersion,
          cardsFetchedAt: fetchedAt,
          cardCount: cards.reduce((s, c) => s + c.qty, 0),
          error: undefined,
        });
      });
      fetched++;
      if (known.has(deck.id)) changed++;
      consecutiveFailures = 0;
    } catch (e) {
      // Only reachable for an answer made as this account (the client checks who answered first).
      if (e instanceof SiteNotFoundError) {
        // Deleted between the list and now.
        await data.write((w) => w.decks.remove([deck.id]));
        gone++;
        continue;
      }
      if (isFatal(e)) throw e;
      const error = describeSiteError(e);
      await data.write((w) => w.decks.update(deck.id, { error }));
      failed.push({ id: deck.id, name: deck.name, error });
      if (++consecutiveFailures >= MAX_CONSECUTIVE_DECK_FAILURES) {
        throw new Error(`${MAX_CONSECUTIVE_DECK_FAILURES} decks in a row couldn't be read (last: ${error}).`);
      }
    }
  }
  await progress({ phase: 'decks', done: stale.length, total: stale.length });

  const finishedAt = Date.now();
  await data.write((w) => w.meta.put('decks', { lastSuccessAt: finishedAt, initialSyncAt: meta.initialSyncAt ?? finishedAt } satisfies DecksMeta));
  return { total: rows.length - gone, added, changed, removed: removed.length + gone, fetched, failed };
}

/** Clears the "New" flag of every deck of the account (or of the given ones). */
export async function markDecksSeen(data: AccountData, ids?: string[]): Promise<void> {
  const rows = ids ? await data.decks.bulkGet(ids) : (await data.decks.list()).filter((d) => d.isNew);
  if (!rows.length) return;
  await data.write((w) => w.decks.putMany(rows.map((d) => ({ ...d, isNew: false }))));
}

export async function getDecksMeta(data: AccountData): Promise<DecksMeta> {
  return (await data.meta.get('decks')) ?? {};
}
