import { storage } from '#imports';
import { browser } from 'wxt/browser';
import { ACCOUNT_STORAGE_PREFIXES } from './storage-keys';

const LEGACY_PREFIX = ACCOUNT_STORAGE_PREFIXES.legacyDeckMismatchConfig.slice('local:'.length);
const NEW_PREFIX = ACCOUNT_STORAGE_PREFIXES.collectionComparison.slice('local:'.length);

/**
 * Extension-storage moves between versions (the IndexedDB part is in src/lib/db.ts).
 * Idempotent: run at every worker start.
 */
export async function migrateStorage(): Promise<void> {
  // Before accounts, the Mismatches options were one global item; they are per account now.
  await storage.removeItem('local:deckMismatchConfig');
  // Mismatches → Comparator: each account's options become the current inputs (no preset yet).
  const all = await browser.storage.local.get(null);
  for (const [key, value] of Object.entries(all)) {
    if (!key.startsWith(LEGACY_PREFIX)) continue;
    const accountKey = key.slice(LEGACY_PREFIX.length);
    const next = `${NEW_PREFIX}${accountKey}`;
    if (!(next in all)) await browser.storage.local.set({ [next]: { current: value, presets: [], loadedPresetId: null } });
    await browser.storage.local.remove(key);
  }
}
