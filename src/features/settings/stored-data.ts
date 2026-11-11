/**
 * Everything Tithies keeps in the browser, for the Settings page:
 * - IndexedDB ("tithies", see src/lib/db.ts): caches, synced Moxfield data and the Selling runs.
 *   `clearStoredData` empties any of these groups.
 * - Extension storage (chrome.storage.local) and the dashboard's localStorage: settings and
 *   preferences only. `resetAllSettings` empties both, so every setting falls back to its default.
 */
import { browser } from 'wxt/browser';
import { db } from '@/lib/db';
import { META_COLLECTION, META_DECKS, META_SYNC } from '@/lib/decks/types';
import { sendMessage } from '@/lib/messaging';
import { clearCaches } from '@/features/f2f-buylist/runner';

/** The groups of IndexedDB data the user can clear. */
export type DataGroup = 'f2fCache' | 'moxDecks' | 'moxCollection' | 'runs';
export const DATA_GROUPS: DataGroup[] = ['f2fCache', 'moxDecks', 'moxCollection', 'runs'];

/**
 * Empties the chosen groups. Active Selling runs are cancelled first (as when deleting one run),
 * so the background worker stops working on them.
 */
export async function clearStoredData(groups: Iterable<DataGroup>): Promise<void> {
  const g = new Set(groups);
  if (g.has('runs')) {
    const active = (await db.runs.where('status').anyOf('running', 'queued').primaryKeys()) as number[];
    for (const runId of active) await sendMessage('controlRun', { runId, action: 'cancel' }).catch(() => undefined);
  }
  if (g.has('f2fCache')) await clearCaches();
  await db.transaction('rw', [db.decks, db.deckCards, db.moxCollection, db.meta, db.runs, db.items], async () => {
    if (g.has('moxDecks')) {
      await db.decks.clear();
      await db.deckCards.clear();
      await db.meta.bulkDelete([META_DECKS, META_SYNC]);
    }
    if (g.has('moxCollection')) {
      await db.moxCollection.clear();
      await db.meta.delete(META_COLLECTION);
    }
    if (g.has('runs')) {
      await db.items.clear();
      await db.runs.clear();
    }
  });
}

/** What each known preference key holds, for the "Reset all settings" list. */
export const PREFERENCE_LABELS: Record<string, string> = {
  // extension storage (chrome.storage.local)
  settings: 'Selling settings',
  f2fHiddenColumns: 'Columns hidden in run tables',
  deckMismatchConfig: 'Mismatches page options: decks and folders left out, boards, proxies, what to show',
  overlayCollapsed: 'Moxfield panel minimised or not',
  updateCheck: 'Update check: last check and dismissed update banners',
  // dashboard localStorage
  'tithies:f2f:pageSize': 'Rows per page in run tables',
  'tithies:decks:pageSize': 'Rows per page in the mismatch table',
  'mantine-color-scheme-value': 'Theme (dark, light or system)',
};

export interface StoredPreference {
  key: string;
  label: string;
  where: 'extension' | 'local';
}

/** Preferences that currently hold a saved value (the others are at their default). */
export async function listStoredPreferences(): Promise<StoredPreference[]> {
  const ext = Object.keys(await browser.storage.local.get(null));
  const local = typeof localStorage === 'undefined' ? [] : Object.keys(localStorage);
  const row = (key: string, where: StoredPreference['where']): StoredPreference => ({ key, where, label: PREFERENCE_LABELS[key] ?? key });
  return [...ext.map((k) => row(k, 'extension')), ...local.map((k) => row(k, 'local'))];
}

/**
 * Every setting back to its default: empties the extension storage and the dashboard's
 * localStorage. Both hold only Tithies settings and preferences (no data), and every reader has a
 * fallback, so nothing else is needed. Open pages pick the defaults up through their watchers.
 */
export async function resetAllSettings(): Promise<void> {
  await browser.storage.local.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
}
