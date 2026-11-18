/** How an export is made on Moxfield: the writes, and their sizes. */
import type { SiteExporter } from '@/lib/export/exporters';
import { MOX_COLLECTION_PAGE_SIZE } from './constants';
import type { ExportItem } from '@/lib/export/types';
import type { SiteMutation } from '@/lib/sites/types';
import { MOX_LANGUAGE_NAMES, toMoxCsv } from './csv';
import { isEnglish, langOf } from '@/lib/cards/languages';
import { MOX_ENGLISH_ID, MOX_LANGUAGES } from './languages';
import { MAX_BULK_REMOVE } from './mutations';

/** Rows per CSV import (kept small: one failed import loses little). */
export const IMPORT_ROWS = 500;

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
  limits: { importRows: IMPORT_ROWS, removeEntries: MAX_BULK_REMOVE, pageSize: MOX_COLLECTION_PAGE_SIZE, oneByOne: addsOneByOne },
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
