import { moxfieldExporter } from '@/lib/sites/moxfield/export';
import type { BinderVisibility, SiteMutation, SiteType } from '@/lib/sites/types';
import type { PlanLimits } from './plan';
import type { ExportItem } from './types';

/** A deck a deck export changes: its ids and version (what each change of it sends). */
export interface DeckHandle {
  id: string;
  publicId: string;
  version: number;
}

/** The writes of deck exports (into a deck's mainboard). */
export interface SiteDeckExporter {
  createFolder(path: string): SiteMutation;
  /** A new deck with `items` (only those the import text can add: see limits.deck.oneByOne), in the folder when given. */
  createDeck(name: string, visibility: BinderVisibility, folderId: string | null, items: ExportItem[]): SiteMutation;
  /** Adds `items` to the deck's mainboard by import text (its cards stay). */
  importIntoDeck(deck: DeckHandle, items: ExportItem[]): SiteMutation;
  /** One item, by its card id (an item limits.deck.oneByOne picks). */
  addToDeck(deck: DeckHandle, item: ExportItem): SiteMutation;
}

/** The writes an export makes on one site. */
export interface SiteExporter {
  limits: PlanLimits;
  createBinder(name: string, visibility: BinderVisibility): SiteMutation;
  /** One write per chunk of entries. */
  removeEntries(entryIds: string[]): SiteMutation[];
  deleteCollection(): SiteMutation;
  /** The writes that add `items`: one per chunk of items, plus one per item `limits.oneByOne` picks; into the binder when given. */
  importItems(items: ExportItem[], binderId: string | null): SiteMutation[];
  /** Deck exports, when the site has decks Tithies can write. */
  decks?: SiteDeckExporter;
}

export const EXPORTERS: Partial<Record<SiteType, SiteExporter>> = { moxfield: moxfieldExporter };

export const exporterOf = (type: SiteType): SiteExporter | null => EXPORTERS[type] ?? null;
