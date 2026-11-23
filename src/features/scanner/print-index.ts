/**
 * The every-print index on the page: its prints (names, sets…) here, its vectors in the search worker, and the
 * Namer that names cards with it (padded · CLS, the method the tuned recognizer was trained for).
 */
import { gunzipText, parsePrints, printMask, type IndexPrint } from './index-file';
import { pairResults, sideQueries, TOP_K, type Namer } from './pipeline';
import { readFile, type Installed } from './published';
import type { PrintInfo } from './reference';
import { SearchClient } from './search-client';
import type { SearchInfo } from './search-core';

export const INDEX_METHOD = 'dino-pad-cls';

export interface PrintIndex {
  installed: Installed;
  prints: IndexPrint[];
  info: SearchInfo;
  client: SearchClient;
  /** Rows kept by "only my prints" (null: every row). */
  mask: Uint8Array | null;
  /** How long opening it took (files read, prints parsed, vectors in the worker). */
  ms: number;
}

/** Opens the installed index: null when its files aren't stored (not downloaded yet). */
export async function openPrintIndex(installed: Installed): Promise<PrintIndex | null> {
  const t0 = performance.now();
  const [bin, gz] = await Promise.all([readFile(installed.manifest.files.index), readFile(installed.manifest.files.prints)]);
  if (!bin || !gz) return null;
  const prints = parsePrints(await gunzipText(gz));
  if (prints.length !== installed.manifest.count) throw new Error(`The prints file has ${prints.length} rows, the manifest ${installed.manifest.count}`);
  const client = new SearchClient();
  try {
    const info = await client.load(bin);
    if (info.count !== prints.length) throw new Error(`The index has ${info.count} rows, its prints file ${prints.length}`);
    return { installed, prints, info, client, mask: null, ms: performance.now() - t0 };
  } catch (e) {
    client.dispose();
    throw e;
  }
}

/** Limits the search to the owned prints, or lifts the limit (null). */
export async function setOwnedOnly(idx: PrintIndex, owned: readonly PrintInfo[] | null): Promise<PrintIndex> {
  const mask = owned ? printMask(idx.prints, owned) : null;
  await idx.client.setMask(mask);
  return { ...idx, mask };
}

export function printIndexNamer(idx: PrintIndex): Namer {
  const size = idx.mask ? idx.mask.reduce((s, v) => s + v, 0) : idx.prints.length;
  const prints = idx.mask ? idx.prints.filter((_, i) => idx.mask![i]) : idx.prints;
  return {
    size,
    prints,
    name: async (cards) => {
      const queries = sideQueries(cards, INDEX_METHOD);
      if (!cards.length || queries.some((q) => !q)) return cards.map(() => ({}));
      const { hits } = await idx.client.search(queries, TOP_K);
      return pairResults(hits, idx.prints).map((r) => ({ [INDEX_METHOD]: r }));
    },
  };
}
