/**
 * Several targets in one export: each is exported on its own, as if exported by hand one after
 * the other (its own preview, change-log row and check). Pure: the dialog and the background job
 * check the same rules.
 */
import type { ExportTarget } from './types';

/** Most targets in one export. */
export const MAX_EXPORT_TARGETS = 10;

export interface BatchIssue {
  /** The target concerned (its index in the list). */
  index: number;
  /** error: can't be exported with the others; warning: worth knowing. */
  level: 'error' | 'warning';
  text: string;
}

const nameKey = (name: string) => name.trim().toLowerCase();
const replacesCollection = (t: ExportTarget) => t.kind === 'collection' && t.mode === 'replace';
const replacesBinder = (t: ExportTarget) => t.kind === 'binder' && t.mode === 'replace';

/** Where a target's cards go, to find the same destination twice. */
function destination(t: ExportTarget): string {
  if (t.kind === 'collection') return `${t.accountKey}|collection`;
  if (t.kind === 'binder') return `${t.accountKey}|binder|${t.binderId}`;
  return `${t.accountKey}|new|${nameKey(t.name)}`;
}

/**
 * What stops targets from being exported together, and what is worth knowing:
 * - the same destination twice (the collection, a binder, or two new binders of the same name);
 * - replacing a whole collection with another target on that account (one would delete or change
 *   the other's cards);
 * - two targets on one account: binder cards are collection cards, so the collection gets the
 *   cards once per target.
 */
export function batchIssues(targets: readonly ExportTarget[]): BatchIssue[] {
  const issues: BatchIssue[] = [];
  if (targets.length > MAX_EXPORT_TARGETS) issues.push({ index: MAX_EXPORT_TARGETS, level: 'error', text: `At most ${MAX_EXPORT_TARGETS} targets in one export.` });
  const firstAt = new Map<string, number>();
  const perAccount = new Map<string, number[]>();
  targets.forEach((t, i) => perAccount.set(t.accountKey, [...(perAccount.get(t.accountKey) ?? []), i]));
  targets.forEach((t, i) => {
    const dest = destination(t);
    const first = firstAt.get(dest);
    if (first === undefined) firstAt.set(dest, i);
    else {
      const what = t.kind === 'collection' ? 'the same collection' : t.kind === 'binder' ? 'the same binder' : 'a new binder with the same name';
      issues.push({ index: i, level: 'error', text: `Target ${first + 1} already exports to ${what}.` });
      return;
    }
    const others = (perAccount.get(t.accountKey) ?? []).filter((j) => j !== i);
    if (!others.length) return;
    const replacer = others.find((j) => replacesCollection(targets[j]));
    if (replacesCollection(t)) {
      issues.push({ index: i, level: 'error', text: "Replacing the whole collection can't be combined with another target on the same account: export it on its own." });
    } else if (replacer !== undefined) {
      issues.push({ index: i, level: 'error', text: `Target ${replacer + 1} replaces this account's whole collection: export it on its own.` });
    } else if (others[0] < i) {
      issues.push({
        index: i,
        level: 'warning',
        text: `Target ${others[0] + 1} is on the same account. Binder cards are collection cards, so that collection gets the cards once per target.`,
      });
    }
  });
  return issues;
}

/**
 * The order the targets are exported in (indices): the list's, except that binder replaces go
 * first. A replace then deletes exactly the cards previewed (an export to the same account made
 * before it could otherwise change them, and so refuse it).
 */
export function runOrder(targets: readonly ExportTarget[]): number[] {
  const idx = targets.map((_, i) => i);
  return [...idx.filter((i) => replacesBinder(targets[i])), ...idx.filter((i) => !replacesBinder(targets[i]))];
}
