import { storage } from '#imports';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A page's options kept in extension storage under `key` (null: none, e.g. no account yet),
 * followed live (another dashboard tab's change shows here too) and saved on every change.
 * `parse` repairs whatever is stored (and gives the defaults for nothing). `state` is null while
 * loading, or without a key.
 */
export function useStoredOptions<S>(key: `local:${string}` | null, parse: (raw: unknown) => S) {
  const [state, setState] = useState<S | null>(null);
  const latest = useRef<S | null>(null);
  const parseRef = useRef(parse);
  parseRef.current = parse;

  useEffect(() => {
    latest.current = null;
    setState(null);
    if (!key) return;
    let alive = true;
    const apply = (v: unknown) => {
      latest.current = parseRef.current(v);
      setState(latest.current);
    };
    void storage.getItem(key).then((v) => alive && apply(v));
    const unwatch = storage.watch(key, apply);
    return () => {
      alive = false;
      unwatch();
    };
  }, [key]);

  /** Builds the next state from the newest one, and saves it. */
  const save = useCallback(
    (next: (prev: S) => S) => {
      if (!key) return;
      const s = next(latest.current ?? parseRef.current(undefined));
      latest.current = s;
      setState(s);
      void storage.setItem(key, s);
    },
    [key],
  );

  return { state, save };
}
