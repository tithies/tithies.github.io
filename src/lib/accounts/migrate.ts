import { storage } from '#imports';

/**
 * Extension-storage cleanup for the move to per-account data (the IndexedDB part is the v3
 * upgrade in src/lib/db.ts). Idempotent: run at every worker start.
 */
export async function migrateStorage(): Promise<void> {
  // Before accounts, the Mismatches options were one global item; they are per account now.
  await storage.removeItem('local:deckMismatchConfig');
}
