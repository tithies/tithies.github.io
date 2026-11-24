/**
 * Each card's set (the set it belongs to), rarity and color identity, read from Scryfall while a
 * deck folder target is chosen. Read once per dialog: cards added later read only what's new.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { scryfallCardFacts, scryfallSets, type CardFacts, type ScryfallSet } from '@/lib/cards/scryfall';
import { withGroups } from '../grouping';
import type { ExportItem, ReadProgress } from '../types';

export interface CardFactsState {
  /** The items with their group (null until read). */
  items: ExportItem[] | null;
  loading: boolean;
  progress: ReadProgress | null;
  error: string | null;
  retry: () => void;
}

export function useCardFacts(items: ExportItem[], enabled: boolean): CardFactsState {
  const [read, setRead] = useState<{ facts: Map<string, CardFacts>; sets: Map<string, ScryfallSet> } | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ReadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const known = useRef(new Map<string, CardFacts>());
  /** Ids asked already (those Scryfall doesn't know aren't asked again). */
  const asked = useRef(new Set<string>());
  const sets = useRef<Map<string, ScryfallSet> | null>(null);
  const ids = useMemo(() => [...new Set(items.map((i) => i.scryfallId).filter(Boolean))].sort().join(','), [items]);

  useEffect(() => {
    if (!enabled) return;
    const missing = ids.split(',').filter((id) => id && !asked.current.has(id));
    if (sets.current && !missing.length) return;
    const abort = new AbortController();
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        sets.current ??= new Map((await scryfallSets(undefined, abort.signal)).map((s) => [s.code, s]));
        if (missing.length) {
          const got = await scryfallCardFacts(missing, { signal: abort.signal, onProgress: (done, total) => setProgress({ done, total }) });
          for (const [k, v] of got) known.current.set(k, v);
          for (const id of missing) asked.current.add(id);
        }
        if (!abort.signal.aborted) setRead({ facts: new Map(known.current), sets: sets.current });
      } catch (e) {
        if (!abort.signal.aborted) setError(`Couldn't read the cards' details from Scryfall (${e instanceof Error ? e.message : String(e)}).`);
      } finally {
        if (!abort.signal.aborted) {
          setLoading(false);
          setProgress(null);
        }
      }
    })();
    return () => abort.abort();
  }, [enabled, ids, attempt]);

  const annotated = useMemo(() => (read ? withGroups(items, read.facts, read.sets) : null), [items, read]);
  return { items: annotated, loading, progress, error, retry: () => setAttempt((a) => a + 1) };
}
