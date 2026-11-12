import { storage } from '#imports';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { ACCOUNT_STORAGE_PREFIXES } from '@/lib/accounts/storage-keys';

/** Every field falls back to its default on its own, so one bad stored value never resets the rest. */
export const mismatchConfigSchema = z.object({
  /** Mode A: deck copies the collection doesn't have. */
  showMissing: z.boolean().default(true).catch(true),
  /** Mode B: collection copies no (included) deck uses. */
  showUnassigned: z.boolean().default(false).catch(false),
  /** Leave proxy copies out on both sides. */
  ignoreProxies: z.boolean().default(true).catch(true),
  /** Deck boards left out (a board type never seen before counts by default). */
  ignoredBoards: z.array(z.string()).default(['maybeboard']).catch(['maybeboard']),
  /** Decks left out. Stored as exclusions so newly detected decks are included by default. */
  excludedDeckIds: z.array(z.string()).default([]).catch([]),
});

export type MismatchConfig = z.infer<typeof mismatchConfigSchema>;

export const DEFAULT_MISMATCH_CONFIG: MismatchConfig = mismatchConfigSchema.parse({});

export const parseMismatchConfig = (raw: unknown): MismatchConfig =>
  mismatchConfigSchema.parse(raw && typeof raw === 'object' ? raw : {});

/** Extension-storage key of one account's Mismatches options. */
export const mismatchConfigKey = (accountKey: string) => `${ACCOUNT_STORAGE_PREFIXES.deckMismatchConfig}${accountKey}` as const;

/** One account's saved options; every `update` is saved at once. `config` is null while loading (or without account). */
export function useMismatchConfig(accountKey: string | null) {
  const [config, setConfig] = useState<MismatchConfig | null>(null);
  const latest = useRef<MismatchConfig | null>(null);

  useEffect(() => {
    latest.current = null;
    setConfig(null);
    if (!accountKey) return;
    const key = mismatchConfigKey(accountKey);
    let alive = true;
    void storage.getItem<MismatchConfig>(key).then((v) => {
      if (!alive) return;
      latest.current = parseMismatchConfig(v);
      setConfig(latest.current);
    });
    const unwatch = storage.watch<MismatchConfig>(key, (v) => {
      latest.current = parseMismatchConfig(v);
      setConfig(latest.current);
    });
    return () => {
      alive = false;
      unwatch();
    };
  }, [accountKey]);

  const update = useCallback(
    (patch: Partial<MismatchConfig>) => {
      if (!accountKey) return;
      const next = parseMismatchConfig({ ...(latest.current ?? DEFAULT_MISMATCH_CONFIG), ...patch });
      latest.current = next;
      setConfig(next);
      void storage.setItem(mismatchConfigKey(accountKey), next);
    },
    [accountKey],
  );

  return { config, update };
}
