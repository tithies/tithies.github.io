/**
 * Background sync job of one site: deck list + changed decks, then (optionally) the whole collection.
 * `start` answers at once; progress lives in `meta.moxSync`, which pages read with useLiveQuery.
 * One job at a time: starting while one runs joins it (and can ask it to read the collection too).
 */
import { getMeta, putMeta } from '@/lib/db';
import { CancelledError, describeSiteError, SiteAuthError, SiteClient, type SiteClientOptions, type SiteTransport } from '@/lib/sites/client';
import type { SiteProvider } from '@/lib/sites/provider';
import { refreshCollection } from './collection';
import { syncDecks } from './sync';
import { META_SYNC, type SyncState } from './types';

export interface SyncTransport {
  call: SiteTransport;
  release(opts?: { keepOwnTab?: boolean }): Promise<void>;
}

export interface SyncJobDeps {
  createTransport(ctl: { signal: AbortSignal; onStatus(message: string): void; onOwnTabClosed(): void }): SyncTransport;
  onActiveChange?(active: boolean): void;
  /** Overrides the provider's pacing (tests, settings). */
  clientOptions?: Partial<SiteClientOptions>;
}

interface ActiveJob {
  state: SyncState;
  abort: AbortController;
  done: Promise<void>;
}

export class AccountSyncJob {
  private active: ActiveJob | null = null;

  constructor(
    readonly site: SiteProvider,
    private deps: SyncJobDeps,
  ) {}

  get isActive() {
    return this.active != null;
  }

  /** Resolves when the current job (if any) has finished. */
  get finished(): Promise<void> {
    return this.active?.done ?? Promise.resolve();
  }

  async start({ collection }: { collection: boolean }): Promise<{ jobId: string; alreadyRunning: boolean }> {
    const running = this.active;
    if (running) {
      if (collection && !running.state.withCollection) await this.patch(running, { withCollection: true });
      return { jobId: running.state.jobId, alreadyRunning: true };
    }
    const now = Date.now();
    const job: ActiveJob = {
      state: {
        jobId: `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        status: 'running',
        phase: 'connecting',
        withCollection: collection,
        done: 0,
        total: 0,
        startedAt: now,
        heartbeatAt: now,
        requests: 0,
      },
      abort: new AbortController(),
      done: Promise.resolve(),
    };
    this.active = job; // before any await, so a concurrent start() joins this job
    this.deps.onActiveChange?.(true);
    await putMeta(META_SYNC, job.state);
    job.done = this.run(job).finally(() => {
      if (this.active === job) this.active = null;
      this.deps.onActiveChange?.(false);
    });
    return { jobId: job.state.jobId, alreadyRunning: false };
  }

  cancel(): boolean {
    if (!this.active) return false;
    this.active.abort.abort();
    return true;
  }

  /** On worker start: a job still marked running died with the previous worker. It is not resumed automatically. */
  async markStale(): Promise<void> {
    if (this.active) return;
    const s = await getMeta<SyncState>(META_SYNC);
    if (s?.status !== 'running') return;
    await putMeta(META_SYNC, {
      ...s,
      status: 'interrupted',
      error: 'The sync was interrupted (browser closed or extension reloaded). Sync again: decks already read are kept.',
      message: undefined,
      finishedAt: Date.now(),
    } satisfies SyncState);
  }

  private patch(job: ActiveJob, p: Partial<SyncState>): Promise<void> {
    job.state = { ...job.state, ...p, heartbeatAt: Date.now() };
    return putMeta(META_SYNC, job.state);
  }

  private async run(job: ActiveJob): Promise<void> {
    const { signal } = job.abort;
    const transport = this.deps.createTransport({
      signal,
      onStatus: (message) => void this.patch(job, { message }),
      onOwnTabClosed: () => job.abort.abort(),
    });
    const client = new SiteClient(transport.call, {
      label: this.site.label,
      ...this.site.pacing,
      ...this.deps.clientOptions,
      signal,
      onWait: (message) => void this.patch(job, { message }),
    });
    let keepOwnTab = false;
    try {
      const decks = await syncDecks(this.site, client, {
        signal,
        onProgress: (p) => this.patch(job, { phase: p.phase, done: p.done, total: p.total, current: p.current, message: undefined, requests: client.requests }),
      });
      await this.patch(job, { decks, current: undefined, requests: client.requests });
      // Read at this point: a "Find mismatches" may have joined a decks-only sync meanwhile.
      if (job.state.withCollection) {
        await this.patch(job, { phase: 'collection', done: 0, total: 1, message: undefined });
        await refreshCollection(this.site, client, {
          signal,
          onProgress: (p) => this.patch(job, { done: p.done, total: p.total, message: undefined, requests: client.requests }),
        });
      }
      await this.patch(job, { status: 'done', phase: 'done', finishedAt: Date.now(), message: undefined, requests: client.requests });
    } catch (e) {
      const cancelled = signal.aborted || e instanceof CancelledError;
      keepOwnTab = e instanceof SiteAuthError;
      await this.patch(job, {
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled ? undefined : describeSiteError(e),
        finishedAt: Date.now(),
        message: undefined,
        current: undefined,
        requests: client.requests,
      });
    } finally {
      await transport.release({ keepOwnTab }).catch(() => {});
    }
  }
}
