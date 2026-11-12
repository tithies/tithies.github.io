import { defineExtensionMessaging } from '@webext-core/messaging';
import type { CollectionEntry } from '@/lib/cards/types';
import type { SiteRequest, SiteResult, SiteTabStatus, SiteType } from '@/lib/sites/types';
import type { RunProgress, RunSource } from '@/features/f2f-buylist/types';

export type RunAction = 'pause' | 'resume' | 'cancel' | 'retryErrors';

/** Messages between content scripts, extension pages and the background worker. */
interface ProtocolMap {
  startRun(data: { source: Omit<RunSource, 'tabId'>; entries: CollectionEntry[] }): { runId: number; prints: number };
  controlRun(data: { runId: number; action: RunAction }): { ok: boolean; error?: string };
  openDashboard(data: { runId?: number }): void;
  getProgress(data: { runId?: number }): RunProgress | null;
  /** background → site tab */
  runProgress(data: RunProgress): void;

  /**
   * Starts (or joins) the background sync of a site: deck list + changed decks, then the whole
   * collection when `collection` is true. Answers at once; progress is in Dexie.
   */
  startAccountSync(data: { type: SiteType; collection: boolean }): { jobId: string; alreadyRunning: boolean };
  cancelAccountSync(data: { type: SiteType }): { ok: boolean };
  /** background → site tab: can this tab make requests to its site? */
  siteStatus(): SiteTabStatus;
  /** background → site tab: one request, made by the page itself. */
  siteApi(data: SiteRequest): SiteResult;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
