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
  | { kind: 'collection'; pageNumber: number; pageSize: number }
  /** One page of one binder's cards (the site's own binder search; `publicId` as in the binder's URL). */
  | { kind: 'binderPage'; publicId: string; pageNumber: number; pageSize: number }
  | { kind: 'binders' }
  /** A write. Every write goes through this one kind, so the change log sees all of them (see SiteClient.mutate). */
  | { kind: 'mutate'; op: SiteMutation };

/** What a CSV import says it did (Moxfield: `{ isSuccessful, totalImportedCount, errors }`). */
export interface ImportAnswer {
  ok: boolean;
  count: number;
  /** The site's row errors, as text. */
  errors: string[];
}

/** A binder of a collection site (Moxfield: a "trade binder", a label on collection entries). */
export interface SiteBinder {
  id: string;
  /** Id used in the binder's URL (may equal `id`). */
  publicId: string;
  name: string;
  visibility: string;
}

export type BinderVisibility = 'private' | 'unlisted' | 'public';

/**
 * Writes Tithies can make on a site. Site-tagged: each site validates its own in the page (the
 * page world isn't trusted) and describes it for the change log (SiteProvider.describeMutation).
 */
export type SiteMutation =
  | { site: 'moxfield'; op: 'createBinder'; name: string; visibility: BinderVisibility }
  /** Removes collection entries (binder cards are collection entries). */
  | { site: 'moxfield'; op: 'bulkRemove'; entryIds: string[] }
  /** Deletes the whole collection. */
  | { site: 'moxfield'; op: 'deleteCollection' }
  /** Moxfield's own CSV import ("moxfield" format), into a binder when `binderId` is given. */
  | { site: 'moxfield'; op: 'importCsv'; csv: string; binderId?: string };

/** A write as it is sent, for the change log (never any auth header). */
export interface DescribedRequest {
  method: string;
  url: string;
  /** JSON (pretty), the CSV file, or '' when there is no body. */
  body: string;
}

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
  /** Writes: the start of the site's answer, for the change log. */
  response?: string;
}

export type SiteSuccess = (
  | { ok: true; kind: 'deckList'; decks: DeckSummary[] }
  | { ok: true; kind: 'deck'; lastUpdatedAt: string; cards: DeckCard[] }
  /** `totalCopies`: copies in what is searched (every page), when the site says. */
  | { ok: true; kind: 'collection'; entries: CollectionEntry[]; totalResults: number; totalPages: number; pageSize: number; totalCopies?: number }
  | { ok: true; kind: 'binderPage'; entries: CollectionEntry[]; totalResults: number; totalPages: number; pageSize: number; totalCopies?: number }
  | { ok: true; kind: 'binders'; binders: SiteBinder[] }
  /** `response`: the start of the answer (change log); `binder`: what a createBinder made; `imported`: what an import says it did. */
  | { ok: true; kind: 'mutate'; status: number; response: string; binder?: SiteBinder; imported?: ImportAnswer }
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
