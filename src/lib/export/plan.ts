/**
 * What an export will do, computed from a live read of the target account (pure: the dialog's
 * preview and the background job compute the same plan, and compare digests).
 */
import type { AccountKey } from '@/lib/accounts/types';
import type { CollectionEntry } from '@/lib/cards/types';
import type { ExportItem, ExportPlan, ExportTarget, PlanWarning, RemovedEntry, TargetState } from './types';

/** Most rows in one import, and most entries removed in one request (the site's limits, see its exporter). */
export interface PlanLimits {
  importRows: number;
  removeEntries: number;
  pageSize: number;
}

export interface PlanContext {
  /** The account the cards come from (its comparison), if any. */
  sourceAccountKey: AccountKey | null;
  /** "alice" */
  targetName: string;
  limits: PlanLimits;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;

/** Merges items of the same print, drops empty ones. */
export function mergeItems(items: readonly ExportItem[]): ExportItem[] {
  const by = new Map<string, ExportItem>();
  for (const i of items) {
    if (!(i.qty > 0)) continue;
    const prev = by.get(i.key);
    by.set(i.key, prev ? { ...prev, qty: prev.qty + i.qty } : { ...i });
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
const chunks = (n: number, size: number) => (n > 0 ? Math.ceil(n / Math.max(1, size)) : 0);

export function planExport(target: ExportTarget, rawItems: readonly ExportItem[], state: TargetState, ctx: PlanContext): ExportPlan {
  const items = mergeItems(rawItems);
  const add = { prints: items.length, copies: copies(items) };
  const warnings: PlanWarning[] = [];
  const steps: string[] = [];
  const who = ctx.targetName;
  let blocked: string | undefined;
  let binder = null;
  let targetLabel: string;
  let toRemove: CollectionEntry[] = [];
  let wholeCollection = false;
  let before: number;

  if (target.kind === 'newBinder') {
    targetLabel = `the new binder “${target.name.trim()}”`;
    before = 0;
    if (!target.name.trim()) blocked = 'Give the new binder a name.';
    if (state.binders.some((b) => b.name.trim().toLowerCase() === target.name.trim().toLowerCase())) {
      warnings.push({ level: 'warning', text: `${who} already has a binder named “${target.name.trim()}”: a second one with the same name is created.` });
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
          text: `Binder cards are collection cards on this site: the ${plural(copies(inBinder), 'copy', 'copies')} now in ${targetLabel} are deleted from ${who}'s collection, not just taken out of the binder.`,
        });
      }
    }
  } else {
    targetLabel = `${who}'s collection`;
    before = copies(state.entries);
    if (target.mode === 'replace') {
      toRemove = state.entries;
      wholeCollection = true;
      if (state.entries.length) {
        steps.push(`Delete ${who}'s whole collection: ${plural(before, 'copy', 'copies')} in ${plural(state.entries.length, 'entry', 'entries')}, binders' cards included`);
        warnings.push({
          level: 'danger',
          text: `Every card of ${who}'s collection is deleted (${plural(before, 'copy', 'copies')}), including the cards in binders. Only the cards of this export are left.`,
        });
      }
    }
  }

  const imports = chunks(items.length, ctx.limits.importRows);
  if (items.length) {
    steps.push(
      `Add ${plural(add.copies, 'copy', 'copies')} (${plural(add.prints, 'print')}) to ${target.kind === 'collection' ? `${who}'s collection, not in a binder` : targetLabel}, Near Mint, English${imports > 1 ? `, in ${imports} imports` : ''}`,
    );
  } else {
    blocked ??= 'The cart is empty.';
  }
  steps.push(`Read ${who}'s collection again and check every copy`);

  if (ctx.sourceAccountKey && ctx.sourceAccountKey === target.accountKey) {
    warnings.push({
      level: 'warning',
      text: `${who} is the account you're comparing. Binder cards are collection cards, so the exported cards become part of its collection: “Missing from collection” cards stop being missing, and “Not in any deck” cards are then in it twice.`,
    });
  }

  const removeCopies = copies(toRemove);
  const after = target.kind === 'collection' ? (wholeCollection ? 0 : before) + add.copies : (target.kind === 'binder' && target.mode === 'replace' ? 0 : before) + add.copies;
  const writes =
    (target.kind === 'newBinder' ? 1 : 0) + (wholeCollection ? (toRemove.length ? 1 : 0) : chunks(toRemove.length, ctx.limits.removeEntries)) + imports;
  const reads = 2 * (1 + Math.max(1, chunks(state.entries.length + add.copies, ctx.limits.pageSize)));

  // What the run must find unchanged: the binders, and every entry it deletes.
  const digest = hash(
    JSON.stringify([
      target,
      items.map((i) => [i.key, i.qty]),
      state.binders.map((b) => b.id).sort(),
      toRemove.map((e) => [e.id, e.qty]).sort(),
    ]),
  );

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
    warnings,
    digest,
    ...(blocked ? { blocked } : {}),
  };
}
