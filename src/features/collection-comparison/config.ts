import { useCallback } from 'react';
import { z } from 'zod';
import { ACCOUNT_STORAGE_PREFIXES } from '@/lib/accounts/storage-keys';
import { useStoredOptions } from '@/lib/ui/useStoredOptions';

/** Every field falls back to its default on its own, so one bad stored value never resets the rest. */
export const comparisonConfigSchema = z.object({
  /** Mode A: deck copies the collection doesn't have. */
  showMissing: z.boolean().default(true).catch(true),
  /** Mode B: collection copies no (included) deck uses. */
  showUnassigned: z.boolean().default(false).catch(false),
  /** Prints with as many copies in decks as in the collection. */
  showMatched: z.boolean().default(false).catch(false),
  /** Deck boards left out (a board type never seen before counts by default). */
  ignoredBoards: z.array(z.string()).default(['maybeboard']).catch(['maybeboard']),
  /** Decks left out. Stored as exclusions so newly detected decks are included by default. */
  excludedDeckIds: z.array(z.string()).default([]).catch([]),
});

export type ComparisonConfig = z.infer<typeof comparisonConfigSchema>;

export const DEFAULT_COMPARISON_CONFIG: ComparisonConfig = comparisonConfigSchema.parse({});

export const parseComparisonConfig = (raw: unknown): ComparisonConfig =>
  comparisonConfigSchema.parse(raw && typeof raw === 'object' ? raw : {});

/** One account's Comparator state: the options as they are now (saved on every change, so a reload keeps them). */
export interface ComparisonState {
  current: ComparisonConfig;
}

/** A bad stored `current` falls back to the defaults field by field; anything else stored (old presets) is ignored. */
export function parseComparisonState(raw: unknown): ComparisonState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { current: parseComparisonConfig(r.current) };
}

export const DEFAULT_COMPARISON_STATE: ComparisonState = parseComparisonState({});

/** Extension-storage key of one account's Comparator state. */
export const comparisonConfigKey = (accountKey: string) => `${ACCOUNT_STORAGE_PREFIXES.collectionComparison}${accountKey}` as const;

/** One account's options; every change is saved at once. `config` is null while loading (or without account). */
export function useComparisonConfig(accountKey: string | null) {
  const { state, save } = useStoredOptions(accountKey ? comparisonConfigKey(accountKey) : null, parseComparisonState);

  /** Changes some options of the newest state, and saves it. */
  const update = useCallback(
    (patch: Partial<ComparisonConfig>) => save((s) => ({ current: parseComparisonConfig({ ...s.current, ...patch }) })),
    [save],
  );

  return { config: state?.current ?? null, update };
}
