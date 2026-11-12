import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS, getSettings, saveSettings, settingsItem, settingsSchema, type Settings } from '@/lib/settings';

/** Wait after the last keystroke before saving. */
const SAVE_DELAY_MS = 400;

/**
 * A Settings section's form. There is no Save button: each change is saved once it's valid.
 * Only the keys this section changed are written (merged into what is stored), so two sections
 * edited at the same time never overwrite each other. Outside changes ("Reset all settings",
 * another page) reload the form through the storage watcher.
 */
export function useSettingsForm(fieldLabels: Partial<Record<keyof Settings, string>>) {
  const [s, setS] = useState<Settings | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  /** JSON of the last value written here, to tell our own writes from outside changes. */
  const lastSaved = useRef('');
  const pending = useRef<{ patch: Partial<Settings>; timer: ReturnType<typeof setTimeout> } | null>(null);
  const current = useRef<Settings | null>(null);
  current.current = s;

  const persist = async (patch: Partial<Settings>) => {
    const parsed = settingsSchema.safeParse({ ...(current.current ?? DEFAULT_SETTINGS), ...patch });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = fieldLabels[issue?.path[0] as keyof Settings] ?? 'A value';
      setInvalid(`${field}: ${issue?.message ?? 'invalid value'}`);
      return;
    }
    setInvalid(null);
    const saved = await saveSettings(patch);
    lastSaved.current = JSON.stringify(saved);
  };

  const flush = () => {
    if (!pending.current) return;
    clearTimeout(pending.current.timer);
    const { patch } = pending.current;
    pending.current = null;
    void persist(patch);
  };

  useEffect(() => {
    let alive = true;
    const load = () =>
      void getSettings().then((v) => {
        if (!alive) return;
        lastSaved.current = JSON.stringify(v);
        setS(v);
      });
    load();
    const unwatch = settingsItem.watch((v) => {
      if (JSON.stringify(v) !== lastSaved.current && !pending.current) load();
    });
    return () => {
      alive = false;
      unwatch();
      flush(); // leaving the page right after typing still saves
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => {
    setS((prev) => (prev ? { ...prev, [k]: v } : prev));
    const patch = { ...(pending.current?.patch ?? {}), [k]: v };
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = { patch, timer: setTimeout(flush, SAVE_DELAY_MS) };
  };

  /** "Reset to defaults" of a section: only its own keys. */
  const reset = (keys: readonly (keyof Settings)[]) => {
    if (pending.current) clearTimeout(pending.current.timer);
    pending.current = null;
    const patch = Object.fromEntries(keys.map((k) => [k, DEFAULT_SETTINGS[k]])) as Partial<Settings>;
    setS((prev) => (prev ? { ...prev, ...patch } : prev));
    void persist(patch);
  };

  /** A number input's value, or the fallback while it's empty. */
  const num = (v: string | number, fallback: number) => (v === '' || Number.isNaN(Number(v)) ? fallback : Number(v));

  return { s, set, reset, invalid, num };
}
