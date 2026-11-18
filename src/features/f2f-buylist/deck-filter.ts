/**
 * The Selling runs' "Cards in decks" filter: its options, one set per account (shared by every run
 * of the account, not with the Comparator). See `in-decks.ts` for what it does.
 */
import { useCallback } from 'react';
import { z } from 'zod';
import { ACCOUNT_STORAGE_PREFIXES } from '@/lib/accounts/storage-keys';
import { useStoredOptions } from '@/lib/ui/useStoredOptions';

/** Every field falls back to its default on its own, so one bad stored value never resets the rest. */
export const sellingDeckFilterSchema = z.object({
  /** Hide the copies the included decks use. */
  enabled: z.boolean().default(false).catch(false),
  /** Deck boards left out (a board type never seen before counts by default). */
  ignoredBoards: z.array(z.string()).default(['maybeboard']).catch(['maybeboard']),
  /** Decks left out. Stored as exclusions so newly detected decks are included by default. */
  excludedDeckIds: z.array(z.string()).default([]).catch([]),
  /** Deck proxies don't use a collection copy (runs never hold proxies). */
  ignoreProxies: z.boolean().default(true).catch(true),
});

export type SellingDeckFilter = z.infer<typeof sellingDeckFilterSchema>;

export const parseSellingDeckFilter = (raw: unknown): SellingDeckFilter => sellingDeckFilterSchema.parse(raw && typeof raw === 'object' ? raw : {});

export const DEFAULT_SELLING_DECK_FILTER: SellingDeckFilter = parseSellingDeckFilter({});

/** Extension-storage key of one account's filter options. */
export const sellingDeckFilterKey = (accountKey: string) => `${ACCOUNT_STORAGE_PREFIXES.sellingDeckFilter}${accountKey}` as const;

/** One account's options; every change is saved at once. `config` is null while loading (or without account). */
export function useSellingDeckFilter(accountKey: string | null) {
  const { state, save } = useStoredOptions(accountKey ? sellingDeckFilterKey(accountKey) : null, parseSellingDeckFilter);
  const update = useCallback((patch: Partial<SellingDeckFilter>) => save((s) => parseSellingDeckFilter({ ...s, ...patch })), [save]);
  return { config: state, update };
}
