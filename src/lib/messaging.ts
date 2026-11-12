import { defineExtensionMessaging } from '@webext-core/messaging';
import type { CollectionEntry } from '@/lib/cards/types';
import type { AccountKey } from '@/lib/accounts/types';
import type { StartSyncResult } from '@/lib/decks/job';
import type { SiteApiCall, SiteIdentity, SiteResult, SiteTabStatus, SiteType } from '@/lib/sites/types';
import type { RunProgress, RunSource } from '@/features/f2f-buylist/types';

export type RunAction = 'pause' | 'resume' | 'cancel' | 'retryErrors';

/** Messages between content scripts, extension pages and the background worker. */
interface ProtocolMap {
  /** site tab → background: a Selling run of `account`'s collection (the account of the request that read it). */
  startRun(data: { type: SiteType; account: SiteIdentity; source: Omit<RunSource, 'tabId'>; entries: CollectionEntry[] }): { runId: number; prints: number; accountKey: AccountKey };
  controlRun(data: { runId: number; action: RunAction }): { ok: boolean; error?: string };
  openDashboard(data: { runId?: number }): void;
  /** The run, or else the newest run of `accountKey` started from the asking tab. */
  getProgress(data: { runId?: number; accountKey?: AccountKey }): RunProgress | null;
  /** background → site tab */
  runProgress(data: RunProgress): void;

  /**
   * Starts (or joins) the background sync of an account: deck list + changed decks, then the whole
   * collection when `collection` is true. `accountKey: null` syncs (and adds) whoever is logged in.
   * Answers once a tab is found; progress is in the account's meta 'sync'.
   */
  startAccountSync(data: { type: SiteType; accountKey: AccountKey | null; collection: boolean }): StartSyncResult;
  cancelAccountSync(data: { type: SiteType }): { ok: boolean };
  /** background → site tab: can this tab make requests to its site? */
  siteStatus(): SiteTabStatus;
  /** background → site tab: one request, made by the page itself (only as `expect`, when given). */
  siteApi(data: SiteApiCall): SiteResult;
  /** site tab → background: the tab's session appeared, went away, or changed account. */
  siteSessionChanged(data: { type: SiteType; hasAuth: boolean; identity: SiteIdentity | null }): void;
  /** dashboard → background: drop sessions of tabs that are gone or left the site. */
  pruneSessions(): void;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
