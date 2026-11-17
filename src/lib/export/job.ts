/**
 * Background export of cards to an account of a site (one per site; it shares the site's lock
 * with the deck sync). The account must be logged in on the site: every request is made as it,
 * and nothing is sent as anyone else.
 *
 * Steps: read the target (binders + whole collection) and refuse if it changed since the preview;
 * make the changes (create the binder, or delete what a replace deletes; then add the cards);
 * read the collection again and check every copy. Every write is in the change log. A write
 * whose outcome is unknown stops the export (never sent twice); the collection is read again
 * anyway, so the log shows what was made.
 */
import { accountData, getAccount } from '@/lib/accounts/data';
import { accountLabel, identityOf, type AccountKey, type AccountRow } from '@/lib/accounts/types';
import { getOp, patchOp, startOp, writeLogger } from '@/lib/changes/log';
import { StepTally } from '@/lib/changes/progress';
import type { CollectionEntry } from '@/lib/cards/types';
import { FULL_READ_EVERY_MS, readBinder, readCollection, readWholeCollection } from '@/lib/decks/collection';
import type { SyncTransport } from '@/lib/decks/job';
import { CancelledError, describeSiteError, SiteAuthError, SiteClient, SiteWrongAccountError, type SiteClientOptions } from '@/lib/sites/client';
import type { SiteLock } from '@/lib/sites/lock';
import type { SiteProvider } from '@/lib/sites/provider';
import type { SiteIdentity } from '@/lib/sites/types';
import { exporterOf, type SiteExporter } from './exporters';
import { afterRead, beforeRead, mergeItems, planExport } from './plan';
import type { ExportDetails, ExportItem, ExportPlan, ExportTarget, ReadProgress, TargetRead, TargetState } from './types';
import { verifyExport } from './verify';

export interface ExportJobDeps {
  createTransport(ctl: { signal: AbortSignal; onStatus(message: string): void; onOwnTabClosed(): void; expect: SiteIdentity }): SyncTransport;
  /** Overrides the provider's pacing (settings, tests). Read at each start. */
  clientOptions?: () => Promise<Partial<SiteClientOptions>>;
  onActiveChange?(active: boolean): void;
  lock: SiteLock;
}

export type ExportFailCode = 'busy' | 'no_account' | 'wrong_account' | 'no_tab' | 'unsupported' | 'bad_request' | 'error' | 'cancelled';
export type ReadTargetResult = { ok: true; state: TargetState } | { ok: false; code: ExportFailCode; error: string; actual?: SiteIdentity | null };
export type StartExportResult = { ok: true; opId: number } | { ok: false; code: ExportFailCode; error: string };

export interface StartExportRequest {
  target: ExportTarget;
  items: ExportItem[];
  /** The previewed plan's digest: nothing is changed when the target differs from what was previewed. */
  digest: string;
  /** The account whose page the cards come from (for the same-account warning). */
  sourceAccountKey: AccountKey | null;
  /** "Comparator of alice" */
  source: string;
  /** The previewed plan's requests of each step, to size the progress before this run's own plan. */
  estimate?: ExportPlan['requests'];
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const validRead = (r: unknown): r is TargetRead => {
  const x = r as TargetRead | null;
  return !!x && (x.kind === 'binders' || x.kind === 'totals' || x.kind === 'collection' || (x.kind === 'binder' && typeof x.binderId === 'string' && ID.test(x.binderId)));
};

/** Stops an export before anything is changed. */
class ExportStop extends Error {}

const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** The change log's one-line title of an export. */
export function exportTitle(target: ExportTarget, add: { prints: number; copies: number }, targetLabel: string): string {
  const what = `${plural(add.copies, 'copy', 'copies')} (${plural(add.prints, 'print')})`;
  if (target.kind !== 'newBinder' && target.mode === 'replace') return `Replace ${targetLabel} with ${what}`;
  return `Export ${what} to ${targetLabel}`;
}

const FINISHES = new Set(['nonFoil', 'foil', 'etched']);
const str = (v: unknown, max = 200) => typeof v === 'string' && v.length <= max;

/** Items come from an extension page: still checked, as they become requests. */
export function validItems(items: unknown): items is ExportItem[] {
  return (
    Array.isArray(items) &&
    items.length > 0 &&
    items.length <= 20_000 &&
    items.every(
      (i) =>
        i &&
        typeof i === 'object' &&
        str(i.key) &&
        str(i.name) &&
        i.name.trim() !== '' &&
        str(i.set, 20) &&
        i.set !== '' &&
        str(i.cn, 20) &&
        i.cn !== '' &&
        FINISHES.has(i.finish) &&
        Number.isInteger(i.qty) &&
        i.qty >= 1 &&
        i.qty <= 10_000,
    )
  );
}

export class ExportJob {
  private active: { opId: number; accountKey: AccountKey; abort: AbortController; done: Promise<void> } | null = null;
  private reading: { accountKey: AccountKey; abort: AbortController } | null = null;

  constructor(
    readonly site: SiteProvider,
    private deps: ExportJobDeps,
  ) {}

  /** The account being changed (or read for a preview). */
  get activeAccountKey(): AccountKey | null {
    return this.active?.accountKey ?? this.reading?.accountKey ?? null;
  }

  get activeOpId(): number | null {
    return this.active?.opId ?? null;
  }

  /** Resolves when the running export (if any) has finished. */
  get finished(): Promise<void> {
    return this.active?.done ?? Promise.resolve();
  }

  cancel(): boolean {
    const running = this.active ?? this.reading;
    if (!running) return false;
    running.abort.abort();
    return true;
  }

  private busy(): string {
    const label = this.site.label;
    return this.deps.lock.heldBy === 'sync'
      ? `Tithies is syncing ${label} decks or a collection: wait for it to finish (or cancel it), then try again.`
      : `Another export to ${label} is running: wait for it to finish.`;
  }

  private async account(accountKey: AccountKey): Promise<AccountRow | null> {
    const row = await getAccount(accountKey);
    return row && row.type === this.site.type ? row : null;
  }

  private async client(transport: SyncTransport, signal?: AbortSignal, onWait?: (m: string) => void): Promise<SiteClient> {
    return new SiteClient(transport.call, {
      label: this.site.label,
      ...this.site.pacing,
      ...((await this.deps.clientOptions?.()) ?? {}),
      signal,
      onWait,
      expectedUserId: () => transport.identity?.userId,
      describeMutation: (op) => this.site.describeMutation(op),
    });
  }

  /**
   * Reads what `read` says (see TargetRead): the binder list (1 request), plus one binder's
   * cards, or one page for the collection's totals, or every page of the collection.
   */
  /**
   * The account's saved collection, to read only what changed since (when its last full read is
   * under a week old; a read of the changes falls back to every page when it can't be trusted).
   */
  private async savedCollection(accountKey: AccountKey): Promise<CollectionEntry[] | null> {
    const data = accountData(accountKey);
    const meta = await data.meta.get('collection');
    if (!meta?.fullReadAt || Date.now() - meta.fullReadAt > FULL_READ_EVERY_MS) return null;
    return data.collection.list();
  }

  private async readState(
    client: SiteClient,
    read: TargetRead,
    signal: AbortSignal | undefined,
    onProgress?: (p: ReadProgress) => void,
    /** For a whole-collection read: a complete earlier read to build on (only the changes are read). */
    base: readonly CollectionEntry[] | null = null,
  ): Promise<TargetState> {
    const binders = this.site.capabilities.exportTo.binders ? await client.binders() : [];
    const empty = { binders, read, entries: [] as CollectionEntry[], totals: null as TargetState['totals'], readAt: Date.now() };
    if (read.kind === 'binders') return empty;
    if (read.kind === 'totals') {
      onProgress?.({ done: 0, total: 1 });
      const page = await client.collectionPage(1, this.site.collectionPageSize);
      onProgress?.({ done: 1, total: 1 });
      const copies = page.totalCopies ?? (page.totalPages <= 1 ? page.entries.reduce((s, e) => s + e.qty, 0) : 0);
      return { ...empty, totals: { entries: page.totalResults, copies }, readAt: Date.now() };
    }
    const progress = { signal, onProgress: (p: { done: number; total: number }) => onProgress?.({ done: p.done, total: p.total }) };
    if (read.kind === 'binder') {
      const binder = binders.find((b) => b.id === read.binderId);
      // Gone: nothing to read (the plan says so).
      if (!binder) return empty;
      let all: CollectionEntry[];
      try {
        all = await readBinder(this.site, client, binder.publicId, progress);
      } catch (e) {
        // The binder search failed: read the whole collection instead (slower, same result).
        if (e instanceof CancelledError || e instanceof SiteAuthError || e instanceof SiteWrongAccountError || signal?.aborted) throw e;
        all = await readWholeCollection(this.site, client, progress);
      }
      // Only that binder's cards, whatever the site sent.
      return { ...empty, entries: all.filter((e) => e.binderId === read.binderId), readAt: Date.now() };
    }
    const { entries } = await readCollection(this.site, client, base, progress);
    return { ...empty, entries, totals: { entries: entries.length, copies: entries.reduce((s, e) => s + e.qty, 0) }, readAt: Date.now() };
  }

  /** Reads the target account for a preview (what `read` says). Changes nothing. */
  async readTarget(accountKey: AccountKey, read: TargetRead = { kind: 'binders' }, onProgress?: (p: ReadProgress) => void): Promise<ReadTargetResult> {
    if (!validRead(read)) return { ok: false, code: 'bad_request', error: 'Unknown read.' };
    const row = await this.account(accountKey);
    if (!row) return { ok: false, code: 'no_account', error: `This ${this.site.label} account isn't in Tithies any more.` };
    if (!this.deps.lock.tryAcquire('export')) return { ok: false, code: 'busy', error: this.busy() };
    const abort = new AbortController();
    this.reading = { accountKey, abort };
    this.deps.onActiveChange?.(true);
    const transport = this.deps.createTransport({ signal: abort.signal, onStatus: () => {}, onOwnTabClosed: () => abort.abort(), expect: identityOf(row) });
    let keepOwnTab = false;
    try {
      const connected = await transport.connect();
      if (!connected.ok) {
        keepOwnTab = connected.code === 'wrong_account';
        return { ok: false, code: connected.code === 'wrong_account' ? 'wrong_account' : 'no_tab', error: connected.message, actual: connected.as ?? null };
      }
      const base = read.kind === 'collection' ? await this.savedCollection(accountKey) : null;
      const state = await this.readState(await this.client(transport, abort.signal), read, abort.signal, onProgress, base);
      return { ok: true, state };
    } catch (e) {
      if (abort.signal.aborted || e instanceof CancelledError) return { ok: false, code: 'cancelled', error: 'Cancelled' };
      keepOwnTab = e instanceof SiteAuthError || e instanceof SiteWrongAccountError;
      return { ok: false, code: e instanceof SiteWrongAccountError ? 'wrong_account' : 'error', error: describeSiteError(e), actual: e instanceof SiteWrongAccountError ? e.actual : undefined };
    } finally {
      await transport.release({ keepOwnTab }).catch(() => {});
      this.reading = null;
      this.deps.lock.release('export');
      this.deps.onActiveChange?.(false);
    }
  }

  /** Starts an export; answers once it is in the change log (progress: the op row). */
  async start(req: StartExportRequest): Promise<StartExportResult> {
    const exporter = exporterOf(this.site.type);
    if (!exporter) return { ok: false, code: 'unsupported', error: `Tithies can't export to ${this.site.label}.` };
    if (!req || !validItems(req.items) || typeof req.digest !== 'string' || !req.target) return { ok: false, code: 'bad_request', error: 'Nothing valid to export.' };
    const t = req.target;
    if (t.kind === 'binder' && !this.site.capabilities.exportTo.binders) return { ok: false, code: 'unsupported', error: `${this.site.label} has no binders.` };
    if (t.kind === 'newBinder' && !this.site.capabilities.exportTo.binders) return { ok: false, code: 'unsupported', error: `${this.site.label} has no binders.` };
    if (t.kind === 'collection' && !this.site.capabilities.exportTo.collection) return { ok: false, code: 'unsupported', error: `Tithies can't export into a ${this.site.label} collection.` };
    const row = await this.account(t.accountKey);
    if (!row) return { ok: false, code: 'no_account', error: `This ${this.site.label} account isn't in Tithies any more.` };
    if (!this.deps.lock.tryAcquire('export')) return { ok: false, code: 'busy', error: this.busy() };

    const items = mergeItems(req.items);
    const add = { prints: items.length, copies: items.reduce((s, i) => s + i.qty, 0) };
    const name = accountLabel(row);
    const details: ExportDetails = {
      target: t,
      targetLabel: t.kind === 'collection' ? `${name}'s collection` : t.kind === 'newBinder' ? `the new binder “${t.name.trim()}”` : 'a binder',
      sourceAccountKey: req.sourceAccountKey ?? null,
      items,
      add,
      removed: [],
      wholeCollection: false,
      before: 0,
      after: 0,
    };
    let opId: number;
    try {
      opId = await startOp({
        site: this.site.type,
        accountKey: row.key,
        userName: row.userName,
        kind: 'export',
        title: exportTitle(t, add, details.targetLabel),
        source: typeof req.source === 'string' ? req.source.slice(0, 200) : '',
        phase: `Connecting to ${this.site.label} as ${name}`,
        details,
      });
    } catch (e) {
      this.deps.lock.release('export');
      return { ok: false, code: 'error', error: describeSiteError(e) };
    }
    const abort = new AbortController();
    this.deps.onActiveChange?.(true);
    const active = { opId, accountKey: row.key, abort, done: Promise.resolve() };
    this.active = active;
    active.done = this.run(opId, row, req, items, details, exporter, abort).finally(() => {
      if (this.active === active) this.active = null;
      this.deps.lock.release('export');
      this.deps.onActiveChange?.(false);
    });
    return { ok: true, opId };
  }

  private async run(
    opId: number,
    row: AccountRow,
    req: StartExportRequest,
    items: ExportItem[],
    details: ExportDetails,
    exporter: SiteExporter,
    abort: AbortController,
  ): Promise<void> {
    const { signal } = abort;
    const { label } = this.site;
    const name = accountLabel(row);
    const target = req.target;
    const transport = this.deps.createTransport({
      signal,
      onStatus: (message) => void patchOp(opId, { phase: message }).catch(() => {}),
      onOwnTabClosed: () => abort.abort(),
      expect: identityOf(row),
    });
    let keepOwnTab = false;
    let wrote = false;
    let before: TargetState | null = null;
    let plan: ExportPlan | null = null;
    let binderId: string | null = target.kind === 'binder' ? target.binderId : null;
    const save = (p: Parameters<typeof patchOp>[1]) => patchOp(opId, { ...p, details }).catch(() => {});
    // One progress over the three steps: read the target, send the changes, check.
    const [BEFORE, WRITE, CHECK] = [0, 1, 2];
    const est = req.estimate;
    const tally = new StepTally([est?.before ?? 1, est?.write ?? 1, est?.check ?? 1]);
    const readProgress = (step: number, phase?: string) => (p: ReadProgress) =>
      void patchOp(opId, { ...(phase ? { phase } : {}), progress: { ...p, unit: 'page' }, overall: tally.report(step, p.done, p.total) }).catch(() => {});

    try {
      const connected = await transport.connect();
      if (!connected.ok) {
        if (connected.code === 'wrong_account') throw new SiteWrongAccountError(connected.message, connected.as ?? null);
        throw new ExportStop(connected.message);
      }
      const client = await this.client(transport, signal, (message) => void patchOp(opId, { phase: message }).catch(() => {}));

      const first = beforeRead(target);
      await save({
        phase: first.kind === 'collection' ? `Reading ${name}'s collection` : first.kind === 'binder' ? `Reading ${name}'s binders and the binder's cards` : `Reading ${name}'s binders`,
        progress: undefined,
        overall: tally.report(BEFORE, 0, 0),
      });
      const saved = first.kind === 'collection' ? await this.savedCollection(row.key) : null;
      before = await this.readState(client, first, signal, readProgress(BEFORE), saved);
      plan = planExport(target, items, before, { sourceAccountKey: req.sourceAccountKey, targetName: name, limits: exporter.limits });
      Object.assign(details, {
        targetLabel: plan.targetLabel,
        removed: plan.remove.entries,
        wholeCollection: plan.remove.wholeCollection,
        before: plan.before,
        after: plan.after,
        ...(plan.binder ? { binder: plan.binder } : {}),
      });
      tally.expect(WRITE, plan.writes);
      tally.expect(CHECK, plan.requests.check);
      await save({ title: exportTitle(target, plan.add, plan.targetLabel), overall: tally.overall });
      if (plan.blocked) throw new ExportStop(plan.blocked);
      if (plan.digest !== req.digest) throw new ExportStop(`${name}'s binders or collection changed since the preview, so nothing was changed. Open the preview again.`);

      const log = writeLogger(opId);
      let done = 0;
      const total = plan.writes;
      const write = async (op: Parameters<SiteClient['mutate']>[0], phase: string) => {
        if (signal.aborted) throw new CancelledError();
        await save({ phase, progress: { done, total, unit: 'change' }, overall: tally.report(WRITE, done, total) });
        wrote = true;
        const res = await client.mutate(op, log);
        done++;
        return res;
      };

      if (target.kind === 'newBinder') {
        const res = await write(exporter.createBinder(target.name, target.visibility), `Creating the binder “${target.name.trim()}”`);
        if (!res.binder) throw new Error(`${label} didn't say which binder it created.`);
        binderId = res.binder.id;
        details.binder = res.binder;
      }
      if (plan.remove.entries.length) {
        if (plan.remove.wholeCollection) await write(exporter.deleteCollection(), `Deleting ${name}'s collection`);
        else for (const op of exporter.removeEntries(plan.remove.entries.map((e) => e.entryId))) await write(op, `Deleting the cards in ${plan.targetLabel}`);
      }
      const imports = exporter.importItems(plan.items, binderId);
      for (const [i, op] of imports.entries()) {
        const res = await write(op, imports.length > 1 ? `Adding the cards (${i + 1}/${imports.length})` : 'Adding the cards');
        if (res.imported) {
          const prev = details.imported ?? { count: 0, errors: [], failed: 0 };
          details.imported = { count: prev.count + res.imported.count, errors: [...prev.errors, ...res.imported.errors].slice(0, 200), failed: prev.failed + (res.imported.ok ? 0 : 1) };
        }
      }

      tally.report(WRITE, done, total);
      const last = afterRead(target, binderId);
      await save({
        phase: last.kind === 'binder' ? 'Checking every copy in the binder' : `Checking every copy in ${name}'s collection`,
        progress: { done: 0, total: 1, unit: 'page' },
        overall: tally.report(CHECK, 0, 0),
      });
      // The check builds on the read just made: only the changes since are read (the totals tell if anything else changed).
      const checkBase = last.kind === 'collection' ? (plan.remove.wholeCollection ? [] : before.entries) : null;
      const after = await this.readState(client, last, signal, readProgress(CHECK), checkBase);
      details.verify = verifyExport(plan, before.entries, after.entries, binderId);
      await save({ status: 'done', phase: details.verify.ok ? 'Done: every copy is there' : 'Done, with differences (see below)', overall: tally.finish(), finishedAt: Date.now() });
    } catch (e) {
      const cancelled = signal.aborted || e instanceof CancelledError;
      const wrong = e instanceof SiteWrongAccountError;
      keepOwnTab = e instanceof SiteAuthError || wrong;
      // Something was sent: read the collection again (reads only) so the log shows what was made.
      if (wrote && plan && before && !wrong) {
        try {
          const check = await this.client(transport);
          const lastRead = afterRead(target, binderId);
          const after = await this.readState(
            check,
            lastRead,
            undefined,
            readProgress(CHECK, 'Checking what was made'),
            lastRead.kind === 'collection' ? (plan.remove.wholeCollection ? [] : before.entries) : null,
          );
          details.verify = verifyExport(plan, before.entries, after.entries, binderId);
        } catch {
          /* the log still lists every request */
        }
      }
      const message = cancelled
        ? wrote
          ? 'Cancelled. The changes made before are kept: see the requests and the check below.'
          : 'Cancelled before anything was changed.'
        : wrong
          ? `${e.actual ? `${label} is logged in as ${e.actual.userName}` : `Couldn't tell which ${label} account is logged in`}, so the export stopped${wrote ? '' : ' before changing anything'}. Log in as ${row.userName} on ${label}, then try again.`
          : `${describeSiteError(e)}${wrote || e instanceof ExportStop ? '' : ' Nothing was changed.'}`;
      await save({ status: cancelled ? 'cancelled' : 'failed', error: message, phase: undefined, finishedAt: Date.now() });
    } finally {
      await transport.release({ keepOwnTab }).catch(() => {});
    }
  }
}

/** The op's details, typed (the log stores them as unknown). */
export async function exportDetails(opId: number): Promise<ExportDetails | null> {
  const op = await getOp(opId);
  return op?.kind === 'export' ? (op.details as ExportDetails) : null;
}
