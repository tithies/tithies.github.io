/**
 * Background export of cards to accounts of a site (one export at a time per site; it shares the
 * site's lock with the deck sync). The account must be logged in on the site: every request is
 * made as it, and nothing is sent as anyone else.
 *
 * Several targets are several exports, started together and made one after another, each as if
 * made by hand after the one before: its own change-log row, its own read of the target, its own
 * check. The ones waiting are 'queued' in the log; a failure or a cancel of one doesn't stop the
 * others. The site's lock is held from the first to the last (no sync in between).
 *
 * Steps of each: read the target (binders + whole collection) and refuse if it changed since the
 * preview; make the changes (create the binder, or delete what a replace deletes; then add the
 * cards); read the collection again and check every copy. Every write is in the change log. A
 * write whose outcome is unknown stops the export (never sent twice); the collection is read
 * again anyway, so the log shows what was made.
 */
import { accountData, getAccount } from '@/lib/accounts/data';
import { accountLabel, identityOf, parseAccountKey, type AccountKey, type AccountRow } from '@/lib/accounts/types';
import { cancelQueuedOp, claimQueuedOp, getOp, patchOp, startOps, writeLogger, type NewChangeOp } from '@/lib/changes/log';
import { StepTally } from '@/lib/progress';
import type { CollectionEntry } from '@/lib/cards/types';
import { FULL_READ_EVERY_MS, readBinder, readCollection, readWholeCollection } from '@/lib/decks/collection';
import type { DeckCard } from '@/lib/decks/types';
import type { SyncTransport } from '@/lib/decks/job';
import { abortableSleep, CancelledError, describeSiteError, SiteAuthError, SiteClient, SiteWrongAccountError, type SiteClientOptions } from '@/lib/sites/client';
import type { SiteLock } from '@/lib/sites/lock';
import type { SiteProvider } from '@/lib/sites/provider';
import type { BinderVisibility, SiteIdentity } from '@/lib/sites/types';
import { batchIssues, MAX_EXPORT_TARGETS } from './batch';
import { exporterOf, type DeckHandle, type SiteExporter } from './exporters';
import { cleanGrouping, validGroup } from './grouping';
import { afterRead, beforeRead, mergeItems, planExport, previewRead } from './plan';
import { isDeckTarget, type DeckContent, type DeckPlan, type ExportDetails, type ExportItem, type ExportPlan, type ExportTarget, type ReadProgress, type TargetRead, type TargetState } from './types';
import { verifyDecks, verifyExport, type DeckCheck } from './verify';

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
/** `index`: the export refused (nothing was started: every export is checked first). */
export type StartExportsResult = { ok: true; opIds: number[] } | { ok: false; code: ExportFailCode; error: string; index?: number };

/** One target of an export, as previewed. */
export interface StartExportTarget {
  target: ExportTarget;
  /** The previewed plan's digest: nothing is changed when the target differs from what was previewed. */
  digest: string;
  /** The previewed plan's requests of each step, to size the progress before this run's own plan. */
  estimate?: ExportPlan['requests'];
  /** The preview's name of the target ('the binder “Trade”'): the row's title until its run reads the target. */
  label?: string;
}

/** The cards, and every target they go to (in the order they are exported). */
export interface StartExportsRequest {
  items: ExportItem[];
  /** The account whose page the cards come from (for the same-account warning). */
  sourceAccountKey: AccountKey | null;
  /** "Comparator of alice" */
  source: string;
  exports: StartExportTarget[];
}

/** One target: a single export. */
export interface StartExportRequest extends StartExportTarget {
  items: ExportItem[];
  sourceAccountKey: AccountKey | null;
  source: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Most decks one read asks the cards of. */
const MAX_READ_DECKS = 200;
const validRead = (r: unknown): r is TargetRead => {
  const x = r as TargetRead | null;
  if (x?.kind === 'decks') {
    const ids = x.publicIds;
    return ids === undefined || (Array.isArray(ids) && ids.length <= MAX_READ_DECKS && ids.every((id) => typeof id === 'string' && ID.test(id)));
  }
  return !!x && (x.kind === 'binders' || x.kind === 'totals' || x.kind === 'collection' || (x.kind === 'binder' && typeof x.binderId === 'string' && ID.test(x.binderId)));
};

const chunk = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += Math.max(1, size)) out.push(list.slice(i, i + Math.max(1, size)));
  return out;
};

/** Stops an export before anything is changed. */
class ExportStop extends Error {}

const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** The change log's one-line title of an export. */
export function exportTitle(target: ExportTarget, add: { prints: number; copies: number }, targetLabel: string): string {
  const what = `${plural(add.copies, 'copy', 'copies')} (${plural(add.prints, 'print')})`;
  if ((target.kind === 'binder' || target.kind === 'collection') && target.mode === 'replace') return `Replace ${targetLabel} with ${what}`;
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
        (i.lang === undefined || (str(i.lang, 8) && /^[a-z]{2,4}$/.test(i.lang))) &&
        (i.printLang === undefined || (str(i.printLang, 8) && /^[a-z]{0,4}$/.test(i.printLang))) &&
        typeof i.cardId === 'string' &&
        i.cardId.length <= 64 &&
        Number.isInteger(i.qty) &&
        i.qty >= 1 &&
        i.qty <= 10_000 &&
        (i.group === undefined || validGroup(i.group)),
    )
  );
}

const VISIBILITIES = new Set(['private', 'unlisted', 'public']);

/** A target from an extension page, rebuilt from its checked fields only (null when not valid). */
export function cleanTarget(t: unknown): ExportTarget | null {
  const x = t as Record<string, unknown> | null;
  if (!x || typeof x !== 'object' || !parseAccountKey(x.accountKey)) return null;
  const accountKey = x.accountKey as AccountKey;
  const mode = x.mode === 'add' || x.mode === 'replace' ? x.mode : null;
  if (x.kind === 'newBinder') {
    // The name as typed (the plan trims it where it uses it, and its digest has it as typed).
    const name = typeof x.name === 'string' && x.name.length <= 100 && x.name.trim() !== '' ? x.name : null;
    return name && VISIBILITIES.has(x.visibility as string) ? { accountKey, kind: 'newBinder', name, visibility: x.visibility as BinderVisibility } : null;
  }
  if (x.kind === 'binder') return mode && typeof x.binderId === 'string' && ID.test(x.binderId) ? { accountKey, kind: 'binder', binderId: x.binderId, mode } : null;
  if (x.kind === 'collection') return mode ? { accountKey, kind: 'collection', mode } : null;
  const visibility = VISIBILITIES.has(x.visibility as string) ? (x.visibility as BinderVisibility) : null;
  const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v);
  const folder = x.kind === 'newDeck' ? x.folderId : x.kind === 'newFolder' ? x.parentFolderId : null;
  if (folder !== null && folder !== undefined && !id(folder)) return null;
  if (x.kind === 'newDeck') {
    // The name as typed (a bound only: the plan refuses a name the site wouldn't take, and says why).
    const name = typeof x.name === 'string' && x.name.length <= 200 && x.name.trim() !== '' ? x.name : null;
    return name && visibility ? { accountKey, kind: 'newDeck', name, visibility, folderId: (folder as string | null | undefined) ?? null } : null;
  }
  if (x.kind === 'deck') return id(x.deckId) && id(x.publicId) ? { accountKey, kind: 'deck', deckId: x.deckId, publicId: x.publicId } : null;
  if (x.kind === 'newFolder' || x.kind === 'folder') {
    const grouping = cleanGrouping(x.grouping);
    if (!grouping || !visibility) return null;
    if (x.kind === 'folder') return id(x.folderId) ? { accountKey, kind: 'folder', folderId: x.folderId, visibility, grouping } : null;
    const name = typeof x.name === 'string' && x.name.length <= 100 && x.name.trim() !== '' ? x.name : null;
    return name ? { accountKey, kind: 'newFolder', name, parentFolderId: (folder as string | null | undefined) ?? null, visibility, grouping } : null;
  }
  return null;
}

const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
/** A previewed estimate, if it is one (it only sizes the progress). */
const cleanEstimate = (e: unknown): ExportPlan['requests'] | undefined => {
  const x = e as ExportPlan['requests'] | null;
  return x && typeof x === 'object' && count(x.before) && count(x.write) && count(x.check) ? { before: x.before, write: x.write, check: x.check } : undefined;
};

/** One export waiting for its turn (or running). */
interface Turn {
  opId: number;
  accountKey: AccountKey;
  exp: StartExportTarget;
  details: ExportDetails;
}

/** The exports started together: the one running (`current`) and those waiting (`queue`). */
interface Batch {
  items: ExportItem[];
  sourceAccountKey: AccountKey | null;
  exporter: SiteExporter;
  queue: Turn[];
  current: { opId: number; accountKey: AccountKey; abort: AbortController; done: Promise<void> } | null;
  /** Rows of waiting exports being marked cancelled: written before the batch ends. */
  pending: Promise<unknown>[];
  /** Everything was cancelled (possibly before the rows were written): no export of it starts any more. */
  stopped: boolean;
  /** Resolves once the batch has ended (from the moment it holds the site). */
  done: Promise<void>;
}

const NOT_STARTED = 'Cancelled before it started: nothing was changed.';

/** A deck a deck export wrote into (or created): its cards before (none for a new one). */
interface WrittenDeck {
  plan: DeckPlan;
  publicId: string;
  before: readonly DeckCard[];
}

export class ExportJob {
  private batch: Batch | null = null;
  private reading: { accountKey: AccountKey; abort: AbortController } | null = null;
  /** Preview reads, one after another (several dialogs or targets may ask at once). */
  private reads: Promise<void> = Promise.resolve();

  constructor(
    readonly site: SiteProvider,
    private deps: ExportJobDeps,
  ) {}

  /** The account being changed (or read for a preview). */
  get activeAccountKey(): AccountKey | null {
    return this.batch?.current?.accountKey ?? this.reading?.accountKey ?? null;
  }

  /** The export running now. */
  get activeOpId(): number | null {
    return this.batch?.current?.opId ?? null;
  }

  /** Resolves when the running exports (if any), and those waiting, have finished. */
  get finished(): Promise<void> {
    return this.batch?.done ?? Promise.resolve();
  }

  /**
   * Cancels exports: those of `opIds` (the running one stops before its next change, a waiting one
   * never starts; the others go on), or with no ids every export and the preview read.
   */
  cancel(opIds?: readonly number[]): boolean {
    const b = this.batch;
    if (!opIds) {
      let any = false;
      if (this.reading) {
        this.reading.abort.abort();
        any = true;
      }
      if (b) {
        b.stopped = true;
        for (const t of b.queue.splice(0)) b.pending.push(cancelQueuedOp(t.opId, NOT_STARTED).catch(() => {}));
        b.current?.abort.abort();
        any = true;
      }
      return any;
    }
    if (!b) return false;
    let any = false;
    for (const id of opIds) {
      if (b.current?.opId === id) {
        b.current.abort.abort();
        any = true;
        continue;
      }
      const at = b.queue.findIndex((t) => t.opId === id);
      if (at < 0) continue;
      b.queue.splice(at, 1);
      b.pending.push(cancelQueuedOp(id, NOT_STARTED).catch(() => {}));
      any = true;
    }
    return any;
  }

  /** Stops the preview read (an export dialog closed while it read). */
  cancelRead(): boolean {
    if (!this.reading) return false;
    this.reading.abort.abort();
    return true;
  }

  /**
   * Stops everything working for one account (it is being forgotten): its waiting exports never
   * start, its running one (or preview read) is cancelled. Exports to other accounts go on.
   * Resolves once its running export has stopped.
   */
  async stopAccount(key: AccountKey): Promise<void> {
    if (this.reading?.accountKey === key) this.reading.abort.abort();
    const b = this.batch;
    if (!b) return;
    for (const t of b.queue.filter((q) => q.accountKey === key)) {
      b.queue.splice(b.queue.indexOf(t), 1);
      b.pending.push(cancelQueuedOp(t.opId, NOT_STARTED).catch(() => {}));
    }
    const cur = b.current;
    if (cur?.accountKey === key) {
      cur.abort.abort();
      await cur.done;
    }
    await Promise.allSettled(b.pending);
  }

  private busy(): string {
    const label = this.site.label;
    if (this.deps.lock.heldBy === 'sync') return `Tithies is syncing ${label} decks or a collection: wait for it to finish (or cancel it), then try again.`;
    if (this.batch) {
      const waiting = this.batch.queue.length;
      return `An export to ${label} is running${waiting ? ` (${plural(waiting, 'more')} waiting)` : ''}: wait for it to finish.`;
    }
    return `Tithies is reading a ${label} account for an export preview: wait for it to finish.`;
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
    if (read.kind === 'decks') {
      // The deck list and the folders, then each deck asked for (no binders: deck targets don't need them).
      const ids = read.publicIds ?? [];
      const total = 2 + ids.length;
      onProgress?.({ done: 0, total });
      const decks = await client.deckList();
      onProgress?.({ done: 1, total });
      const folders = await client.deckFolders();
      onProgress?.({ done: 2, total });
      const deckCards = await this.readDecks(client, ids, (done) => onProgress?.({ done: 2 + done, total }));
      return { binders: [], read, entries: [], totals: null, decks, folders, deckCards, readAt: Date.now() };
    }
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

  /** The cards of these decks (and what a change of each must send), by publicId. */
  private async readDecks(client: SiteClient, publicIds: readonly string[], onDone?: (done: number) => void): Promise<Record<string, DeckContent>> {
    const out: Record<string, DeckContent> = {};
    for (const [i, publicId] of publicIds.entries()) {
      const d = await client.deck(publicId);
      out[publicId] = { id: d.id ?? null, version: d.version ?? null, lastUpdatedAt: d.lastUpdatedAt, tooBig: d.tooBig === true, cards: d.cards };
      onDone?.(i + 1);
    }
    return out;
  }

  /** Each deck written, read again (for the check). */
  private async checkDecks(client: SiteClient, written: readonly WrittenDeck[], onProgress?: (p: ReadProgress) => void): Promise<DeckCheck[]> {
    const out: DeckCheck[] = [];
    for (const [i, w] of written.entries()) {
      onProgress?.({ done: i, total: written.length });
      const after = await client.deck(w.publicId);
      out.push({ name: w.plan.name, plan: w.plan, before: w.before, after: after.cards });
    }
    onProgress?.({ done: written.length, total: written.length });
    return out;
  }

  /** Reads the target account for a preview (what `read` says), after the reads asked before. Changes nothing. */
  async readTarget(accountKey: AccountKey, read: TargetRead = { kind: 'binders' }, onProgress?: (p: ReadProgress) => void): Promise<ReadTargetResult> {
    if (!validRead(read)) return { ok: false, code: 'bad_request', error: 'Unknown read.' };
    const before = this.reads;
    let done!: () => void;
    this.reads = new Promise<void>((r) => (done = r));
    try {
      await before;
      return await this.readNow(accountKey, read, onProgress);
    } finally {
      done();
    }
  }

  private async readNow(accountKey: AccountKey, read: TargetRead, onProgress?: (p: ReadProgress) => void): Promise<ReadTargetResult> {
    const row = await this.account(accountKey);
    if (!row) return { ok: false, code: 'no_account', error: `This ${this.site.label} account isn't in Tithies any more.` };
    // No await between the check and the claim: nothing else can start in between.
    if (this.batch || this.reading || !this.deps.lock.tryAcquire('export')) return { ok: false, code: 'busy', error: this.busy() };
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

  /** Starts one export (see startMany); answers once it is in the change log. */
  async start(req: StartExportRequest): Promise<StartExportResult> {
    const r = req as Partial<StartExportRequest> | null;
    const res = await this.startMany({
      items: r?.items as ExportItem[],
      sourceAccountKey: r?.sourceAccountKey ?? null,
      source: r?.source as string,
      exports: [{ target: r?.target as ExportTarget, digest: r?.digest as string, estimate: r?.estimate, label: r?.label }],
    });
    return res.ok ? { ok: true, opId: res.opIds[0] } : { ok: false, code: res.code, error: res.error };
  }

  /**
   * Starts the exports of the same cards to each target, one after another in the order given.
   * Every one is checked first (nothing starts if one is refused), then each gets its change-log
   * row: the first running, the others waiting. Answers once they are in the log (progress: the rows).
   */
  async startMany(req: StartExportsRequest): Promise<StartExportsResult> {
    const label = this.site.label;
    const exporter = exporterOf(this.site.type);
    if (!exporter) return { ok: false, code: 'unsupported', error: `Tithies can't export to ${label}.` };
    const list: unknown = req?.exports;
    if (!Array.isArray(list) || !list.length || list.length > MAX_EXPORT_TARGETS || !validItems(req.items)) return { ok: false, code: 'bad_request', error: 'Nothing valid to export.' };
    const sourceAccountKey = parseAccountKey(req.sourceAccountKey) ? req.sourceAccountKey : null;
    const source = typeof req.source === 'string' ? req.source.slice(0, 200) : '';
    const caps = this.site.capabilities.exportTo;

    const checked: { exp: StartExportTarget; row: AccountRow }[] = [];
    for (const [index, e] of (list as Partial<StartExportTarget>[]).entries()) {
      const target = cleanTarget(e?.target);
      if (!target || typeof e?.digest !== 'string') return { ok: false, code: 'bad_request', error: 'This target is not valid.', index };
      if (isDeckTarget(target)) {
        if (!caps.decks || !exporter.decks) return { ok: false, code: 'unsupported', error: `Tithies can't export to ${label} decks.`, index };
      } else if (target.kind !== 'collection' && !caps.binders) return { ok: false, code: 'unsupported', error: `${label} has no binders.`, index };
      if (target.kind === 'collection' && !caps.collection) return { ok: false, code: 'unsupported', error: `Tithies can't export into a ${label} collection.`, index };
      const row = await this.account(target.accountKey);
      if (!row) return { ok: false, code: 'no_account', error: `This ${label} account isn't in Tithies any more.`, index };
      const hint = typeof e.label === 'string' && e.label.length <= 200 ? e.label : undefined;
      checked.push({ exp: { target, digest: e.digest, estimate: cleanEstimate(e.estimate), label: hint }, row });
    }
    const conflict = batchIssues(checked.map((c) => c.exp.target)).find((i) => i.level === 'error');
    if (conflict) return { ok: false, code: 'bad_request', error: conflict.text, index: conflict.index };
    // No await between the check and the claim: nothing else can start in between.
    if (this.batch || this.reading || !this.deps.lock.tryAcquire('export')) return { ok: false, code: 'busy', error: this.busy() };

    const items = mergeItems(req.items);
    const add = { prints: items.length, copies: items.reduce((s, i) => s + i.qty, 0) };
    let ended!: () => void;
    const batch: Batch = { items, sourceAccountKey, exporter, queue: [], current: null, pending: [], stopped: false, done: new Promise<void>((r) => (ended = r)) };
    this.batch = batch;
    const turns = checked.map(({ exp, row }): { turn: Omit<Turn, 'opId'>; op: NewChangeOp } => {
      const t = exp.target;
      const name = accountLabel(row);
      const details: ExportDetails = {
        target: t,
        targetLabel:
          t.kind === 'collection'
            ? `${name}'s collection`
            : t.kind === 'newBinder'
              ? `the new binder “${t.name}”`
              : t.kind === 'newDeck'
                ? `the new deck “${t.name}”`
                : (exp.label ?? (t.kind === 'binder' ? 'a binder' : t.kind === 'deck' ? 'a deck' : 'a folder')),
        sourceAccountKey,
        items,
        add,
        removed: [],
        wholeCollection: false,
        before: 0,
        after: 0,
      };
      return {
        turn: { accountKey: row.key, exp, details },
        op: {
          site: this.site.type,
          accountKey: row.key,
          userName: row.userName,
          kind: 'export',
          title: exportTitle(t, add, details.targetLabel),
          source,
          phase: `Connecting to ${label} as ${name}`,
          details,
        },
      };
    });
    let opIds: number[];
    try {
      opIds = await startOps(turns.map((t, i) => (i === 0 ? t.op : { ...t.op, phase: 'Waiting for the export before it to finish' })));
    } catch (e) {
      this.batch = null;
      this.deps.lock.release('export');
      ended();
      return { ok: false, code: 'error', error: describeSiteError(e) };
    }
    batch.queue = turns.map((t, i) => ({ ...t.turn, opId: opIds[i] }));
    this.deps.onActiveChange?.(true);
    void this.drain(batch).finally(ended);
    return { ok: true, opIds };
  }

  /** Makes the batch's exports, one after another, until none is left; then frees the site. */
  private async drain(b: Batch): Promise<void> {
    try {
      for (let first = true; b.queue.length; first = false) {
        const turn = b.queue.shift()!;
        const abort = new AbortController();
        // Cancelled as a whole while its rows were being written.
        if (b.stopped) abort.abort();
        const current = { opId: turn.opId, accountKey: turn.accountKey, abort, done: Promise.resolve() };
        b.current = current;
        current.done = this.turn(b, turn, abort, first);
        await current.done;
        b.current = null;
      }
    } finally {
      await Promise.allSettled(b.pending);
      if (this.batch === b) this.batch = null;
      this.deps.lock.release('export');
      this.deps.onActiveChange?.(false);
    }
  }

  /** One export of the batch: waits a request's gap after the one before, claims its row, runs. Never throws. */
  private async turn(b: Batch, turn: Turn, abort: AbortController, first: boolean): Promise<void> {
    try {
      if (abort.signal.aborted) {
        // Nothing sent for it: the first one's row says running already, the others' queued.
        if (first) await patchOp(turn.opId, { status: 'cancelled', error: NOT_STARTED, phase: undefined, finishedAt: Date.now() });
        else await cancelQueuedOp(turn.opId, NOT_STARTED);
        return;
      }
      if (!first) {
        // A new client starts without the previous one's pace: keep the gap between their requests.
        const opts = { ...this.site.pacing, ...((await this.deps.clientOptions?.()) ?? {}) };
        if (opts.intervalMs > 0) await (opts.sleep ?? abortableSleep)(opts.intervalMs, abort.signal).catch(() => {});
        if (abort.signal.aborted) {
          await cancelQueuedOp(turn.opId, NOT_STARTED);
          return;
        }
      }
      // Cancelled, or deleted (its account forgotten, the log cleared) while it waited: it doesn't run.
      if (!(await claimQueuedOp(turn.opId))) return;
      const row = await this.account(turn.accountKey);
      if (!row) {
        await patchOp(turn.opId, { status: 'failed', error: `This ${this.site.label} account isn't in Tithies any more. Nothing was changed.`, phase: undefined, finishedAt: Date.now() });
        return;
      }
      await this.run(turn.opId, row, turn.exp, b.sourceAccountKey, b.items, turn.details, b.exporter, abort);
    } catch (e) {
      // run() reports its own failures: this is something unexpected around it.
      await patchOp(turn.opId, { status: 'failed', error: describeSiteError(e), phase: undefined, finishedAt: Date.now() }).catch(() => {});
    }
  }

  private async run(
    opId: number,
    row: AccountRow,
    exp: StartExportTarget,
    sourceAccountKey: AccountKey | null,
    items: ExportItem[],
    details: ExportDetails,
    exporter: SiteExporter,
    abort: AbortController,
  ): Promise<void> {
    const { signal } = abort;
    const { label } = this.site;
    const name = accountLabel(row);
    const target = exp.target;
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
    /** Deck targets: each deck written so far (the check reads them again). */
    const written: WrittenDeck[] = [];
    const save = (p: Parameters<typeof patchOp>[1]) => patchOp(opId, { ...p, details }).catch(() => {});
    // One progress over the three steps: read the target, send the changes, check.
    const [BEFORE, WRITE, CHECK] = [0, 1, 2];
    const est = exp.estimate;
    const tally = new StepTally([est?.before ?? 1, est?.write ?? 1, est?.check ?? 1]);
    const readProgress = (step: number, phase?: string) => (p: ReadProgress) =>
      void patchOp(opId, { ...(phase ? { phase } : {}), progress: { ...p, unit: 'page' }, overall: tally.report(step, p.done, p.total) }).catch(() => {});
    const ctx = { sourceAccountKey, targetName: name, limits: exporter.limits };

    const log = writeLogger(opId);
    let client: SiteClient | null = null;
    let done = 0;
    let total = 0;
    const write = async (op: Parameters<SiteClient['mutate']>[0], phase: string) => {
      if (signal.aborted) throw new CancelledError();
      await save({ phase, progress: { done, total, unit: 'change' }, overall: tally.report(WRITE, done, total) });
      wrote = true;
      const res = await client!.mutate(op, log);
      done++;
      if (res.imported) {
        const prev = details.imported ?? { count: 0, errors: [], failed: 0 };
        details.imported = { count: prev.count + res.imported.count, errors: [...prev.errors, ...res.imported.errors].slice(0, 200), failed: prev.failed + (res.imported.ok ? 0 : 1) };
      }
      return res;
    };
    /** The plan made from the read just before the changes: kept in the row, then checked against the preview. */
    const adopt = async (p: ExportPlan, changed: string) => {
      plan = p;
      Object.assign(details, {
        targetLabel: p.targetLabel,
        removed: p.remove.entries,
        wholeCollection: p.remove.wholeCollection,
        before: p.before,
        after: p.after,
        ...(p.binder ? { binder: p.binder } : {}),
      });
      total = p.writes;
      tally.expect(WRITE, p.writes);
      tally.expect(CHECK, p.requests.check);
      await save({ title: exportTitle(target, p.add, p.targetLabel), overall: tally.overall });
      if (p.blocked) throw new ExportStop(p.blocked);
      if (p.digest !== exp.digest) throw new ExportStop(`${name}'s ${changed} changed since the preview, so nothing was changed. Open the preview again.`);
    };

    try {
      const connected = await transport.connect();
      if (!connected.ok) {
        if (connected.code === 'wrong_account') throw new SiteWrongAccountError(connected.message, connected.as ?? null);
        throw new ExportStop(connected.message);
      }
      client = await this.client(transport, signal, (message) => void patchOp(opId, { phase: message }).catch(() => {}));

      if (isDeckTarget(target)) {
        const decks = exporter.decks;
        const lim = exporter.limits.deck;
        if (!decks || !lim) throw new ExportStop(`Tithies can't export to ${label} decks.`);
        await save({ phase: `Reading ${name}'s decks and folders`, progress: undefined, overall: tally.report(BEFORE, 0, 0) });
        let state = await this.readState(client, previewRead(target), signal, readProgress(BEFORE));
        let p = planExport(target, items, state, ctx);
        // The decks of the folder it adds to: their cards (and versions), for the check.
        const more = (p.decks ?? []).flatMap((d) => (d.existing && !state.deckCards?.[d.existing.publicId] ? [d.existing.publicId] : []));
        if (more.length) {
          const read = state.read.kind === 'decks' ? (state.read.publicIds ?? []) : [];
          const cards = await this.readDecks(client, more, (k) => readProgress(BEFORE)({ done: 2 + read.length + k, total: 2 + read.length + more.length }));
          state = { ...state, read: { kind: 'decks', publicIds: [...read, ...more] }, deckCards: { ...state.deckCards, ...cards } };
          p = planExport(target, items, state, ctx);
        }
        before = state;
        await adopt(p, 'decks or folders');

        let folderId: string | null = target.kind === 'newDeck' ? target.folderId : target.kind === 'folder' ? target.folderId : null;
        if (p.folder?.create) {
          const res = await write(decks.createFolder(p.folder.path), `Creating the folder “${p.folder.path}”`);
          if (!res.folder) throw new Error(`${label} didn't say which folder it created.`);
          folderId = res.folder.id;
          details.folder = { id: res.folder.id, path: res.folder.path || p.folder.path };
        } else if (p.folder?.id) details.folder = { id: p.folder.id, path: p.folder.path };
        details.decks = [];
        const visibility = target.kind === 'deck' ? 'private' : target.visibility;
        const all = p.decks ?? [];
        for (const [k, d] of all.entries()) {
          const of = all.length > 1 ? ` (${k + 1}/${all.length})` : '';
          const byText = d.items.filter((i) => !lim.oneByOne(i));
          const byId = d.items.filter(lim.oneByOne);
          let parts = chunk(byText, lim.importLines);
          let handle: { id: string | null; publicId: string; version: number | null };
          if (d.existing) {
            const c = state.deckCards?.[d.existing.publicId];
            handle = { id: c?.id ?? d.existing.id, publicId: d.existing.publicId, version: c?.version ?? null };
            written.push({ plan: d, publicId: d.existing.publicId, before: c?.cards ?? [] });
            details.decks.push({ name: d.name, publicId: d.existing.publicId, created: false });
          } else {
            const res = await write(decks.createDeck(d.name, visibility, folderId, parts[0] ?? []), `Creating the deck “${d.name}”${of}`);
            if (!res.deck?.publicId) throw new Error(`${label} didn't say which deck it created.`);
            handle = { id: res.deck.id ?? null, publicId: res.deck.publicId, version: res.deck.version ?? null };
            written.push({ plan: d, publicId: res.deck.publicId, before: [] });
            details.decks.push({ name: d.name, publicId: res.deck.publicId, created: true });
            parts = parts.slice(1);
          }
          await save({});
          /** The deck's id and current version, read again when the last answer didn't say. */
          const ready = async (): Promise<DeckHandle> => {
            if (!handle.id || handle.version == null) {
              const now = await client!.deck(handle.publicId);
              handle = { id: now.id ?? handle.id, publicId: handle.publicId, version: now.version ?? null };
            }
            if (!handle.id || handle.version == null) throw new Error(`${label} didn't say the version of the deck “${d.name}”, so Tithies can't change it.`);
            return { id: handle.id, publicId: handle.publicId, version: handle.version };
          };
          for (const part of parts) {
            const res = await write(decks.importIntoDeck(await ready(), part), `Adding the cards to “${d.name}”${of}`);
            handle = { ...handle, id: res.deck?.id ?? handle.id, version: res.deck?.version ?? null };
          }
          for (const i of byId) {
            const res = await write(decks.addToDeck(await ready(), i), `Adding ${i.name} to “${d.name}”${of}`);
            handle = { ...handle, id: res.deck?.id ?? handle.id, version: res.deck?.version ?? null };
          }
        }
        tally.report(WRITE, done, total);
        await save({
          phase: written.length > 1 ? 'Checking every copy in the decks' : 'Checking every copy in the deck',
          progress: { done: 0, total: written.length, unit: 'page' },
          overall: tally.report(CHECK, 0, 0),
        });
        details.verify = verifyDecks(await this.checkDecks(client, written, readProgress(CHECK)));
        await save({ status: 'done', phase: details.verify.ok ? 'Done: every copy is there' : 'Done, with differences (see below)', overall: tally.finish(), finishedAt: Date.now() });
        return;
      }

      const first = beforeRead(target);
      await save({
        phase: first.kind === 'collection' ? `Reading ${name}'s collection` : first.kind === 'binder' ? `Reading ${name}'s binders and the binder's cards` : `Reading ${name}'s binders`,
        progress: undefined,
        overall: tally.report(BEFORE, 0, 0),
      });
      const saved = first.kind === 'collection' ? await this.savedCollection(row.key) : null;
      const state = await this.readState(client, first, signal, readProgress(BEFORE), saved);
      before = state;
      const p = planExport(target, items, state, ctx);
      await adopt(p, 'binders or collection');

      if (target.kind === 'newBinder') {
        const res = await write(exporter.createBinder(target.name, target.visibility), `Creating the binder “${target.name.trim()}”`);
        if (!res.binder) throw new Error(`${label} didn't say which binder it created.`);
        binderId = res.binder.id;
        details.binder = res.binder;
      }
      if (p.remove.entries.length) {
        if (p.remove.wholeCollection) await write(exporter.deleteCollection(), `Deleting ${name}'s collection`);
        else for (const op of exporter.removeEntries(p.remove.entries.map((e) => e.entryId))) await write(op, `Deleting the cards in ${p.targetLabel}`);
      }
      const imports = exporter.importItems(p.items, binderId);
      for (const [i, op] of imports.entries()) await write(op, imports.length > 1 ? `Adding the cards (${i + 1}/${imports.length})` : 'Adding the cards');

      tally.report(WRITE, done, total);
      const last = afterRead(target, binderId);
      await save({
        phase: last.kind === 'binder' ? 'Checking every copy in the binder' : `Checking every copy in ${name}'s collection`,
        progress: { done: 0, total: 1, unit: 'page' },
        overall: tally.report(CHECK, 0, 0),
      });
      // The check builds on the read just made: only the changes since are read (the totals tell if anything else changed).
      const checkBase = last.kind === 'collection' ? (p.remove.wholeCollection ? [] : state.entries) : null;
      const after = await this.readState(client, last, signal, readProgress(CHECK), checkBase);
      details.verify = verifyExport(p, state.entries, after.entries, binderId);
      await save({ status: 'done', phase: details.verify.ok ? 'Done: every copy is there' : 'Done, with differences (see below)', overall: tally.finish(), finishedAt: Date.now() });
    } catch (e) {
      const cancelled = signal.aborted || e instanceof CancelledError;
      const wrong = e instanceof SiteWrongAccountError;
      keepOwnTab = e instanceof SiteAuthError || wrong;
      // Something was sent: read the target again (reads only) so the log shows what was made.
      const made = plan as ExportPlan | null;
      const was = before as TargetState | null;
      if (wrote && made && was && !wrong) {
        try {
          const check = await this.client(transport);
          if (isDeckTarget(target)) {
            details.verify = verifyDecks(await this.checkDecks(check, written, readProgress(CHECK, 'Checking what was made')));
          } else {
            const lastRead = afterRead(target, binderId);
            const after = await this.readState(
              check,
              lastRead,
              undefined,
              readProgress(CHECK, 'Checking what was made'),
              lastRead.kind === 'collection' ? (made.remove.wholeCollection ? [] : was.entries) : null,
            );
            details.verify = verifyExport(made, was.entries, after.entries, binderId);
          }
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
