/** How an export is made on Moxfield: the writes, and their sizes. */
import type { SiteExporter } from '@/lib/export/exporters';
import { toMoxCsv } from './csv';
import { MAX_BULK_REMOVE } from './mutations';

/** Rows per CSV import (kept small: one failed import loses little). */
export const IMPORT_ROWS = 500;
/** Rows Moxfield actually returns per collection page, whatever is asked (100 since 2026-11; it was up to 5000). */
export const COLLECTION_ROWS_PER_PAGE = 100;

const chunk = <T>(list: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

export const moxfieldExporter: SiteExporter = {
  limits: { importRows: IMPORT_ROWS, removeEntries: MAX_BULK_REMOVE, pageSize: COLLECTION_ROWS_PER_PAGE },
  createBinder: (name, visibility) => ({ site: 'moxfield', op: 'createBinder', name: name.trim(), visibility }),
  removeEntries: (ids) => chunk(ids, MAX_BULK_REMOVE).map((entryIds) => ({ site: 'moxfield', op: 'bulkRemove', entryIds })),
  deleteCollection: () => ({ site: 'moxfield', op: 'deleteCollection' }),
  importItems: (items, binderId) =>
    chunk(items, IMPORT_ROWS).map((rows) => ({
      site: 'moxfield',
      op: 'importCsv',
      csv: toMoxCsv(rows.map((i) => ({ qty: i.qty, name: i.name, set: i.set, cn: i.cn, finish: i.finish }))),
      ...(binderId ? { binderId } : {}),
    })),
};
