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
import { getAccount } from '@/lib/accounts/data';
import { accountLabel, identityOf, type AccountKey, type AccountRow } from '@/lib/accounts/types';
import { getOp, patchOp, startOp, writeLogger } from '@/lib/changes/log';
import { readWholeCollection } from '@/lib/decks/collection';
import type { SyncTransport } from '@/lib/decks/job';
import { CancelledError, describeSiteError, SiteAuthError, SiteClient, SiteWrongAccountError, type SiteClientOptions } from '@/lib/sites/client';
import type { SiteLock } from '@/lib/sites/lock';
import type { SiteProvider } from '@/lib/sites/provider';
import type { SiteIdentity } from '@/lib/sites/types';
import { exporterOf, type SiteExporter } from './exporters';
import { mergeItems, planExport } from './plan';
import type { ExportDetails, ExportItem, ExportPlan, ExportTarget, TargetState } from './types';
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
  /** "Collection comparisons of alice" */
  source: string;
}

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

  private async readState(client: SiteClient, signal: AbortSignal | undefined, onProgress?: (p: { done: number; total: number }) => void): Promise<TargetState> {
    const binders = this.site.capabilities.exportTo.binders ? await client.binders() : [];
    const entries = await readWholeCollection(this.site, client, { signal, onProgress: (p) => onProgress?.({ done: p.done, total: p.total }) });
    return { binders, entries, readAt: Date.now() };
  }

  /** Reads the target account (its binders and whole collection) for a preview. Changes nothing. */
  async readTarget(accountKey: AccountKey): Promise<ReadTargetResult> {
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
      const state = await this.readState(await this.client(transport, abort.signal), abort.signal);
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

    try {
      const connected = await transport.connect();
      if (!connected.ok) {
        if (connected.code === 'wrong_account') throw new SiteWrongAccountError(connected.message, connected.as ?? null);
        throw new ExportStop(connected.message);
      }
      const client = await this.client(transport, signal, (message) => void patchOp(opId, { phase: message }).catch(() => {}));

      await save({ phase: `Reading ${name}'s binders and collection` });
      before = await this.readState(client, signal, (progress) => void patchOp(opId, { progress }).catch(() => {}));
      plan = planExport(target, items, before, { sourceAccountKey: req.sourceAccountKey, targetName: name, limits: exporter.limits });
      Object.assign(details, {
        targetLabel: plan.targetLabel,
        removed: plan.remove.entries,
        wholeCollection: plan.remove.wholeCollection,
        before: plan.before,
        after: plan.after,
        ...(plan.binder ? { binder: plan.binder } : {}),
      });
      await save({ title: exportTitle(target, plan.add, plan.targetLabel) });
      if (plan.blocked) throw new ExportStop(plan.blocked);
      if (plan.digest !== req.digest) throw new ExportStop(`${name}'s binders or collection changed since the preview, so nothing was changed. Open the preview again.`);

      const log = writeLogger(opId);
      let done = 0;
      const total = plan.writes;
      const write = async (op: Parameters<SiteClient['mutate']>[0], phase: string) => {
        if (signal.aborted) throw new CancelledError();
        await save({ phase, progress: { done, total } });
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
      for (const [i, op] of imports.entries()) await write(op, imports.length > 1 ? `Adding the cards (${i + 1}/${imports.length})` : 'Adding the cards');

      await save({ phase: 'Checking every copy', progress: { done, total } });
      const after = await readWholeCollection(this.site, client, { signal });
      details.verify = verifyExport(plan, before.entries, after, binderId);
      await save({ status: 'done', phase: details.verify.ok ? 'Done: every copy is there' : 'Done, with differences (see below)', finishedAt: Date.now() });
    } catch (e) {
      const cancelled = signal.aborted || e instanceof CancelledError;
      const wrong = e instanceof SiteWrongAccountError;
      keepOwnTab = e instanceof SiteAuthError || wrong;
      // Something was sent: read the collection again (reads only) so the log shows what was made.
      if (wrote && plan && before && !wrong) {
        try {
          const check = await this.client(transport);
          details.verify = verifyExport(plan, before.entries, await readWholeCollection(this.site, check), binderId);
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
