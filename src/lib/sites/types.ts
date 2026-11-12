/**
 * What the extension asks a collection site (Moxfield, later others) and how the site's page
 * answers. Requests are made by a logged-in tab of the site itself (see each site's hook content
 * script), so session tokens never leave the page; only trimmed, site-neutral data comes back.
 */
import type { CollectionEntry } from '@/lib/cards/types';
import type { DeckCard, DeckSummary } from '@/lib/decks/types';

/** Every collection site Tithies supports. */
export type SiteType = 'moxfield';

/** Who a site session belongs to. `userId` is the site's immutable id; `userName` is for display. */
export interface SiteIdentity {
  userId: string;
  userName: string;
}

export type SiteRequest =
  | { kind: 'deckList' }
  | { kind: 'deck'; publicId: string }
  | { kind: 'collection'; pageNumber: number; pageSize: number };

/** wrong_account: the session belongs to another user than the one asked for (nothing was requested). */
export type SiteErrorCode = 'no_auth' | 'http' | 'network' | 'parse' | 'timeout' | 'no_tab' | 'tab_lost' | 'bad_request' | 'wrong_account';

export interface SiteFailure {
  ok: false;
  /** HTTP status (0 when no response). */
  status: number;
  code: SiteErrorCode;
  message: string;
  /** The session the request was made as (or would have been): null when unknown, absent from older content scripts. */
  as?: SiteIdentity | null;
}

export type SiteSuccess = (
  | { ok: true; kind: 'deckList'; decks: DeckSummary[] }
  | { ok: true; kind: 'deck'; lastUpdatedAt: string; cards: DeckCard[] }
  | { ok: true; kind: 'collection'; entries: CollectionEntry[]; totalResults: number; totalPages: number; pageSize: number }
) & {
  /** The session the request was made as (see SiteFailure.as). */
  as?: SiteIdentity | null;
};

/** Results are returned, never thrown: status codes don't survive a thrown error across the messaging layers. */
export type SiteResult = SiteSuccess | SiteFailure;

/** What a site tab can do right now. */
export interface SiteTabStatus {
  /** The page has made an authenticated API request, so Tithies can make its own. */
  hasAuth: boolean;
  /** Who that session belongs to (null when unknown; absent from older content scripts). */
  identity?: SiteIdentity | null;
  authAt?: number;
  path: string;
}

/** One request for a site tab. With `expect` (a userId), the page refuses to send it as anyone else. */
export interface SiteApiCall {
  req: SiteRequest;
  expect?: string;
}

export const sameIdentity = (a: SiteIdentity | null | undefined, b: SiteIdentity | null | undefined): boolean =>
  !!a && !!b && a.userId === b.userId;

export const siteFail = (status: number, code: SiteErrorCode, message: string, as?: SiteIdentity | null): SiteFailure =>
  as === undefined ? { ok: false, status, code, message } : { ok: false, status, code, message, as };
