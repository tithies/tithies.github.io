import { storage } from '#imports';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ACCOUNT_STORAGE_PREFIXES } from '@/lib/accounts/storage-keys';

/** Every field falls back to its default on its own, so one bad stored value never resets the rest. */
export const comparisonConfigSchema = z.object({
  /** Mode A: deck copies the collection doesn't have. */
  showMissing: z.boolean().default(true).catch(true),
  /** Mode B: collection copies no (included) deck uses. */
  showUnassigned: z.boolean().default(false).catch(false),
  /** Prints with as many copies in decks as in the collection. */
  showMatched: z.boolean().default(false).catch(false),
  /** Leave proxy copies out on both sides. */
  ignoreProxies: z.boolean().default(true).catch(true),
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
  const [state, setState] = useState<ComparisonState | null>(null);
  const latest = useRef<ComparisonState | null>(null);

  useEffect(() => {
    latest.current = null;
    setState(null);
    if (!accountKey) return;
    const key = comparisonConfigKey(accountKey);
    let alive = true;
    void storage.getItem<ComparisonState>(key).then((v) => {
      if (!alive) return;
      latest.current = parseComparisonState(v);
      setState(latest.current);
    });
    const unwatch = storage.watch<ComparisonState>(key, (v) => {
      latest.current = parseComparisonState(v);
      setState(latest.current);
    });
    return () => {
      alive = false;
      unwatch();
    };
  }, [accountKey]);

  /** Changes some options of the newest state, and saves it. */
  const update = useCallback(
    (patch: Partial<ComparisonConfig>) => {
      if (!accountKey) return;
      const s = latest.current ?? DEFAULT_COMPARISON_STATE;
      const next: ComparisonState = { current: parseComparisonConfig({ ...s.current, ...patch }) };
      latest.current = next;
      setState(next);
      void storage.setItem(comparisonConfigKey(accountKey), next);
    },
    [accountKey],
  );

  return { config: state?.current ?? null, update };
}
