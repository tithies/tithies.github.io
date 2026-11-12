/**
 * Everything Tithies keeps in the browser, for the Settings page:
 * - IndexedDB ("tithies", see src/lib/db.ts): the F2F caches (shared), and for each account its
 *   synced decks, collection snapshot and Selling runs. `clearStoredData` empties any of these.
 * - Extension storage (chrome.storage.local) and the dashboard's localStorage: settings and
 *   preferences only. `resetAllSettings` empties both, so every setting falls back to its default.
 */
import type { Table } from 'dexie';
import { browser } from 'wxt/browser';
import { accountData, type AccountDataGroup } from '@/lib/accounts/data';
import type { AccountKey } from '@/lib/accounts/types';
import { db } from '@/lib/db';
import { sendMessage } from '@/lib/messaging';
import { clearCaches } from '@/features/f2f-buylist/runner';

/** The groups of IndexedDB data the user can clear: the shared F2F cache, or one account's data. */
export type DataGroup = 'f2fCache' | AccountDataGroup;
export const ACCOUNT_GROUPS: AccountDataGroup[] = ['decks', 'collection', 'runs'];
export const DATA_GROUPS: DataGroup[] = ['f2fCache', ...ACCOUNT_GROUPS];

const isAccountGroup = (g: DataGroup): g is AccountDataGroup => g !== 'f2fCache';

/**
 * Empties the chosen groups (account groups: of `accountKey`'s data only). Active Selling runs
 * are cancelled first (as when deleting one run), so the background worker stops working on them.
 */
export async function clearStoredData(groups: Iterable<DataGroup>, accountKey: AccountKey | null): Promise<void> {
  const g = new Set(groups);
  const data = accountKey ? accountData(accountKey) : null;
  if (g.has('runs') && data) {
    for (const runId of await data.runs.activeIds()) await sendMessage('controlRun', { runId, action: 'cancel' }).catch(() => undefined);
  }
  if (g.has('f2fCache')) await clearCaches();
  const own = [...g].filter(isAccountGroup);
  if (data && own.length) await data.clear(own);
}

const jsonSize = (v: unknown) => JSON.stringify(v)?.length ?? 0;
async function tableSize(table: Table): Promise<number> {
  let bytes = 0;
  await table.each((row) => {
    bytes += jsonSize(row);
  });
  return bytes;
}

/**
 * What each group's data weighs (its rows as JSON, close to what IndexedDB stores); account
 * groups for `accountKey`. This is what clearing removes. The browser's own figure
 * (navigator.storage.estimate) is the size of the database files: they keep the space of deleted
 * rows until the browser compacts them, later. Reads every row, so call it on demand.
 */
export async function measureStoredData(accountKey: AccountKey | null): Promise<Record<DataGroup, number>> {
  const [lookups, f2fMeta, own] = await Promise.all([
    tableSize(db.f2fCache),
    db.meta.bulkGet(['bulkRates', 'f2fSets']).then((rows) => rows.reduce((sum, r) => sum + (r ? jsonSize(r) : 0), 0)),
    accountKey ? accountData(accountKey).measure() : Promise.resolve({ decks: 0, collection: 0, runs: 0 }),
  ]);
  return { f2fCache: lookups + f2fMeta, ...own };
}

/** What each known preference key holds, for the "Reset all settings" list. */
export const PREFERENCE_LABELS: Record<string, string> = {
  // extension storage (chrome.storage.local)
  settings: 'Selling settings',
  f2fHiddenColumns: 'Columns hidden in run tables',
  overlayCollapsed: 'Moxfield panel minimised or not',
  updateCheck: 'Update check: last check and dismissed update banners',
  // dashboard localStorage
  'tithies:f2f:pageSize': 'Rows per page in run tables',
  'tithies:decks:pageSize': 'Rows per page in the mismatch table',
  'mantine-color-scheme-value': 'Theme (dark, light or system)',
};

/** Labels of per-account preference keys ("deckMismatchConfig:moxfield:123"), by prefix. */
const ACCOUNT_PREFERENCE_PREFIXES: Record<string, string> = {
  'deckMismatchConfig:': 'Mismatches page options of one account: decks and folders left out, boards, proxies, what to show',
};

export function preferenceLabel(key: string): string {
  if (PREFERENCE_LABELS[key]) return PREFERENCE_LABELS[key];
  const prefix = Object.keys(ACCOUNT_PREFERENCE_PREFIXES).find((p) => key.startsWith(p));
  return prefix ? ACCOUNT_PREFERENCE_PREFIXES[prefix] : key;
}

export interface StoredPreference {
  key: string;
  label: string;
  where: 'extension' | 'local';
}

/** Preferences that currently hold a saved value (the others are at their default). */
export async function listStoredPreferences(): Promise<StoredPreference[]> {
  const ext = Object.keys(await browser.storage.local.get(null));
  const local = typeof localStorage === 'undefined' ? [] : Object.keys(localStorage);
  const row = (key: string, where: StoredPreference['where']): StoredPreference => ({ key, where, label: preferenceLabel(key) });
  return [...ext.map((k) => row(k, 'extension')), ...local.map((k) => row(k, 'local'))];
}

/**
 * Every setting back to its default: empties the extension storage and the dashboard's
 * localStorage. Both hold only Tithies settings and preferences (no data: accounts and the
 * current account live in IndexedDB), and every reader has a fallback, so nothing else is
 * needed. Open pages pick the defaults up through their watchers.
 */
export async function resetAllSettings(): Promise<void> {
  await browser.storage.local.clear();
  if (typeof localStorage !== 'undefined') localStorage.clear();
}
