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

/** A named, saved configuration. */
export interface ComparisonPreset {
  id: string;
  name: string;
  config: ComparisonConfig;
  savedAt: number;
}

/**
 * One account's Comparison state: the inputs as they are now (saved on every change,
 * so a reload keeps them), the saved presets, and the preset the inputs were last loaded from or
 * saved to (null: none).
 */
export interface ComparisonState {
  current: ComparisonConfig;
  presets: ComparisonPreset[];
  loadedPresetId: string | null;
}

export const PRESET_NAME_MAX = 60;

const presetSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(PRESET_NAME_MAX),
  config: z.unknown().transform(parseComparisonConfig),
  savedAt: z.number().catch(0),
});

/** Bad presets are dropped one by one; a bad `current` falls back to the defaults field by field. */
export function parseComparisonState(raw: unknown): ComparisonState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const presets: ComparisonPreset[] = [];
  for (const p of Array.isArray(r.presets) ? r.presets : []) {
    const parsed = presetSchema.safeParse(p);
    if (parsed.success && !presets.some((x) => x.id === parsed.data.id)) presets.push(parsed.data);
  }
  const loaded = typeof r.loadedPresetId === 'string' && presets.some((p) => p.id === r.loadedPresetId) ? r.loadedPresetId : null;
  return { current: parseComparisonConfig(r.current), presets, loadedPresetId: loaded };
}

export const DEFAULT_COMPARISON_STATE: ComparisonState = parseComparisonState({});

function sortedEq(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const x = [...a].sort();
  const y = [...b].sort();
  return x.every((v, i) => v === y[i]);
}

/** Same options (list order doesn't matter). */
export function sameConfig(a: ComparisonConfig, b: ComparisonConfig): boolean {
  return (
    a.showMissing === b.showMissing &&
    a.showUnassigned === b.showUnassigned &&
    a.ignoreProxies === b.ignoreProxies &&
    sortedEq(a.ignoredBoards, b.ignoredBoards) &&
    sortedEq(a.excludedDeckIds, b.excludedDeckIds)
  );
}

export const loadedPreset = (s: ComparisonState): ComparisonPreset | null => s.presets.find((p) => p.id === s.loadedPresetId) ?? null;

/** The inputs differ from the preset they were loaded from. */
export function isModified(s: ComparisonState): boolean {
  const p = loadedPreset(s);
  return !!p && !sameConfig(s.current, p.config);
}

/**
 * Switching to a preset would lose the inputs: they were changed since their preset was loaded,
 * or (no preset loaded) they match no preset and aren't the defaults.
 */
export function hasUnsavedOptions(s: ComparisonState): boolean {
  if (loadedPreset(s)) return isModified(s);
  return !sameConfig(s.current, DEFAULT_COMPARISON_CONFIG) && !s.presets.some((p) => sameConfig(p.config, s.current));
}

const normName = (name: string) => name.trim().toLowerCase();

/** Why `name` can't be a new preset's name (null: it can). */
export function presetNameError(s: ComparisonState, name: string, exceptId?: string): string | null {
  const n = name.trim();
  if (!n) return 'Give the preset a name';
  if (n.length > PRESET_NAME_MAX) return `At most ${PRESET_NAME_MAX} characters`;
  if (s.presets.some((p) => p.id !== exceptId && normName(p.name) === normName(n))) return 'A preset already has this name: overwrite it instead';
  return null;
}

export type SaveTarget = { name: string } | { overwriteId: string };

/** Saves the current inputs as a new preset, or over an existing one; that preset becomes the loaded one. */
export function savePreset(s: ComparisonState, to: SaveTarget, now = Date.now(), newId: () => string = () => crypto.randomUUID()): ComparisonState {
  const config = parseComparisonConfig(s.current);
  if ('overwriteId' in to) {
    if (!s.presets.some((p) => p.id === to.overwriteId)) throw new Error('That preset no longer exists');
    return { ...s, presets: s.presets.map((p) => (p.id === to.overwriteId ? { ...p, config, savedAt: now } : p)), loadedPresetId: to.overwriteId };
  }
  const error = presetNameError(s, to.name);
  if (error) throw new Error(error);
  const id = newId();
  return { ...s, presets: [...s.presets, { id, name: to.name.trim(), config, savedAt: now }], loadedPresetId: id };
}

/** The preset's options become the inputs. */
export function loadPresetInto(s: ComparisonState, id: string): ComparisonState {
  const p = s.presets.find((x) => x.id === id);
  return p ? { ...s, current: parseComparisonConfig(p.config), loadedPresetId: id } : s;
}

export function renamePreset(s: ComparisonState, id: string, name: string): ComparisonState {
  const error = presetNameError(s, name, id);
  if (error) throw new Error(error);
  return { ...s, presets: s.presets.map((p) => (p.id === id ? { ...p, name: name.trim() } : p)) };
}

/** Deletes a preset; the inputs stay as they are. */
export function deletePreset(s: ComparisonState, id: string): ComparisonState {
  return { ...s, presets: s.presets.filter((p) => p.id !== id), loadedPresetId: s.loadedPresetId === id ? null : s.loadedPresetId };
}

/** Extension-storage key of one account's Comparison state. */
export const comparisonConfigKey = (accountKey: string) => `${ACCOUNT_STORAGE_PREFIXES.collectionComparison}${accountKey}` as const;

/**
 * One account's saved state; every change is saved at once. `state` is null while loading (or
 * without account). `update` changes the inputs; presets change only through save/rename/remove.
 */
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

  /** Applies `fn` to the newest state and saves the result (fn may throw: nothing is saved then). */
  const change = useCallback(
    (fn: (s: ComparisonState) => ComparisonState) => {
      if (!accountKey) return;
      const next = parseComparisonState(fn(latest.current ?? DEFAULT_COMPARISON_STATE));
      latest.current = next;
      setState(next);
      void storage.setItem(comparisonConfigKey(accountKey), next);
    },
    [accountKey],
  );

  const update = useCallback(
    (patch: Partial<ComparisonConfig>) => change((s) => ({ ...s, current: parseComparisonConfig({ ...s.current, ...patch }) })),
    [change],
  );

  return {
    state,
    config: state?.current ?? null,
    update,
    load: useCallback((id: string) => change((s) => loadPresetInto(s, id)), [change]),
    save: useCallback((to: SaveTarget) => change((s) => savePreset(s, to)), [change]),
    rename: useCallback((id: string, name: string) => change((s) => renamePreset(s, id, name)), [change]),
    remove: useCallback((id: string) => change((s) => deletePreset(s, id)), [change]),
  };
}
