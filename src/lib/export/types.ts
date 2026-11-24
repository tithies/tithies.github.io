/**
 * Exporting cards to an account of a site: as a binder, into its collection, into a deck, or into a
 * deck folder (one deck per group of cards). Site-neutral: pages build ExportItems (the export
 * list), the dialog previews an ExportPlan from a live read of the target, and the background
 * ExportJob makes the changes and checks them.
 */
import type { AccountKey } from '@/lib/accounts/types';
import type { CollectionEntry, Finish } from '@/lib/cards/types';
import type { DeckCard, DeckFolder, DeckSummary } from '@/lib/decks/types';
import type { BinderVisibility, SiteBinder } from '@/lib/sites/types';

/** What a deck folder export splits the cards by. */
export type GroupKey = 'set' | 'rarity' | 'color';

/**
 * How a deck folder export splits the cards, group by group: a group's path → what it is split by
 * ('' is every card; "set:fin", then "set:fin/rarity:rare"…). A group with no entry isn't split:
 * it is one deck. Each group can be split its own way.
 */
export type Grouping = Record<string, GroupKey>;

/** What a deck folder export groups a print by (filled in by the dialog, from Scryfall). */
export interface ItemGroup {
  /** The set it belongs to (a set's parent: FIC → "fin"), and that set's name. */
  set: string;
  setName: string;
  /** "common"…"mythic", "special", "bonus"; '' when unknown. */
  rarity: string;
  /** Its color identity, WUBRG letters ('' colorless); "?" when unknown. */
  colors: string;
}

/** One print to export, with how many copies. */
export interface ExportItem {
  /** The item's key in a page's export list (one per row); items of the same print are merged when exported. */
  key: string;
  /** The site's card id, when known. */
  cardId: string;
  scryfallId: string;
  name: string;
  set: string;
  setName: string;
  cn: string;
  finish: Finish;
  /** The language the copies are written with (the site's Language field). Unset: English (exports made before languages). */
  lang?: string;
  /**
   * The print's own language (the site's card object for it, `cardId`), when known. A site whose
   * import can't pick that print adds the item on its own, by card id (see PlanLimits.oneByOne).
   */
  printLang?: string;
  qty: number;
  /** Where the item came from ("Missing from collection"…). */
  note?: string;
  /** Its set, rarity and color identity, for a deck folder export (see ItemGroup). */
  group?: ItemGroup;
}

export type ExportMode = 'replace' | 'add';

/**
 * Deck targets add the cards to the mainboard; an existing deck keeps its cards (Moxfield can't
 * replace only a deck's mainboard: its import's replace empties every board).
 */
export type DeckTarget =
  /** A new deck, in a folder or not. */
  | { accountKey: AccountKey; kind: 'newDeck'; name: string; visibility: BinderVisibility; folderId: string | null }
  | { accountKey: AccountKey; kind: 'deck'; deckId: string; publicId: string }
  /** A new folder (top level, or in `parentFolderId`), one new deck per group. */
  | { accountKey: AccountKey; kind: 'newFolder'; name: string; parentFolderId: string | null; visibility: BinderVisibility; grouping: Grouping }
  /** An existing folder: a group whose deck is already in it (same name) gets its cards added; the others get new decks. */
  | { accountKey: AccountKey; kind: 'folder'; folderId: string; visibility: BinderVisibility; grouping: Grouping };

export type ExportTarget =
  | { accountKey: AccountKey; kind: 'newBinder'; name: string; visibility: BinderVisibility }
  | { accountKey: AccountKey; kind: 'binder'; binderId: string; mode: ExportMode }
  | { accountKey: AccountKey; kind: 'collection'; mode: ExportMode }
  | DeckTarget;

const DECK_KINDS = new Set<ExportTarget['kind']>(['newDeck', 'deck', 'newFolder', 'folder']);
export const isDeckTarget = (t: ExportTarget): t is DeckTarget => DECK_KINDS.has(t.kind);

/**
 * What is read from the target account: its binder list only, plus one binder's cards, or the
 * collection's totals (one page), or the whole collection; or its deck list and folders, plus the
 * cards of some decks. Each step reads only what it needs.
 */
export type TargetRead =
  | { kind: 'binders' }
  | { kind: 'binder'; binderId: string }
  | { kind: 'totals' }
  | { kind: 'collection' }
  | { kind: 'decks'; publicIds?: string[] };

/** One deck's cards as read (every board), with what its next change must send. */
export interface DeckContent {
  /** The site's internal deck id and its version (sent with each change), when it says. */
  id: string | null;
  version: number | null;
  lastUpdatedAt: string;
  /** It holds more cards than the site shows (Moxfield: `isTooBeaucoup`, over 1,000). */
  tooBig: boolean;
  cards: DeckCard[];
}

/** What the target account has: read live for the preview, again before changing anything, and after. */
export interface TargetState {
  /** Empty for deck reads (they don't read binders). */
  binders: SiteBinder[];
  read: TargetRead;
  /** The entries read: the binder's, or the whole collection's (none for 'binders', 'totals' and 'decks'). */
  entries: CollectionEntry[];
  /** The whole collection's size ('totals' and 'collection' reads). */
  totals: { entries: number; copies: number } | null;
  /** 'decks' reads: every deck (no cards) and every folder, plus the cards of the decks asked for (by publicId). */
  decks?: DeckSummary[];
  folders?: DeckFolder[];
  deckCards?: Record<string, DeckContent>;
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

/** One deck a deck export writes into. */
export interface DeckPlan {
  name: string;
  /** The deck, when it exists already (an existing deck target, or a deck of the folder with the group's name). */
  existing: { id: string; publicId: string } | null;
  /** The cards it gets (merged by print: a deck has no Language field). */
  items: ExportItem[];
  copies: number;
  /** Copies in the deck (every board) now, and after. */
  before: number;
  after: number;
  /** Why it can't be made (too many cards). */
  over?: string;
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
  /** Deck targets: each deck written into, and the folder (created or used). */
  decks?: DeckPlan[];
  folder?: { id: string | null; path: string; create: boolean };
  /** Copies in the target (binder, or whole collection) now, and expected after. */
  before: number;
  after: number;
  steps: string[];
  /** Writes the export makes, and reads (before and after). */
  writes: number;
  reads: number;
  /** The requests of each step, for the progress: pages read before, changes sent, pages the check reads (the reads are estimates). */
  requests: { before: number; write: number; check: number };
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
  /** The copies' language (Language field); unset in checks made before languages. */
  lang?: string;
  /** The print's language; unset in checks made before it was compared. */
  printLang?: string;
  /** In the target (binder or collection) unless `outside`. */
  expected: number;
  found: number;
  /** A print outside what the export touches (or outside the binder; for a deck, in another board) changed. */
  outside?: boolean;
  /** Deck targets: the deck (and, outside, the board). */
  deck?: string;
  board?: string;
}

export interface ExportVerification {
  ok: boolean;
  /** What was compared: the binder's cards only, the whole collection, or each deck written. */
  scope: 'binder' | 'collection' | 'decks';
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
  /** Deck targets: the folder created or used, and each deck written (created or added to). */
  folder?: { id: string; path: string };
  decks?: { name: string; publicId: string; created: boolean }[];
  /** What the site said each import did (copies it says it imported, its row errors). */
  imported?: { count: number; errors: string[]; failed: number };
  verify?: ExportVerification;
}
