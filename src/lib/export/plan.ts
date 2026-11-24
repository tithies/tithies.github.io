/**
 * What an export will do, computed from a live read of the target account (pure: the dialog's
 * preview and the background job compute the same plan, and compare digests).
 */
import type { AccountKey } from '@/lib/accounts/types';
import { copyKey } from '@/lib/cards/prints';
import type { CollectionEntry } from '@/lib/cards/types';
import type { ExportItem, ExportPlan, ExportTarget, PlanWarning, RemovedEntry, TargetRead, TargetState } from './types';

/** Most rows in one import, and most entries removed in one request (the site's limits, see its exporter). */
export interface PlanLimits {
  importRows: number;
  removeEntries: number;
  pageSize: number;
  /**
   * Items the site's import can't add as they are, added one request each instead (Moxfield: a
   * print in another language than English, whose CSV import would pick the English print).
   */
  oneByOne?: (item: ExportItem) => boolean;
}

export interface PlanContext {
  /** The account the cards come from (its comparison), if any. */
  sourceAccountKey: AccountKey | null;
  /** "alice" */
  targetName: string;
  limits: PlanLimits;
  /** Tithies has a recent snapshot of the target's collection: reading it again is usually one page (its changes). */
  savedCollection?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;

/**
 * What the preview must read: nothing more than the binder list for a new binder, the binder's
 * cards for an existing one, the collection's totals to add to it, the whole of it to replace it.
 */
export function previewRead(target: ExportTarget): TargetRead {
  if (target.kind === 'newBinder') return { kind: 'binders' };
  if (target.kind === 'binder') return { kind: 'binder', binderId: target.binderId };
  return target.mode === 'replace' ? { kind: 'collection' } : { kind: 'totals' };
}

/** What the export reads before changing anything: the preview's read, and the whole collection to add to it (the check compares every print). */
export function beforeRead(target: ExportTarget): TargetRead {
  return target.kind === 'collection' ? { kind: 'collection' } : previewRead(target);
}

/** What the check reads afterwards: the binder the cards went into, or the whole collection. */
export function afterRead(target: ExportTarget, binderId: string | null): TargetRead {
  return target.kind !== 'collection' && binderId ? { kind: 'binder', binderId } : { kind: 'collection' };
}

/** The state was read for this target (the dialog reads it before previewing). */
export function stateCovers(state: TargetState, read: TargetRead): boolean {
  const r = state.read;
  if (read.kind === 'binders') return true;
  if (read.kind === 'binder') return (r.kind === 'binder' && r.binderId === read.binderId) || r.kind === 'collection';
  if (read.kind === 'totals') return r.kind === 'totals' || r.kind === 'collection';
  return r.kind === 'collection';
}

/** Merges items of the same print in the same language (set + collector number + finish + language, whatever their list key), drops empty ones. */
export function mergeItems(items: readonly ExportItem[]): ExportItem[] {
  const by = new Map<string, ExportItem>();
  for (const i of items) {
    if (!(i.qty > 0)) continue;
    const key = copyKey(i.set, i.cn, i.finish, i.lang);
    const prev = by.get(key);
    by.set(key, prev ? { ...prev, qty: prev.qty + i.qty } : { ...i, key });
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

const removed = (e: CollectionEntry): RemovedEntry => ({
  entryId: e.id,
  cardId: e.card.id,
  name: e.card.name,
  set: e.card.set,
  cn: e.card.cn,
  finish: e.finish,
  qty: e.qty,
  condition: e.condition,
  lang: e.lang,
  isProxy: e.isProxy,
  isAlter: e.isAlter,
  ...(e.binderId ? { binderId: e.binderId } : {}),
});

/** FNV-1a, enough to notice a change between the preview and the run. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const copies = (entries: readonly { qty: number }[]) => entries.reduce((s, e) => s + e.qty, 0);

/** A target's fields in a fixed order (the digest doesn't depend on how the object was built). */
const targetFields = (t: ExportTarget) =>
  t.kind === 'newBinder' ? [t.accountKey, t.kind, t.name, t.visibility] : t.kind === 'binder' ? [t.accountKey, t.kind, t.binderId, t.mode] : [t.accountKey, t.kind, t.mode];
const chunks = (n: number, size: number) => (n > 0 ? Math.ceil(n / Math.max(1, size)) : 0);

export function planExport(target: ExportTarget, rawItems: readonly ExportItem[], state: TargetState, ctx: PlanContext): ExportPlan {
  const items = mergeItems(rawItems);
  const add = { prints: items.length, copies: copies(items) };
  const warnings: PlanWarning[] = [];
  const steps: string[] = [];
  const who = ctx.targetName;
  let blocked: string | undefined = stateCovers(state, previewRead(target)) ? undefined : `Read ${who}'s ${target.kind === 'binder' ? 'binder' : 'collection'} first.`;
  let binder = null;
  let targetLabel: string;
  let toRemove: CollectionEntry[] = [];
  let wholeCollection = false;
  let before: number;
  /** A new binder: the account already has a binder of that name. */
  let sameName = false;

  if (target.kind === 'newBinder') {
    targetLabel = `the new binder “${target.name.trim()}”`;
    before = 0;
    if (!target.name.trim()) blocked = 'Give the new binder a name.';
    sameName = state.binders.some((b) => b.name.trim().toLowerCase() === target.name.trim().toLowerCase());
    if (sameName) {
      warnings.push({ level: 'warning', text: `${who} already has a binder named “${target.name.trim()}”: a second one with the same name would be created.` });
    }
    steps.push(`Create the ${target.visibility} binder “${target.name.trim()}” on ${who}`);
  } else if (target.kind === 'binder') {
    binder = state.binders.find((b) => b.id === target.binderId) ?? null;
    targetLabel = binder ? `the binder “${binder.name}”` : 'a binder that no longer exists';
    if (!binder) blocked = `This binder isn't on ${who} any more: read the account again.`;
    const inBinder = state.entries.filter((e) => e.binderId === target.binderId);
    before = copies(inBinder);
    if (target.mode === 'replace') {
      toRemove = inBinder;
      if (inBinder.length) {
        steps.push(`Delete the ${plural(copies(inBinder), 'copy', 'copies')} (${plural(inBinder.length, 'entry', 'entries')}) now in ${targetLabel}`);
        warnings.push({
          level: 'danger',
          text: `Binder cards are collection cards on this site: if you confirm, the ${plural(copies(inBinder), 'copy', 'copies')} now in ${targetLabel} will be deleted from ${who}'s collection, not just taken out of the binder.`,
        });
      }
    }
  } else {
    targetLabel = `${who}'s collection`;
    before = state.read.kind === 'collection' ? copies(state.entries) : (state.totals?.copies ?? 0);
    if (target.mode === 'replace') {
      toRemove = state.entries;
      wholeCollection = true;
      if (state.entries.length) {
        steps.push(`Delete ${who}'s whole collection: ${plural(before, 'copy', 'copies')} in ${plural(state.entries.length, 'entry', 'entries')}, binders' cards included`);
        warnings.push({
          level: 'danger',
          text: `If you confirm, every card of ${who}'s collection will be deleted (${plural(before, 'copy', 'copies')}), including the cards in binders. Only the cards of this export would be left.`,
        });
      }
    }
  }

  const single = ctx.limits.oneByOne ? items.filter(ctx.limits.oneByOne).length : 0;
  const csvImports = chunks(items.length - single, ctx.limits.importRows);
  const imports = csvImports + single;
  if (items.length) {
    steps.push(
      `Add ${plural(add.copies, 'copy', 'copies')} (${plural(add.prints, 'print')}) to ${target.kind === 'collection' ? `${who}'s collection, not in a binder` : targetLabel}, Near Mint, each card in its language${csvImports > 1 ? `, in ${csvImports} imports` : ''}${single ? `; ${plural(single, 'print')} in another language than English one by one, to keep their exact print` : ''}`,
    );
  } else {
    blocked ??= 'Nothing to export.';
  }
  steps.push(target.kind === 'collection' ? `Read ${who}'s collection again and check every copy` : `Read the binder again and check every copy`);

  if (ctx.sourceAccountKey && ctx.sourceAccountKey === target.accountKey) {
    warnings.push({
      level: 'warning',
      text: `${who} is the account you're comparing. Binder cards are collection cards, so if you confirm, the exported cards will become part of its collection: “Missing from collection” cards would stop being missing, and “Not in any deck” cards would then be in it twice.`,
    });
  }

  const removeCopies = copies(toRemove);
  const after = target.kind === 'collection' ? (wholeCollection ? 0 : before) + add.copies : (target.kind === 'binder' && target.mode === 'replace' ? 0 : before) + add.copies;
  const writes =
    (target.kind === 'newBinder' ? 1 : 0) + (wholeCollection ? (toRemove.length ? 1 : 0) : chunks(toRemove.length, ctx.limits.removeEntries)) + imports;
  // The export's own reads: the binder list, then (before) what the target needs, and (after) the binder or the collection.
  const pages = (entries: number) => Math.max(1, chunks(entries, ctx.limits.pageSize));
  const collectionEntries = state.read.kind === 'collection' ? state.entries.length : (state.totals?.entries ?? 0);
  const targetEntries = target.kind === 'binder' ? state.entries.filter((e) => e.binderId === target.binderId).length : 0;
  // Before: the binder, or every page of the collection (only the changes since the saved snapshot when there is one).
  const beforePages = target.kind === 'newBinder' ? 0 : target.kind === 'binder' ? pages(targetEntries) : ctx.savedCollection ? 1 : pages(collectionEntries);
  // Check: the binder as it is after, or only the collection's changes since "before".
  const checkPages = target.kind === 'binder' ? pages((target.mode === 'replace' ? 0 : targetEntries) + items.length) : pages(items.length);
  const reads = 1 + beforePages + checkPages;

  // What the run must find unchanged: what the plan read of the binders (the binder targeted and
  // its name, or whether a binder has the new one's name), and every entry it deletes. Nothing
  // else: an export made just before to another binder of the account (several targets) doesn't
  // change this one.
  const binderFacts =
    target.kind === 'binder' ? (binder ? [binder.id, binder.name] : null) : target.kind === 'newBinder' ? sameName : null;
  const digest = hash(JSON.stringify([targetFields(target), items.map((i) => [i.key, i.qty]), binderFacts, toRemove.map((e) => [e.id, e.qty]).sort()]));

  return {
    target,
    binder,
    targetLabel,
    items,
    add,
    remove: { entries: toRemove.map(removed), copies: removeCopies, wholeCollection },
    before,
    after,
    steps,
    writes,
    reads,
    requests: { before: beforePages, write: writes, check: checkPages },
    warnings,
    digest,
    ...(blocked ? { blocked } : {}),
  };
}
