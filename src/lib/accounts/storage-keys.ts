/**
 * Extension-storage items that belong to one account (forgetting the account removes them).
 * Pure: safe to import from the background worker.
 */
export const ACCOUNT_STORAGE_PREFIXES = {
  /** Comparator: its options. */
  collectionComparison: 'local:collectionComparison:',
  /** The Mismatches options, from before the Comparator (moved by migrateStorage); still removed by Forget in case one is left. */
  legacyDeckMismatchConfig: 'local:deckMismatchConfig:',
} as const;

export const accountStorageKeys = (accountKey: string): `local:${string}`[] =>
  Object.values(ACCOUNT_STORAGE_PREFIXES).map((prefix) => `${prefix}${accountKey}` as `local:${string}`);
