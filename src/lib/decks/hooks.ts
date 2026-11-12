/** Dashboard-side access to an account's deck cache and the background sync job. */
import { liveQuery } from 'dexie';
import { useEffect, useState } from 'react';
import { accountData } from '@/lib/accounts/data';
import { useAccountLive } from '@/lib/accounts/hooks';
import type { AccountKey } from '@/lib/accounts/types';
import type { CollectionEntry } from '@/lib/cards/types';
import { sendMessage } from '@/lib/messaging';
import type { SiteType } from '@/lib/sites/types';
import type { CollectionMeta, DeckCardsRow, DeckRow, DecksMeta, SyncState } from './types';

/**
 * Starts (or joins) the background sync of an account. `collection` also re-reads the whole
 * collection afterwards. With no account (`null`), syncs whoever is logged in on the site and
 * adds that account. Answers once a tab of the account is found.
 */
export const startSync = (type: SiteType, accountKey: AccountKey | null, collection: boolean) => sendMessage('startAccountSync', { type, accountKey, collection });
export const cancelSync = (type: SiteType) => sendMessage('cancelAccountSync', { type });

/** Resolves with the final state once job `jobId` of the account has stopped running. */
export function waitForSync(key: AccountKey, jobId: string): Promise<SyncState> {
  return new Promise((resolve, reject) => {
    const sub = liveQuery(() => accountData(key).meta.get('sync')).subscribe({
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
export const useDecks = (key: AccountKey | null) => useAccountLive(key, (d) => d.decks.list());
export const useDecksMeta = (key: AccountKey | null) => useAccountLive<DecksMeta>(key, async (d) => (await d.meta.get('decks')) ?? {});
export const useSyncState = (key: AccountKey | null) => useAccountLive<SyncState | null>(key, async (d) => (await d.meta.get('sync')) ?? null);
export const useCollectionMeta = (key: AccountKey | null) => useAccountLive<CollectionMeta | null>(key, async (d) => (await d.meta.get('collection')) ?? null);

/**
 * Deck cards and the collection snapshot are big, so they are loaded once and again only when
 * `version` changes (e.g. when a sync job finishes), not on every per-deck write during a sync.
 */
export function useDeckData(key: AccountKey | null, version: string): { deckCards: DeckCardsRow[]; collection: CollectionEntry[]; loaded: boolean } {
  const [state, setState] = useState<{ deckCards: DeckCardsRow[]; collection: CollectionEntry[]; key: AccountKey | null; version: string | null }>({
    deckCards: [],
    collection: [],
    key: null,
    version: null,
  });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const data = accountData(key);
    void Promise.all([data.deckCards.list(), data.collection.list()]).then(([deckCards, collection]) => {
      if (alive) setState({ deckCards, collection, key, version });
    });
    return () => {
      alive = false;
    };
  }, [key, version]);
  // Never another account's data. Not "loaded" while reloading: mixing the new decks with the old
  // collection would show wrong numbers (the previous data stays meanwhile).
  const mine = state.key === key;
  return { deckCards: mine ? state.deckCards : [], collection: mine ? state.collection : [], loaded: mine && state.version === version };
}

export type { DeckRow };
