/** Dashboard-side access to the Moxfield deck cache and the background sync job. */
import { liveQuery } from 'dexie';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import { db, getMeta } from '@/lib/db';
import { sendMessage } from '@/lib/messaging';
import type { MoxEntry } from '@/lib/moxfield/normalize';
import { META_COLLECTION, META_DECKS, META_SYNC, type CollectionMeta, type DeckCardsRow, type DeckRow, type DecksMeta, type MoxSyncState } from './types';

/** Starts (or joins) the background sync. `collection` also re-reads the whole collection afterwards. */
export const startMoxfieldSync = (collection: boolean) => sendMessage('startMoxfieldSync', { collection });
export const cancelMoxfieldSync = () => sendMessage('cancelMoxfieldSync', undefined);

/** Resolves with the final state once job `jobId` has stopped running. */
export function waitForMoxSync(jobId: string): Promise<MoxSyncState> {
  return new Promise((resolve, reject) => {
    const sub = liveQuery(() => getMeta<MoxSyncState>(META_SYNC)).subscribe({
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
export const useMoxSync = () => useLiveQuery(async () => (await getMeta<MoxSyncState>(META_SYNC)) ?? null, []);
export const useCollectionMeta = () => useLiveQuery(async () => (await getMeta<CollectionMeta>(META_COLLECTION)) ?? null, []);

/**
 * Deck cards and the collection snapshot are big, so they are loaded once and again only when
 * `version` changes (e.g. when a sync job finishes), not on every per-deck write during a sync.
 */
export function useDeckData(version: string): { deckCards: DeckCardsRow[]; collection: MoxEntry[]; loaded: boolean } {
  const [state, setState] = useState<{ deckCards: DeckCardsRow[]; collection: MoxEntry[]; version: string | null }>({ deckCards: [], collection: [], version: null });
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
