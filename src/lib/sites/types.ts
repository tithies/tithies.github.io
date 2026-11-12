/**
 * What the extension asks a collection site (Moxfield, later others) and how the site's page
 * answers. Requests are made by a logged-in tab of the site itself (see each site's hook content
 * script), so session tokens never leave the page; only trimmed, site-neutral data comes back.
 */
import type { CollectionEntry } from '@/lib/cards/types';
import type { DeckCard, DeckSummary } from '@/lib/decks/types';

/** Every collection site Tithies supports. */
export type SiteType = 'moxfield';

export type SiteRequest =
  | { kind: 'deckList' }
  | { kind: 'deck'; publicId: string }
  | { kind: 'collection'; pageNumber: number; pageSize: number };

export type SiteErrorCode = 'no_auth' | 'http' | 'network' | 'parse' | 'timeout' | 'no_tab' | 'tab_lost' | 'bad_request';

export interface SiteFailure {
  ok: false;
  /** HTTP status (0 when no response). */
  status: number;
  code: SiteErrorCode;
  message: string;
}

export type SiteSuccess =
  | { ok: true; kind: 'deckList'; decks: DeckSummary[] }
  | { ok: true; kind: 'deck'; lastUpdatedAt: string; cards: DeckCard[] }
  | { ok: true; kind: 'collection'; entries: CollectionEntry[]; totalResults: number; totalPages: number; pageSize: number };

/** Results are returned, never thrown: status codes don't survive a thrown error across the messaging layers. */
export type SiteResult = SiteSuccess | SiteFailure;

/** What a site tab can do right now. */
export interface SiteTabStatus {
  /** The page has made an authenticated API request, so Tithies can make its own. */
  hasAuth: boolean;
  authAt?: number;
  path: string;
}

export const siteFail = (status: number, code: SiteErrorCode, message: string): SiteFailure => ({ ok: false, status, code, message });
