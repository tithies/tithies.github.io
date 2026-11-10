import type { DeckCard, DeckSummary } from '@/lib/moxfield/decks';

/** A cached deck (light row: no cards, so live queries over every deck stay cheap). */
export interface DeckRow extends DeckSummary {
  firstSeenAt: number;
  /** Appeared after a previous successful sync and not yet marked as seen. */
  isNew: boolean;
  /** The deck list's `lastUpdatedAt` when the cards were fetched; cards are stale when it differs. */
  cardsUpdatedAt?: string;
  /** DECK_CARDS_VERSION the cards were normalised with. */
  cardsV?: number;
  cardsFetchedAt?: number;
  /** Σ qty over every board. */
  cardCount?: number;
  /** Last fetch error for this deck (cleared on success). */
  error?: string;
}

/** The cards of one deck (heavy row, kept apart from DeckRow). */
export interface DeckCardsRow {
  deckId: string;
  v: number;
  /** Same value as DeckRow.cardsUpdatedAt. */
  updatedAt: string;
  fetchedAt: number;
  cards: DeckCard[];
}

/** meta row 'decks' */
export interface DecksMeta {
  /** Last deck sync that went through to the end. Unset = decks were never synced. */
  lastSuccessAt?: number;
  initialSyncAt?: number;
}

/** meta row 'moxCollection' */
export interface CollectionMeta {
  fetchedAt: number;
  entries: number;
  copies: number;
}

export type MoxSyncStatus = 'running' | 'done' | 'error' | 'cancelled' | 'interrupted';
export type MoxSyncPhase = 'connecting' | 'deckList' | 'decks' | 'collection' | 'done';

export interface DeckSyncSummary {
  /** Decks in the list. */
  total: number;
  added: number;
  changed: number;
  removed: number;
  /** Decks whose cards were (re)fetched. */
  fetched: number;
  failed: { id: string; name: string; error: string }[];
}

/** meta row 'moxSync': state of the latest background Moxfield sync job. */
export interface MoxSyncState {
  jobId: string;
  status: MoxSyncStatus;
  phase: MoxSyncPhase;
  /** Also read the whole collection after the decks. */
  withCollection: boolean;
  done: number;
  total: number;
  /** Deck being fetched. */
  current?: string;
  /** Transient note (rate-limit wait, opening a tab…). */
  message?: string;
  startedAt: number;
  heartbeatAt: number;
  finishedAt?: number;
  error?: string;
  requests: number;
  decks?: DeckSyncSummary;
}

export const META_DECKS = 'decks';
export const META_COLLECTION = 'moxCollection';
export const META_SYNC = 'moxSync';
