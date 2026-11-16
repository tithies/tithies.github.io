/**
 * Exporting cards to an account of a site, as a binder or into its collection. Site-neutral:
 * pages build ExportItems (the export list), the dialog previews an ExportPlan from a live read of the
 * target, and the background ExportJob makes the changes and checks them.
 */
import type { AccountKey } from '@/lib/accounts/types';
import type { CollectionEntry, Finish } from '@/lib/cards/types';
import type { BinderVisibility, SiteBinder } from '@/lib/sites/types';

/** One print to export, with how many copies. */
export interface ExportItem {
  /** printKey (set|cn|finish). */
  key: string;
  /** The site's card id, when known. */
  cardId: string;
  scryfallId: string;
  name: string;
  set: string;
  setName: string;
  cn: string;
  finish: Finish;
  qty: number;
  /** Where the item came from ("Missing from collection"…). */
  note?: string;
}

export type ExportMode = 'replace' | 'add';

export type ExportTarget =
  | { accountKey: AccountKey; kind: 'newBinder'; name: string; visibility: BinderVisibility }
  | { accountKey: AccountKey; kind: 'binder'; binderId: string; mode: ExportMode }
  | { accountKey: AccountKey; kind: 'collection'; mode: ExportMode };

/**
 * What is read from the target account: its binder list only, plus one binder's cards, or the
 * collection's totals (one page), or the whole collection. Each step reads only what it needs.
 */
export type TargetRead = { kind: 'binders' } | { kind: 'binder'; binderId: string } | { kind: 'totals' } | { kind: 'collection' };

/** What the target account has: read live for the preview, again before changing anything, and after. */
export interface TargetState {
  binders: SiteBinder[];
  read: TargetRead;
  /** The entries read: the binder's, or the whole collection's (none for 'binders' and 'totals'). */
  entries: CollectionEntry[];
  /** The whole collection's size ('totals' and 'collection' reads). */
  totals: { entries: number; copies: number } | null;
  readAt: number;
}

/** A read in progress: pages of the collection (or binder) read so far. */
export interface ReadProgress {
  done: number;
  total: number;
}

/** A collection entry the export deletes, kept whole in the log (to put it back by hand). */
export interface RemovedEntry {
  entryId: string;
  cardId: string;
  name: string;
  set: string;
  cn: string;
  finish: Finish;
  qty: number;
  condition: string;
  lang: string;
  isProxy: boolean;
  isAlter: boolean;
  binderId?: string;
}

export interface PlanWarning {
  level: 'danger' | 'warning' | 'info';
  text: string;
}

export interface ExportPlan {
  target: ExportTarget;
  /** The binder targeted (existing), or null. */
  binder: SiteBinder | null;
  /** Shown in titles: 'the binder “To buy”', 'the collection'. */
  targetLabel: string;
  items: ExportItem[];
  add: { prints: number; copies: number };
  remove: { entries: RemovedEntry[]; copies: number; wholeCollection: boolean };
  /** Copies in the target (binder, or whole collection) now, and expected after. */
  before: number;
  after: number;
  steps: string[];
  /** Writes the export makes, and reads (before and after). */
  writes: number;
  reads: number;
  warnings: PlanWarning[];
  /** Fingerprint of what the plan depends on: the job refuses to run if it changed since the preview. */
  digest: string;
  /** Set when the export can't be made (e.g. the binder is gone). */
  blocked?: string;
}

/** One print whose copies differ from what the export expected. */
export interface VerifyDiff {
  key: string;
  name: string;
  set: string;
  cn: string;
  finish: Finish;
  /** In the target (binder or collection) unless `outside`. */
  expected: number;
  found: number;
  /** A print outside what the export touches (or outside the binder) changed. */
  outside?: boolean;
}

export interface ExportVerification {
  ok: boolean;
  /** What was compared: the binder's cards only, or the whole collection. */
  scope: 'binder' | 'collection';
  expectedCopies: number;
  foundCopies: number;
  /** Prints of the export with fewer copies than expected. */
  short: VerifyDiff[];
  /** Prints with more copies than expected (a card imported as another print shows up as short + extra). */
  extra: VerifyDiff[];
  /** Prints the export shouldn't have touched that changed. */
  otherChanged: VerifyDiff[];
  checkedAt: number;
}

/** What an export keeps in its change-log row (ChangeOp.details). */
export interface ExportDetails {
  target: ExportTarget;
  targetLabel: string;
  sourceAccountKey: AccountKey | null;
  items: ExportItem[];
  add: ExportPlan['add'];
  removed: RemovedEntry[];
  wholeCollection: boolean;
  before: number;
  after: number;
  /** The binder created or used. */
  binder?: SiteBinder;
  /** What the site said each import did (copies it says it imported, its row errors). */
  imported?: { count: number; errors: string[]; failed: number };
  verify?: ExportVerification;
}
