/**
 * Extension-storage items that belong to one account (forgetting the account removes them).
 * Pure: safe to import from the background worker.
 */
export const ACCOUNT_STORAGE_PREFIXES = {
  deckMismatchConfig: 'local:deckMismatchConfig:',
} as const;

export const accountStorageKeys = (accountKey: string): `local:${string}`[] =>
  Object.values(ACCOUNT_STORAGE_PREFIXES).map((prefix) => `${prefix}${accountKey}` as `local:${string}`);
