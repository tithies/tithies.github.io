/**
 * Background sync job of one site: deck list + changed decks, then (optionally) the whole
 * collection, for one account. `start` answers once a tab of the account is found; progress
 * lives in the account's meta 'sync', which pages read with useLiveQuery. One job per site at a
 * time: starting while one runs for the same account joins it (and can ask it to read the
 * collection too); another account must wait.
 *
 * With a known account, the job only works through tabs logged in as it, and stops at the first
 * answer from anyone else. With no account (`accountKey: null`, a first sync), it adopts the
 * account that is logged in: that is an action, so the account is added and becomes current.
 */
import { accountData, addAccountFromAction, AccountGoneError, getAccount, listAccounts, type AccountData } from '@/lib/accounts/data';
import { identityOf, type AccountKey } from '@/lib/accounts/types';
import {
  CancelledError,
  describeSiteError,
  SiteAuthError,
  SiteClient,
  SiteWrongAccountError,
  type SiteClientOptions,
  type SiteTransport,
} from '@/lib/sites/client';
import type { SiteProvider } from '@/lib/sites/provider';
import type { SiteFailure, SiteIdentity } from '@/lib/sites/types';
import { refreshCollection } from './collection';
import { syncDecks } from './sync';
import type { SyncState } from './types';

export interface SyncTransport {
  call: SiteTransport;
  release(opts?: { keepOwnTab?: boolean }): Promise<void>;
  /** Finds the tab to work through (no request made yet) and says whose session it is. */
  connect(): Promise<{ ok: true; identity: SiteIdentity | null } | SiteFailure>;
  /** The account requests are made as. */
  readonly identity: SiteIdentity | null;
}

export interface SyncJobDeps {
  createTransport(ctl: { signal: AbortSignal; onStatus(message: string): void; onOwnTabClosed(): void; expect: SiteIdentity | 'first' }): SyncTransport;
  onActiveChange?(active: boolean): void;
  /** Overrides the provider's pacing (tests, settings). Read at each job start. */
  clientOptions?: Partial<SiteClientOptions> | (() => Promise<Partial<SiteClientOptions>>);
}

export type StartSyncResult =
  | { ok: true; jobId: string; accountKey: AccountKey; alreadyRunning: boolean }
  | {
      ok: false;
      error: string;
      /** busy: another account's sync runs (`busyWith`); wrong_account / no_tab: no usable session (first sync). */
      code: 'busy' | 'no_account' | 'wrong_account' | 'no_tab' | 'cancelled';
      busyWith?: AccountKey;
      actual?: SiteIdentity | null;
    };

interface ActiveJob {
  state: SyncState;
  data: AccountData;
  abort: AbortController;
  done: Promise<void>;
}

const newJobId = (now: number) => `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export class AccountSyncJob {
  private active: ActiveJob | null = null;
  /** A start in progress (looking for a tab, before the job exists). */
  private starting: { promise: Promise<StartSyncResult>; abort: AbortController } | null = null;

  constructor(
    readonly site: SiteProvider,
    private deps: SyncJobDeps,
  ) {}

  get isActive() {
    return this.active != null;
  }

  /** The account the running job is for. */
  get activeAccountKey(): AccountKey | null {
    return (this.active?.state.accountKey as AccountKey) ?? null;
  }

  /** Resolves when the current job (if any) has finished. */
  get finished(): Promise<void> {
    return this.active?.done ?? Promise.resolve();
  }

  async start({ accountKey, collection }: { accountKey: AccountKey | null; collection: boolean }): Promise<StartSyncResult> {
    for (;;) {
      if (this.starting) {
        await this.starting.promise.catch(() => undefined);
        continue;
      }
      const running = this.active;
      if (running) {
        const key = running.state.accountKey as AccountKey;
        if (accountKey !== null && accountKey !== key) {
          return { ok: false, code: 'busy', busyWith: key, error: `Tithies is already syncing another ${this.site.label} account. Wait for it to finish, or cancel it.` };
        }
        if (collection && !running.state.withCollection) await this.patch(running, { withCollection: true });
        return { ok: true, jobId: running.state.jobId, accountKey: key, alreadyRunning: true };
      }
      const abort = new AbortController();
      const promise = this.begin(accountKey, collection, abort);
      this.starting = { promise, abort };
      try {
        return await promise;
      } finally {
        if (this.starting?.promise === promise) this.starting = null;
      }
    }
  }

  cancel(): boolean {
    if (this.starting) {
      this.starting.abort.abort();
      return true;
    }
    if (!this.active) return false;
    this.active.abort.abort();
    return true;
  }

  /** On worker start: a job still marked running died with the previous worker. It is not resumed automatically. */
  async markStale(): Promise<void> {
    if (this.active || this.starting) return;
    for (const a of await listAccounts()) {
      if (a.type !== this.site.type) continue;
      const data = accountData(a.key);
      const s = await data.meta.get('sync');
      if (s?.status !== 'running') continue;
      await data
        .write((w) =>
          w.meta.put('sync', {
            ...s,
            status: 'interrupted',
            error: 'The sync was interrupted (browser closed or extension reloaded). Sync again: decks already read are kept.',
            message: undefined,
            finishedAt: Date.now(),
          }),
        )
        .catch(() => {});
    }
  }

  private async clientOptions(): Promise<Partial<SiteClientOptions>> {
    const o = this.deps.clientOptions;
    return typeof o === 'function' ? o() : (o ?? {});
  }

  private async begin(accountKey: AccountKey | null, collection: boolean, abort: AbortController): Promise<StartSyncResult> {
    const { label } = this.site;
    let data: AccountData | null = null;
    let expect: SiteIdentity | 'first' = 'first';
    if (accountKey !== null) {
      const row = await getAccount(accountKey);
      if (!row || row.type !== this.site.type) return { ok: false, code: 'no_account', error: `This ${label} account isn't in Tithies any more.` };
      data = accountData(row.key);
      expect = identityOf(row);
    }

    const now = Date.now();
    let job: ActiveJob | null = null;
    const state: SyncState = {
      jobId: newJobId(now),
      accountKey: accountKey ?? '',
      status: 'running',
      phase: 'connecting',
      withCollection: collection,
      done: 0,
      total: 0,
      startedAt: now,
      heartbeatAt: now,
      requests: 0,
    };
    this.deps.onActiveChange?.(true);
    const transport = this.deps.createTransport({
      signal: abort.signal,
      onStatus: (message) => void (job && this.patch(job, { message })),
      onOwnTabClosed: () => abort.abort(),
      expect,
    });
    const giveUp = async (result: StartSyncResult, keepOwnTab = false): Promise<StartSyncResult> => {
      await transport.release({ keepOwnTab }).catch(() => {});
      this.deps.onActiveChange?.(false);
      return result;
    };

    // A known account shows "Connecting…" at once; a first sync has nowhere to say it until the account is known.
    if (data) {
      job = { state, data, abort, done: Promise.resolve() };
      this.active = job;
      try {
        await this.patch(job, {});
      } catch (e) {
        this.active = null;
        return giveUp({ ok: false, code: 'no_account', error: describeSiteError(e) });
      }
    }

    let connected: Awaited<ReturnType<SyncTransport['connect']>>;
    try {
      connected = await transport.connect();
    } catch (e) {
      connected = { ok: false, status: 0, code: abort.signal.aborted || e instanceof CancelledError ? 'tab_lost' : 'no_tab', message: describeSiteError(e) };
    }
    if (abort.signal.aborted) connected = { ok: false, status: 0, code: 'tab_lost', message: 'Cancelled' };

    if (!connected.ok || !connected.identity) {
      const failure: SiteFailure = connected.ok
        ? { ok: false, status: 0, code: 'no_tab', message: `Couldn't tell which ${label} account is logged in.` }
        : connected;
      const wrong = failure.code === 'wrong_account';
      const cancelled = abort.signal.aborted;
      if (job) {
        await this.patch(job, {
          status: cancelled ? 'cancelled' : 'error',
          error: cancelled ? undefined : failure.message,
          code: wrong ? 'wrong_account' : undefined,
          actual: wrong ? (failure.as ?? null) : undefined,
          finishedAt: Date.now(),
          message: undefined,
        }).catch(() => {});
        this.active = null;
        await giveUp({ ok: true, jobId: state.jobId, accountKey: job.data.key, alreadyRunning: false }, true);
        return { ok: true, jobId: state.jobId, accountKey: job.data.key, alreadyRunning: false };
      }
      return giveUp(
        cancelled
          ? { ok: false, code: 'cancelled', error: 'Cancelled' }
          : { ok: false, code: wrong ? 'wrong_account' : 'no_tab', error: failure.message, actual: failure.as ?? null },
        true,
      );
    }

    if (!job) {
      // First sync: the logged-in account is adopted (and becomes the current account).
      const row = await addAccountFromAction(this.site.type, connected.identity);
      data = accountData(row.key);
      job = { state: { ...state, accountKey: row.key }, data, abort, done: Promise.resolve() };
      this.active = job;
      await this.patch(job, {}).catch(() => {});
    }

    const running = job;
    running.done = this.run(running, transport).finally(() => {
      if (this.active === running) this.active = null;
      this.deps.onActiveChange?.(false);
    });
    return { ok: true, jobId: running.state.jobId, accountKey: running.data.key, alreadyRunning: false };
  }

  private patch(job: ActiveJob, p: Partial<SyncState>): Promise<void> {
    job.state = { ...job.state, ...p, heartbeatAt: Date.now() };
    const state = job.state;
    return job.data.write((w) => w.meta.put('sync', state)).then(() => undefined);
  }

  private async run(job: ActiveJob, transport: SyncTransport): Promise<void> {
    const { signal } = job.abort;
    const client = new SiteClient(transport.call, {
      label: this.site.label,
      ...this.site.pacing,
      ...(await this.clientOptions()),
      signal,
      onWait: (message) => void this.patch(job, { message }).catch(() => {}),
      expectedUserId: () => transport.identity?.userId,
    });
    let keepOwnTab = false;
    try {
      const decks = await syncDecks(this.site, job.data, client, {
        signal,
        onProgress: (p) => this.patch(job, { phase: p.phase, done: p.done, total: p.total, current: p.current, message: undefined, requests: client.requests }),
      });
      await this.patch(job, { decks, current: undefined, requests: client.requests });
      // Read at this point: a "Find mismatches" may have joined a decks-only sync meanwhile.
      if (job.state.withCollection) {
        await this.patch(job, { phase: 'collection', done: 0, total: 1, message: undefined });
        await refreshCollection(this.site, job.data, client, {
          signal,
          onProgress: (p) => this.patch(job, { done: p.done, total: p.total, message: undefined, requests: client.requests }),
        });
      }
      await this.patch(job, { status: 'done', phase: 'done', finishedAt: Date.now(), message: undefined, requests: client.requests });
    } catch (e) {
      // Forgotten meanwhile: nothing left to write to.
      if (e instanceof AccountGoneError) return;
      const cancelled = signal.aborted || e instanceof CancelledError;
      const wrong = e instanceof SiteWrongAccountError;
      // Leave Tithies' own tab open when the user has to log in (again, or as the right account) there.
      keepOwnTab = e instanceof SiteAuthError || wrong;
      await this.patch(job, {
        status: cancelled ? 'cancelled' : 'error',
        error: cancelled ? undefined : wrong ? this.wrongAccountMessage(e.actual) : describeSiteError(e),
        code: wrong ? 'wrong_account' : undefined,
        actual: wrong ? e.actual : undefined,
        finishedAt: Date.now(),
        message: undefined,
        current: undefined,
        requests: client.requests,
      }).catch(() => {});
    } finally {
      await transport.release({ keepOwnTab }).catch(() => {});
    }
  }

  private wrongAccountMessage(actual: SiteIdentity | null): string {
    const { label } = this.site;
    return actual
      ? `${label} is now logged in as ${actual.userName}, so the sync stopped. What was read before is kept.`
      : `Couldn't tell which ${label} account answered, so the sync stopped. What was read before is kept.`;
  }
}
