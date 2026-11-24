/** How an export is made on Moxfield: the writes, and their sizes. */
import type { SiteExporter } from '@/lib/export/exporters';
import { MOX_COLLECTION_PAGE_SIZE } from './constants';
import type { ExportItem } from '@/lib/export/types';
import type { SiteMutation } from '@/lib/sites/types';
import { MOX_LANGUAGE_NAMES, toMoxCsv } from './csv';
import { isEnglish, langOf } from '@/lib/cards/languages';
import { MOX_ENGLISH_ID, MOX_LANGUAGES } from './languages';
import { MAX_BULK_REMOVE, MAX_DECK_ADD_QUANTITY, validFolderPath } from './mutations';

/** Rows per CSV import (kept small: one failed import loses little). */
export const IMPORT_ROWS = 500;

/**
 * Most cards a Moxfield deck holds: past 1,000 it keeps the cards but shows only 1,000, on its
 * page and in its API (`isTooBeaucoup`, verified 2026-11-24), so Tithies couldn't check them.
 */
export const DECK_MAX_CARDS = 1000;
/** Deck import text lines per request (a deck holds at most 1,000 cards: one request). */
export const DECK_IMPORT_LINES = 1000;

/**
 * One line of Moxfield's deck import text: "2 Sol Ring (C21) 263", " *F*" foil, " *E*" etched
 * (the layout of its own export with finishes). No language: a deck has no Language field.
 */
export const deckLine = (i: Pick<ExportItem, 'qty' | 'name' | 'set' | 'cn' | 'finish'>) =>
  `${i.qty} ${i.name} (${i.set.toUpperCase()}) ${i.cn}${i.finish === 'foil' ? ' *F*' : i.finish === 'etched' ? ' *E*' : ''}`;
export const deckText = (items: readonly ExportItem[]) => items.map(deckLine).join('\n');

const chunk = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

/**
 * Moxfield's CSV import picks a print by set + number only: its English card object, whatever
 * the Language column says (verified 2026-11-18: a French IKO #2 Farfinder came in as the English
 * print with Language French). A print in another language is added by its card id instead.
 */
export const addsOneByOne = (i: ExportItem): boolean => !isEnglish(i.printLang) && /^[A-Za-z0-9_-]{1,64}$/.test(i.cardId);

const languageId = (lang: string) => MOX_LANGUAGES.find((l) => l.code === lang)?.id ?? MOX_ENGLISH_ID;

export const moxfieldExporter: SiteExporter = {
  limits: {
    importRows: IMPORT_ROWS,
    removeEntries: MAX_BULK_REMOVE,
    pageSize: MOX_COLLECTION_PAGE_SIZE,
    oneByOne: addsOneByOne,
    // The import text has no language either: a print in another language goes by its card id.
    deck: {
      maxCards: DECK_MAX_CARDS,
      maxAddQty: MAX_DECK_ADD_QUANTITY,
      importLines: DECK_IMPORT_LINES,
      oneByOne: addsOneByOne,
      folderName: { test: validFolderPath, text: 'A Moxfield folder name can only have letters, numbers, spaces and hyphens.' },
    },
  },
  decks: {
    createFolder: (path) => ({ site: 'moxfield', op: 'createDeckFolder', name: path.trim() }),
    createDeck: (name, visibility, folderId, items) => ({
      site: 'moxfield',
      op: 'createDeck',
      name: name.trim(),
      visibility,
      importText: deckText(items),
      ...(folderId ? { folderId } : {}),
    }),
    importIntoDeck: (deck, items) => ({ site: 'moxfield', op: 'importDeck', deckId: deck.id, publicId: deck.publicId, version: deck.version, importText: deckText(items) }),
    addToDeck: (deck, i) => ({ site: 'moxfield', op: 'addDeckCard', deckId: deck.id, publicId: deck.publicId, version: deck.version, cardId: i.cardId, quantity: i.qty, finish: i.finish }),
  },
  createBinder: (name, visibility) => ({ site: 'moxfield', op: 'createBinder', name: name.trim(), visibility }),
  removeEntries: (ids) => chunk(ids, MAX_BULK_REMOVE).map((entryIds) => ({ site: 'moxfield', op: 'bulkRemove', entryIds })),
  deleteCollection: () => ({ site: 'moxfield', op: 'deleteCollection' }),
  importItems: (items, binderId) => {
    const csv: SiteMutation[] = chunk(
      items.filter((i) => !addsOneByOne(i)),
      IMPORT_ROWS,
    ).map((rows) => ({
      site: 'moxfield',
      op: 'importCsv',
      csv: toMoxCsv(rows.map((i) => ({ qty: i.qty, name: i.name, set: i.set, cn: i.cn, finish: i.finish, language: MOX_LANGUAGE_NAMES[langOf(i)] ?? 'English' }))),
      ...(binderId ? { binderId } : {}),
    }));
    const single: SiteMutation[] = items.filter(addsOneByOne).map((i) => ({
      site: 'moxfield',
      op: 'addCard',
      cardId: i.cardId,
      quantity: i.qty,
      finish: i.finish,
      languageId: languageId(langOf(i)),
      ...(binderId ? { binderId } : {}),
    }));
    return [...csv, ...single];
  },
};
