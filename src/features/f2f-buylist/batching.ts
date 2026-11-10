import { buildSearchUrl, F2F_COLLECTIONS } from '@/lib/f2f/api';
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

export const DEFAULT_BATCH: BatchOptions = { maxPrints: 40, maxUrlLength: 6000, pageSize: 500 };

export const batchPageUrl = (facets: Record<string, string[]>, pageSize: number, page = 1) =>
  buildSearchUrl({ collection: F2F_COLLECTIONS.mtgSingles, pageSize, page, facets: { ...facets, Language: ['English'] } });

/**
 * Greedy packer: adds prints to the current request until it holds `maxPrints` or its URL would
 * exceed `maxUrlLength`. Sorting by set/number first keeps values shared within a request.
 */
function pack<T extends { key: string; set: string; cn: string }>(
  items: T[],
  facetValues: (it: T) => Record<string, string[]>,
  opts: BatchOptions,
): Batch[] {
  const sorted = [...items].sort((a, b) => a.set.localeCompare(b.set) || a.cn.localeCompare(b.cn, undefined, { numeric: true }));
  const batches: Batch[] = [];
  let keys: string[] = [];
  let acc = new Map<string, Set<string>>();

  const toFacets = (m: Map<string, Set<string>>) => Object.fromEntries([...m].map(([k, v]) => [k, [...v]]));
  const merged = (it: T) => {
    const next = new Map([...acc].map(([k, v]) => [k, new Set(v)]));
    for (const [k, vals] of Object.entries(facetValues(it))) {
      const set = next.get(k) ?? new Set<string>();
      vals.forEach((v) => set.add(v));
      next.set(k, set);
    }
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
    if (keys.length && (tooMany || tooLong)) {
      flush();
      next = merged(it);
    }
    keys.push(it.key);
    acc = next;
  }
  flush();
  return batches;
}

type Printish = Pick<Item, 'key' | 'frontName' | 'flavorName' | 'cn' | 'set'>;

/** Pass 1: Card Name ∈ names × Collector Number ∈ numbers × English. */
export function makeBatches(items: Printish[], opts: BatchOptions = DEFAULT_BATCH): Batch[] {
  return pack(items, (it) => ({ 'Card Name': f2fSearchNames(it), 'Collector Number': [it.cn] }), opts);
}

/** Maps Moxfield/Scryfall set names to F2F's spelling ("… Horror Commander" → "… Horror: Commander"). */
export function f2fSetLookup(f2fSets: string[]): (setName: string) => string | undefined {
  const map = new Map<string, string>();
  for (const s of f2fSets) if (!map.has(normSet(s))) map.set(normSet(s), s);
  return (setName) => map.get(normSet(setName));
}

/**
 * Fallback: Set ∈ F2F set names × Collector Number ∈ numbers × English, without any name filter.
 * Finds prints F2F lists under another name. Items whose set F2F doesn't have are skipped.
 */
export function makeSetBatches(
  items: Pick<Item, 'key' | 'set' | 'setName' | 'cn'>[],
  f2fSetOf: (setName: string) => string | undefined,
  opts: BatchOptions = DEFAULT_BATCH,
): { batches: Batch[]; unknownSet: string[] } {
  const known = items.filter((i) => f2fSetOf(i.setName));
  const unknownSet = items.filter((i) => !f2fSetOf(i.setName)).map((i) => i.key);
  return { batches: pack(known, (it) => ({ Set: [f2fSetOf(it.setName)!], 'Collector Number': [it.cn] }), opts), unknownSet };
}
