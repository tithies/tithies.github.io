import { buildSearchUrl, F2F_COLLECTIONS, F2F_MAX_PAGE_SIZE } from '@/lib/f2f/api';
import { f2fSearchNames, normSet } from './matcher';
import type { Item } from './types';

/** One F2F request: facet filters (OR within a facet, AND across) covering several prints. */
export interface Batch {
  keys: string[];
  facets: Record<string, string[]>;
  url: string;
}

export interface BatchOptions {
  maxPrints: number;
  maxUrlLength: number;
  pageSize: number;
}

export const DEFAULT_BATCH: BatchOptions = { maxPrints: 20, maxUrlLength: 6000, pageSize: F2F_MAX_PAGE_SIZE };

export const batchPageUrl = (facets: Record<string, string[]>, pageSize: number, page = 1) =>
  buildSearchUrl({ collection: F2F_COLLECTIONS.mtgSingles, pageSize, page, facets: { ...facets, Language: ['English'] } });

type Keyed = { key: string; set: string; cn: string };
type FacetFn<T> = (it: T) => Record<string, string[]>;

function addFacets(acc: Map<string, Set<string>>, values: Record<string, string[]>) {
  for (const [k, vals] of Object.entries(values)) {
    const set = acc.get(k) ?? new Set<string>();
    vals.forEach((v) => set.add(v));
    acc.set(k, set);
  }
}
const toFacets = (m: Map<string, Set<string>>) => Object.fromEntries([...m].map(([k, v]) => [k, [...v]]));

/** One request for exactly these prints (in this order). */
export function buildBatch<T extends Keyed>(items: T[], facetValues: FacetFn<T>, pageSize = F2F_MAX_PAGE_SIZE): Batch {
  const acc = new Map<string, Set<string>>();
  for (const it of items) addFacets(acc, facetValues(it));
  const facets = toFacets(acc);
  return { keys: items.map((i) => i.key), facets, url: batchPageUrl(facets, pageSize) };
}

/**
 * Greedy packer: adds prints to the current request until it holds `maxPrints` or its URL would
 * exceed `maxUrlLength`. Sorting by set/number first keeps values shared within a request.
 * With `groupOf`, prints of different groups never share a request.
 */
function pack<T extends Keyed>(items: T[], facetValues: FacetFn<T>, opts: BatchOptions, groupOf?: (it: T) => string): Batch[] {
  const sorted = [...items].sort((a, b) => a.set.localeCompare(b.set) || a.cn.localeCompare(b.cn, undefined, { numeric: true }));
  const batches: Batch[] = [];
  let keys: string[] = [];
  let group: string | undefined;
  let acc = new Map<string, Set<string>>();

  const merged = (it: T) => {
    const next = new Map([...acc].map(([k, v]) => [k, new Set(v)]));
    addFacets(next, facetValues(it));
    return next;
  };
  const flush = () => {
    if (!keys.length) return;
    const facets = toFacets(acc);
    batches.push({ keys, facets, url: batchPageUrl(facets, opts.pageSize) });
    keys = [];
    acc = new Map();
  };

  for (const it of sorted) {
    let next = merged(it);
    const tooMany = keys.length >= opts.maxPrints;
    const tooLong = batchPageUrl(toFacets(next), opts.pageSize).length > opts.maxUrlLength;
    const newGroup = groupOf != null && keys.length > 0 && groupOf(it) !== group;
    if (keys.length && (tooMany || tooLong || newGroup)) {
      flush();
      next = merged(it);
    }
    keys.push(it.key);
    group = groupOf?.(it);
    acc = next;
  }
  flush();
  return batches;
}

type Printish = Pick<Item, 'key' | 'frontName' | 'flavorName' | 'cn' | 'set'>;

/** Pass-1 facets of one print: its names × its collector number. */
export const nameFacets = (it: Printish) => ({ 'Card Name': f2fSearchNames(it), 'Collector Number': [it.cn] });

/** Pass 1: Card Name ∈ names × Collector Number ∈ numbers × English. */
export function makeBatches(items: Printish[], opts: BatchOptions = DEFAULT_BATCH): Batch[] {
  return pack(items, nameFacets, opts);
}

export type SetPrint = Pick<Item, 'set' | 'setName'>;

/**
 * Maps a Moxfield print's set to F2F's set name. Tried in order: the set code learned from F2F
 * docs already matched in this run (F2F SKUs carry the code), the same name up to punctuation
 * ("… Horror Commander" → "… Horror: Commander"), then a unique F2F name ending with it
 * ("Midnight Hunt Commander" → "Innistrad: Midnight Hunt: Commander").
 */
export function f2fSetLookup(f2fSets: string[], byCode: ReadonlyMap<string, string> = new Map()): (p: SetPrint) => string | undefined {
  const byName = new Map<string, string>();
  for (const s of f2fSets) if (!byName.has(normSet(s))) byName.set(normSet(s), s);
  const suffixes = new Map<string, string | undefined>();
  const bySuffix = (n: string) => {
    if (!suffixes.has(n)) {
      const hits = n.length >= 6 ? [...byName].filter(([k]) => k.endsWith(n)) : [];
      suffixes.set(n, hits.length === 1 ? hits[0][1] : undefined);
    }
    return suffixes.get(n);
  };
  return ({ set, setName }) => byCode.get(set.toLowerCase()) ?? byName.get(normSet(setName)) ?? bySuffix(normSet(setName));
}

/** Fallback facets of one print: its F2F set × its collector number. */
export const setFacets =
  (f2fSetOf: (p: SetPrint) => string | undefined) =>
  (it: SetPrint & Pick<Item, 'cn'>): Record<string, string[]> => ({ Set: [f2fSetOf(it)!], 'Collector Number': [it.cn] });

/**
 * Fallback: Set × Collector Number ∈ numbers × English, without any name filter. Finds prints
 * F2F lists under another name. One set per request: several sets would cross every set with
 * every number. Items whose set F2F doesn't have are skipped.
 */
export function makeSetBatches(
  items: Pick<Item, 'key' | 'set' | 'setName' | 'cn'>[],
  f2fSetOf: (p: SetPrint) => string | undefined,
  opts: BatchOptions = DEFAULT_BATCH,
): { batches: Batch[]; unknownSet: string[] } {
  const known = items.filter((i) => f2fSetOf(i));
  const unknownSet = items.filter((i) => !f2fSetOf(i)).map((i) => i.key);
  return { batches: pack(known, setFacets(f2fSetOf), opts, (it) => f2fSetOf(it)!), unknownSet };
}
