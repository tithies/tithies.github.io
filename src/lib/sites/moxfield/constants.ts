/**
 * Moxfield facts shared by the background, the dashboard and the content scripts. Pure constants:
 * no asset or extension-API imports, so anything (even the MAIN-world page hook) can import it.
 */

export const MOX_API_ORIGIN = 'https://api2.moxfield.com';
export const MOX_API_HOST = 'api2.moxfield.com';
export const MOX_SITE_URL = 'https://moxfield.com';
export const MOX_TAB_PATTERNS = ['https://moxfield.com/*', 'https://www.moxfield.com/*'];
/** Page Tithies opens when it needs a Moxfield tab (any logged-in page works). */
export const MOX_SYNC_TAB_URL = 'https://moxfield.com/decks/personal';
/**
 * Collection page size Tithies asks for. Moxfield accepted 5000 (2026-11-09) but answers 100 rows
 * per page since (2026-11-16); readers page with whatever size the answer says it used.
 */
export const MAX_COLLECTION_PAGE_SIZE = 5000;

/**
 * Polite pace for Moxfield: one request at a time, a minimum gap plus random jitter.
 * Moxfield sends no Retry-After, and its own UI says to wait about 30 s after a 429.
 */
export const MOX_PACING = {
  intervalMs: 1000,
  jitterMs: 500,
  rateLimitWaitsMs: [30_000, 60_000, 120_000],
  errorWaitsMs: [5_000, 15_000],
  maxIntervalMs: 4000,
};
