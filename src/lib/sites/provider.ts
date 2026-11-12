import type { BoardInfo } from '@/lib/decks/types';
import type { SitePacing } from './client';
import type { SiteType } from './types';

/**
 * Everything the rest of Tithies needs to know about one collection site. Adding a site means
 * a new folder under src/lib/sites/<type>/ with a provider like this one, its page hook and relay
 * content scripts, and an entry in the registry.
 */
export interface SiteProvider {
  type: SiteType;
  /** Display name ("Moxfield"). */
  label: string;
  homeUrl: string;
  /** Where users see their collection (and log in). */
  collectionUrl: string;
  /** Match patterns of the site's tabs (for tabs.query). */
  tabPatterns: string[];
  /** Page Tithies opens when it needs a logged-in tab of its own. */
  syncTabUrl: string;
  capabilities: {
    decks: boolean;
    collection: boolean;
    /** The site's own collection page can start a Selling run from what it shows (the panel). */
    collectionCapture: boolean;
  };
  /** The site's deck boards, in display order. */
  boards: BoardInfo[];
  boardLabel(key: string): string;
  boardOrder(key: string): number;
  /** Bump when the deck normaliser changes, so cached decks are fetched again. */
  deckCardsVersion: number;
  /** Largest collection page the site accepts. */
  maxCollectionPageSize: number;
  /** Default request pace. */
  pacing: SitePacing;
}
