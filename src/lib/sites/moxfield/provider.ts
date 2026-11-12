import type { SiteProvider } from '@/lib/sites/provider';
import { MAX_COLLECTION_PAGE_SIZE, MOX_PACING, MOX_SITE_URL, MOX_SYNC_TAB_URL, MOX_TAB_PATTERNS } from './constants';
import { BOARDS, boardLabel, boardOrder, DECK_CARDS_VERSION } from './decks';

export const moxfieldSite: SiteProvider = {
  type: 'moxfield',
  label: 'Moxfield',
  homeUrl: MOX_SITE_URL,
  collectionUrl: `${MOX_SITE_URL}/collection`,
  tabPatterns: MOX_TAB_PATTERNS,
  syncTabUrl: MOX_SYNC_TAB_URL,
  capabilities: { decks: true, collection: true, collectionCapture: true },
  boards: BOARDS,
  boardLabel,
  boardOrder,
  deckCardsVersion: DECK_CARDS_VERSION,
  maxCollectionPageSize: MAX_COLLECTION_PAGE_SIZE,
  pacing: MOX_PACING,
};
