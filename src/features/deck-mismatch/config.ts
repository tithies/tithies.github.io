import { storage } from '#imports';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

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

export const mismatchConfigItem = storage.defineItem<MismatchConfig>('local:deckMismatchConfig', { fallback: DEFAULT_MISMATCH_CONFIG });

/** The saved config; every `update` is saved at once. `config` is null while loading. */
export function useMismatchConfig() {
  const [config, setConfig] = useState<MismatchConfig | null>(null);
  const latest = useRef<MismatchConfig | null>(null);

  useEffect(() => {
    let alive = true;
    void mismatchConfigItem.getValue().then((v) => {
      if (!alive) return;
      latest.current = parseMismatchConfig(v);
      setConfig(latest.current);
    });
    const unwatch = mismatchConfigItem.watch((v) => {
      latest.current = parseMismatchConfig(v);
      setConfig(latest.current);
    });
    return () => {
      alive = false;
      unwatch();
    };
  }, []);

  const update = useCallback((patch: Partial<MismatchConfig>) => {
    const next = parseMismatchConfig({ ...(latest.current ?? DEFAULT_MISMATCH_CONFIG), ...patch });
    latest.current = next;
    setConfig(next);
    void mismatchConfigItem.setValue(next);
  }, []);

  return { config, update };
}
