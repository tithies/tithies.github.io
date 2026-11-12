/** Dashboard-side access to the deck cache and the background sync job. */
import { liveQuery } from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db, getMeta } from '@/lib/db';
import { sendMessage } from '@/lib/messaging';
import type { SiteType } from '@/lib/sites/types';
import type { CollectionEntry } from '@/lib/cards/types';
import { META_COLLECTION, META_DECKS, META_SYNC, type CollectionMeta, type DeckCardsRow, type DeckRow, type DecksMeta, type SyncState } from './types';

/** Starts (or joins) the background sync of a site. `collection` also re-reads the whole collection afterwards. */
export const startSync = (type: SiteType, collection: boolean) => sendMessage('startAccountSync', { type, collection });
export const cancelSync = (type: SiteType) => sendMessage('cancelAccountSync', { type });

/** Resolves with the final state once job `jobId` has stopped running. */
export function waitForSync(jobId: string): Promise<SyncState> {
  return new Promise((resolve, reject) => {
    const sub = liveQuery(() => getMeta<SyncState>(META_SYNC)).subscribe({
      next: (s) => {
        if (s && (s.jobId !== jobId || s.status !== 'running')) {
          sub.unsubscribe();
          resolve(s);
        }
      },
      error: (e) => reject(e),
    });
  });
}

/** Light deck rows (no cards). undefined while loading. */
export const useDecks = () => useLiveQuery(() => db.decks.toArray(), []);
export const useDecksMeta = () => useLiveQuery(async () => (await getMeta<DecksMeta>(META_DECKS)) ?? {}, []);
export const useSyncState = () => useLiveQuery(async () => (await getMeta<SyncState>(META_SYNC)) ?? null, []);
export const useCollectionMeta = () => useLiveQuery(async () => (await getMeta<CollectionMeta>(META_COLLECTION)) ?? null, []);

/**
 * Deck cards and the collection snapshot are big, so they are loaded once and again only when
 * `version` changes (e.g. when a sync job finishes), not on every per-deck write during a sync.
 */
export function useDeckData(version: string): { deckCards: DeckCardsRow[]; collection: CollectionEntry[]; loaded: boolean } {
  const [state, setState] = useState<{ deckCards: DeckCardsRow[]; collection: CollectionEntry[]; version: string | null }>({ deckCards: [], collection: [], version: null });
  useEffect(() => {
    let alive = true;
    void Promise.all([db.deckCards.toArray(), db.moxCollection.toArray()]).then(([deckCards, collection]) => {
      if (alive) setState({ deckCards, collection, version });
    });
    return () => {
      alive = false;
    };
  }, [version]);
  // Not "loaded" while reloading: mixing the new decks with the old collection would show wrong numbers.
  return { deckCards: state.deckCards, collection: state.collection, loaded: state.version === version };
}

export type { DeckRow };
