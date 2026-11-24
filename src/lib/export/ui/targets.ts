/** The export dialog's targets, as the user edits them (pure helpers). */
import type { AccountKey } from '@/lib/accounts/types';
import type { DeckFolder, DeckSummary } from '@/lib/decks/types';
import type { BinderVisibility, SiteBinder } from '@/lib/sites/types';
import { pruneGrouping } from '../grouping';
import { stateCovers } from '../plan';
import type { ExportItem, ExportMode, ExportTarget, Grouping, TargetRead, TargetState } from '../types';

/** What the target form shows: a binder (new or existing), the collection, a deck, a deck folder. */
export type DraftKind = 'newBinder' | 'binder' | 'collection' | 'deck' | 'folder';

/** One target being chosen: every field kept, whichever kind is picked (switching back keeps them). */
export interface TargetDraft {
  /** Stable while the dialog lives (React key, typed confirmation). */
  id: number;
  accountKey: AccountKey | null;
  kind: DraftKind;
  binderName: string;
  /** A new binder's, a new deck's, or the new decks' of a folder export. */
  visibility: BinderVisibility;
  binderId: string | null;
  mode: ExportMode;
  /** Deck: a new one (its name, and the folder it goes in), or an existing one (added to). */
  newDeck: boolean;
  deckName: string;
  deckFolderId: string | null;
  deckId: string | null;
  deckPublicId: string | null;
  /** Deck folder: a new one (its name, and the folder it goes in), or an existing one; how the cards are split into decks. */
  newFolder: boolean;
  folderName: string;
  parentFolderId: string | null;
  folderId: string | null;
  grouping: Grouping;
}

/** "Tithies export 2026-11-24", then "… (2)", "… (3)" for the names other targets already use. */
export function defaultBinderName(date: string, taken: readonly string[]): string {
  const base = `Tithies export ${date}`;
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
}

/** "Tithies export 2026-11-24", then "… 2", "… 3" (a folder name has letters, numbers, spaces and hyphens only). */
export function defaultFolderName(date: string, taken: readonly string[]): string {
  const base = `Tithies export ${date}`;
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!used.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Split by set first (each set can then be split its own way). */
export const DEFAULT_GROUPING: Grouping = { '': 'set' };

/** A new target: a new binder, on `accountKey`, named apart from the other targets' new binders, decks and folders. */
export function newDraft(id: number, accountKey: AccountKey | null, others: readonly TargetDraft[], date: string): TargetDraft {
  const same = others.filter((d) => d.accountKey === accountKey);
  return {
    id,
    accountKey,
    kind: 'newBinder',
    binderName: defaultBinderName(
      date,
      same.filter((d) => d.kind === 'newBinder').map((d) => d.binderName),
    ),
    visibility: 'private',
    binderId: null,
    mode: 'add',
    newDeck: true,
    deckName: defaultBinderName(
      date,
      same.filter((d) => d.kind === 'deck' && d.newDeck).map((d) => d.deckName),
    ),
    deckFolderId: null,
    deckId: null,
    deckPublicId: null,
    newFolder: true,
    folderName: defaultFolderName(
      date,
      same.filter((d) => d.kind === 'folder' && d.newFolder).map((d) => d.folderName),
    ),
    parentFolderId: null,
    folderId: null,
    grouping: DEFAULT_GROUPING,
  };
}

/**
 * The target a draft describes, or null while it misses something (an account, a binder, a deck,
 * a folder). `items`: the cards, to keep only the grouping choices of groups they have.
 */
export function draftTarget(d: TargetDraft, items?: readonly ExportItem[]): ExportTarget | null {
  const { accountKey } = d;
  if (!accountKey) return null;
  switch (d.kind) {
    case 'newBinder':
      return { accountKey, kind: 'newBinder', name: d.binderName, visibility: d.visibility };
    case 'binder':
      return d.binderId ? { accountKey, kind: 'binder', binderId: d.binderId, mode: d.mode } : null;
    case 'collection':
      return { accountKey, kind: 'collection', mode: d.mode };
    case 'deck':
      if (d.newDeck) return { accountKey, kind: 'newDeck', name: d.deckName, visibility: d.visibility, folderId: d.deckFolderId };
      return d.deckId && d.deckPublicId ? { accountKey, kind: 'deck', deckId: d.deckId, publicId: d.deckPublicId } : null;
    case 'folder': {
      const grouping = items ? pruneGrouping(items, d.grouping) : d.grouping;
      if (d.newFolder) return { accountKey, kind: 'newFolder', name: d.folderName, parentFolderId: d.parentFolderId, visibility: d.visibility, grouping };
      return d.folderId ? { accountKey, kind: 'folder', folderId: d.folderId, visibility: d.visibility, grouping } : null;
    }
  }
}

/** The newest state read that covers `need` (an account's states, oldest first). */
export function pickState(states: readonly TargetState[] | undefined, need: TargetRead): TargetState | null {
  for (let i = (states?.length ?? 0) - 1; i >= 0; i--) if (stateCovers(states![i], need)) return states![i];
  return null;
}

/** The account's binders as last read (null: not read yet; deck reads don't read them). */
export function latestBinders(states: readonly TargetState[] | undefined): SiteBinder[] | null {
  for (let i = (states?.length ?? 0) - 1; i >= 0; i--) if (states![i].read.kind !== 'decks') return states![i].binders;
  return null;
}

/** The account's decks and folders as last read (null: not read yet). */
export function latestDecks(states: readonly TargetState[] | undefined): { decks: DeckSummary[]; folders: DeckFolder[] } | null {
  for (let i = (states?.length ?? 0) - 1; i >= 0; i--) {
    const s = states![i];
    if (s.decks) return { decks: s.decks, folders: s.folders ?? [] };
  }
  return null;
}

/** Decks need the deck list; the others the binder list. */
export const needsDecks = (d: TargetDraft) => d.kind === 'deck' || d.kind === 'folder';
