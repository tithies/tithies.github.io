/** The export dialog's targets, as the user edits them (pure helpers). */
import type { AccountKey } from '@/lib/accounts/types';
import type { BinderVisibility, SiteBinder } from '@/lib/sites/types';
import { stateCovers } from '../plan';
import type { ExportMode, ExportTarget, TargetRead, TargetState } from '../types';

/** One target being chosen: every field kept, whichever kind is picked (switching back keeps them). */
export interface TargetDraft {
  /** Stable while the dialog lives (React key, typed confirmation). */
  id: number;
  accountKey: AccountKey | null;
  kind: ExportTarget['kind'];
  binderName: string;
  visibility: BinderVisibility;
  binderId: string | null;
  mode: ExportMode;
}

/** "Tithies export 2026-11-24", then "… (2)", "… (3)" for the names other targets already use. */
export function defaultBinderName(date: string, taken: readonly string[]): string {
  const base = `Tithies export ${date}`;
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
}

/** A new target: a new binder, on `accountKey`, named apart from the other targets' new binders. */
export function newDraft(id: number, accountKey: AccountKey | null, others: readonly TargetDraft[], date: string): TargetDraft {
  const taken = others.filter((d) => d.kind === 'newBinder' && d.accountKey === accountKey).map((d) => d.binderName);
  return { id, accountKey, kind: 'newBinder', binderName: defaultBinderName(date, taken), visibility: 'private', binderId: null, mode: 'add' };
}

/** The target a draft describes, or null while it misses something (an account, a binder). */
export function draftTarget(d: TargetDraft): ExportTarget | null {
  const { accountKey } = d;
  if (!accountKey) return null;
  if (d.kind === 'newBinder') return { accountKey, kind: 'newBinder', name: d.binderName, visibility: d.visibility };
  if (d.kind === 'binder') return d.binderId ? { accountKey, kind: 'binder', binderId: d.binderId, mode: d.mode } : null;
  return { accountKey, kind: 'collection', mode: d.mode };
}

/** The newest state read that covers `need` (an account's states, oldest first). */
export function pickState(states: readonly TargetState[] | undefined, need: TargetRead): TargetState | null {
  for (let i = (states?.length ?? 0) - 1; i >= 0; i--) if (stateCovers(states![i], need)) return states![i];
  return null;
}

/** The account's binders as last read (null: not read yet). */
export const latestBinders = (states: readonly TargetState[] | undefined): SiteBinder[] | null => (states?.length ? states[states.length - 1].binders : null);
