import type { AccountKey } from '@/lib/accounts/types';
import type { OverallProgress } from '@/lib/progress';
import type { SiteIdentity, SiteType } from '@/lib/sites/types';

/** queued: waiting for the actions started with it to finish (one at a time per site); nothing sent yet. */
export type ChangeOpStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** Kinds of user actions that change a site (more come with later features). */
export type ChangeOpKind = 'export';

/**
 * One user action that changes a site (e.g. one export), with every write it made in
 * `changeCalls`. Global: the log lists every account's changes, tagged with the account changed.
 */
export interface ChangeOp {
  id?: number;
  site: SiteType;
  /** The account the changes are made as (and to). */
  accountKey: AccountKey;
  userName: string;
  kind: ChangeOpKind;
  /** One line: "Export 42 prints (117 copies) to the binder “To buy”". */
  title: string;
  /** Where it was started from: "Comparator of alice". */
  source: string;
  status: ChangeOpStatus;
  /** The step running now, or the last one. */
  phase?: string;
  /** The step's progress: pages read, or changes sent. */
  progress?: { done: number; total: number; unit?: 'page' | 'change' };
  /** The whole action's progress, every step counted (see StepTally). */
  overall?: OverallProgress;
  error?: string;
  startedAt: number;
  heartbeatAt: number;
  finishedAt?: number;
  /** Writes logged so far, and how many have an unknown outcome. */
  calls: number;
  unknownCalls: number;
  /** What the action is about, kept for the log page (export: target, plan, verification). */
  details: unknown;
}

/** sent: on its way (stays so if Tithies stopped meanwhile); ok: made; failed: refused; unknown: maybe made. */
export type ChangeCallOutcome = 'sent' | 'ok' | 'failed' | 'unknown';

/** One write request, exactly as sent (never any auth header), and how it ended. */
export interface ChangeCall {
  opId: number;
  seq: number;
  at: number;
  method: string;
  url: string;
  /** Headers of its own (a deck's id and version), never auth. */
  headers?: Record<string, string>;
  body: string;
  outcome: ChangeCallOutcome;
  status?: number;
  durationMs?: number;
  /** The start of the site's answer. */
  response?: string;
  error?: string;
  as?: SiteIdentity | null;
}
