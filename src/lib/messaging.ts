import { defineExtensionMessaging } from '@webext-core/messaging';
import type { MoxApiRequest, MoxApiResult, MoxTabStatus } from '@/lib/moxfield/api';
import type { MoxEntry } from '@/lib/moxfield/normalize';
import type { RunProgress, RunSource } from '@/features/f2f-buylist/types';

export type RunAction = 'pause' | 'resume' | 'cancel' | 'retryErrors';

/** Messages between content scripts, extension pages and the background worker. */
interface ProtocolMap {
  startRun(data: { source: Omit<RunSource, 'tabId'>; entries: MoxEntry[] }): { runId: number; prints: number };
  controlRun(data: { runId: number; action: RunAction }): { ok: boolean; error?: string };
  openDashboard(data: { runId?: number }): void;
  getProgress(data: { runId?: number }): RunProgress | null;
  /** background → Moxfield tab */
  runProgress(data: RunProgress): void;

  /**
   * Starts (or joins) the background Moxfield sync: deck list + changed decks, then the whole
   * collection when `collection` is true. Answers at once; progress is in Dexie (`meta.moxSync`).
   */
  startMoxfieldSync(data: { collection: boolean }): { jobId: string; alreadyRunning: boolean };
  cancelMoxfieldSync(): { ok: boolean };
  /** background → Moxfield tab: can this tab make Moxfield requests? */
  moxfieldStatus(): MoxTabStatus;
  /** background → Moxfield tab: one Moxfield API request, made by the page itself. */
  moxfieldApi(data: MoxApiRequest): MoxApiResult;
}

export const { sendMessage, onMessage } = defineExtensionMessaging<ProtocolMap>();
