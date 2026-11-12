import { buildSearchUrl, F2F_COLLECTIONS, F2F_MAX_PAGE_SIZE, type F2FDoc } from '@/lib/f2f/api';
import { describeError, F2FClient } from '@/lib/f2f/client';
import { db } from '@/lib/db';
import { groupPrints } from '@/lib/cards/prints';
import type { CollectionEntry } from '@/lib/cards/types';
import { getSettings, type Settings } from '@/lib/settings';
import { batchPageUrl, buildBatch, f2fSetLookup, makeBatches, makeSetBatches, nameFacets, setFacets, type Batch } from './batching';
import { productJsUrl, SUGGEST_LIMIT, suggestUrl, withProductVariants } from '@/lib/f2f/shopify';
import { DEFAULT_BULK_RATES, isOversized, parseBulkRates } from './bulk';
import { evaluate, matchByNumber, matchPrint, matchShopify, PRICE_CHECK_NOTE, type MatchResult } from './matcher';
import { summarize } from './summary';
import { emptyTotals, type BulkRates, type CacheEntry, type Item, type Run, type RunProgress, type RunSource } from './types';

const BULK_RATES_TTL = 24 * 3600_000;
const SET_LIST_TTL = 24 * 3600_000;
/** Bump when matching logic changes so older cached lookups are redone. */
export const CACHE_VERSION = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
/** Hits per request aimed for when an oversized batch is split (one F2F page holds 100). */
const SPLIT_TARGET_HITS = 60;
/** Pages read for a single print that alone has more than one page of hits (rare). */
const MAX_PAGES_SINGLE_PRINT = 10;

/**
 * Result for a print no search found. Oversized cards (schemes, planes…) are "unlisted": F2F
 * never lists them, so there is nothing to review. Anything else is "not found".
 */
export const missResult = (item: Pick<Item, 'typeLine'>, note?: string): MatchResult =>
  isOversized(item.typeLine) ? { match: 'unlisted', doc: null, note: "F2F doesn't list oversized cards" } : { match: 'not_found', doc: null, note };

/** Splits `items` into `parts` runs of near-equal length, keeping their order. */
export function splitEvenly<T>(items: T[], parts: number): T[][] {
  const n = Math.max(1, Math.min(parts, items.length));
  return Array.from({ length: n }, (_, i) => items.slice(Math.floor((i * items.length) / n), Math.floor(((i + 1) * items.length) / n)));
}

/**
 * Parts to split an oversized batch into. Hits grow about with prints² (every name is crossed
 * with every number), so k parts hold roughly total / k² hits each.
 */
export const splitParts = (prints: number, total: number) =>
  Math.min(prints, Math.max(2, Math.ceil(Math.sqrt(total / SPLIT_TARGET_HITS))));

// ---------------------------------------------------------------------------------------------
// Run creation

export async function createRun(source: RunSource, entries: CollectionEntry[], creditBonus: number): Promise<{ runId: number; prints: number }> {
  const groups = groupPrints(entries);
  const now = Date.now();
  const totals = emptyTotals();
  totals.entries = entries.length;
  totals.prints = groups.length;
  totals.copies = groups.reduce((s, g) => s + g.qty, 0);
  return db.transaction('rw', db.runs, db.items, async () => {
    const runId = (await db.runs.add({
      createdAt: now,
      updatedAt: now,
      status: 'queued',
      phase: 'bulk_rates',
      source,
      totals,
      creditBonus,
      requests: 0,
      consecutiveFailures: 0,
    })) as number;
    const items: Item[] = groups.map((g) => ({
      runId,
      key: g.key,
      status: 'pending',
      name: g.card.name,
      frontName: g.card.faces[0] ?? g.card.name,
      faces: g.card.faces,
      flavorName: g.card.flavorName || undefined,
      set: g.card.set,
      setName: g.card.setName,
      setType: g.card.setType,
      cn: g.card.cn,
      finish: g.finish,
      rarity: g.card.rarity,
      typeLine: g.card.typeLine,
      isToken: g.card.isToken,
      qty: g.qty,
      conditions: g.conditions,
      alters: g.alters,
      scryfallId: g.card.scryfallId,
      marketUsd: g.card.usd[g.finish] ?? null,
      updatedAt: now,
    }));
    await db.items.bulkAdd(items);
    return { runId, prints: items.length };
  });
}

// ---------------------------------------------------------------------------------------------
// Aggregates

export async function recomputeTotals(runId: number): Promise<Run | undefined> {
  const run = await db.runs.get(runId);
  if (!run) return undefined;
  const items = await db.items.where('runId').equals(runId).toArray();
  const patch = { totals: summarize(items, run.totals.entries), updatedAt: Date.now() };
  await db.runs.update(runId, patch);
  return { ...run, ...patch };
}

export const toProgress = (run: Run, message?: string): RunProgress => ({
  runId: run.id!,
  status: run.status,
  phase: run.phase,
  done: run.totals.done,
  total: run.totals.prints,
  buylistPrints: run.totals.buylistPrints,
  buylistCash: run.totals.buylistCash,
  buylistCredit: run.totals.buylistCredit,
  message: message ?? run.error,
});

// ---------------------------------------------------------------------------------------------
// Runner

export interface RunnerHooks {
  onProgress(run: Run, message?: string): void;
  onActiveChange(active: boolean): void;
}

class StopRun extends Error {}

/** Processes queued/running runs one at a time. Every batch is committed atomically, so a run can resume anywhere. */
export class Runner {
  private client = new F2FClient({ intervalMs: 1500, jitterMs: 750 });
  private looping = false;
  activeRunId: number | null = null;

  constructor(private hooks: RunnerHooks) {}

  get isActive() {
    return this.looping;
  }

  /** Starts the processing loop if it isn't already running. */
  kick(): void {
    if (this.looping) return;
    this.looping = true;
    this.hooks.onActiveChange(true);
    void this.loop().finally(() => {
      this.looping = false;
      this.activeRunId = null;
      this.hooks.onActiveChange(false);
    });
  }

  private async loop() {
    for (;;) {
      const candidates = await db.runs.where('status').anyOf('running', 'queued').toArray();
      if (!candidates.length) return;
      // Resume interrupted runs before starting new ones, oldest first.
      candidates.sort((a, b) => (a.status === b.status ? a.createdAt - b.createdAt : a.status === 'running' ? -1 : 1));
      const run = candidates[0];
      this.activeRunId = run.id!;
      try {
        await this.process(run.id!);
      } catch (e) {
        if (!(e instanceof StopRun)) {
          await db.runs.update(run.id!, { status: 'failed', error: describeError(e), updatedAt: Date.now() });
          const r = await db.runs.get(run.id!);
          if (r) this.hooks.onProgress(r);
        }
      }
    }
  }

  private async assertRunning(runId: number): Promise<Run> {
    const run = await db.runs.get(runId);
    if (!run || run.status !== 'running') throw new StopRun();
    return run;
  }

  private async emit(runId: number, message?: string) {
    const run = await recomputeTotals(runId);
    if (run) this.hooks.onProgress(run, message);
  }

  private async process(runId: number) {
    const settings = await getSettings();
    this.client.setThrottle({ intervalMs: settings.requestIntervalMs, jitterMs: settings.jitterMs });
    const initial = await db.runs.get(runId);
    if (!initial) return;
    if (initial.status === 'queued') await db.runs.update(runId, { status: 'running', updatedAt: Date.now() });
    let run = await this.assertRunning(runId);

    if (!run.bulkRates) {
      await db.runs.update(runId, { phase: 'bulk_rates' });
      const bulkRates = await this.getBulkRates();
      await db.runs.update(runId, { bulkRates });
      run = await this.assertRunning(runId);
    }
    const rates = run.bulkRates!;

    await db.runs.update(runId, { phase: 'lookup' });
    await this.applyCache(run, rates, settings);
    await this.emit(runId);

    // Pass 1: batched exact lookups.
    const pending = await db.items.where('[runId+status]').equals([runId, 'pending']).toArray();
    const byKey = new Map(pending.map((i) => [i.key, i]));
    const batches = makeBatches(pending, { maxPrints: settings.batchSize, maxUrlLength: 6000, pageSize: F2F_MAX_PAGE_SIZE });
    for (const batch of batches) {
      run = await this.assertRunning(runId);
      await this.runBatch(run, batch, byKey, rates, settings);
    }

    // Pass 2: keyword fallback for prints the batch lookup missed.
    await db.runs.update(runId, { phase: 'fallback' });
    await this.runFallback(runId, rates, settings);

    // Pass 3: Shopify's own product search for prints F2F's search index doesn't have.
    run = await this.assertRunning(runId);
    await db.runs.update(runId, { phase: 'shop_search' });
    await this.runShopSearch(runId, rates, settings);

    run = await this.assertRunning(runId);
    await db.runs.update(runId, { status: 'completed', phase: 'done', finishedAt: Date.now(), error: undefined, updatedAt: Date.now() });
    await this.emit(runId, 'Done');
  }

  private async getBulkRates(): Promise<BulkRates> {
    const cached = (await db.meta.get('bulkRates'))?.value as BulkRates | undefined;
    if (cached && Date.now() - cached.fetchedAt < BULK_RATES_TTL) return cached;
    try {
      const { docs } = await this.client.search(buildSearchUrl({ collection: F2F_COLLECTIONS.wholesaleBulk, pageSize: 100 }));
      const rates = parseBulkRates(docs);
      await db.meta.put({ key: 'bulkRates', value: rates, updatedAt: Date.now() });
      return rates;
    } catch {
      return cached ?? { ...DEFAULT_BULK_RATES, fetchedAt: Date.now(), usedDefaults: true, sources: [] };
    }
  }

  private finalize(item: Item, result: MatchResult, rates: BulkRates, creditBonus: number, fromCache = false): Item {
    const ev = evaluate(item, result, rates, creditBonus);
    return {
      ...item,
      status: 'done',
      match: result.match,
      matchNote: result.note,
      doc: result.doc,
      ...ev,
      error: undefined,
      fromCache,
      updatedAt: Date.now(),
    };
  }

  private cacheRow(item: Item, result: MatchResult): CacheEntry {
    return { key: item.key, fetchedAt: Date.now(), match: result.match, matchNote: result.note, doc: result.doc, v: CACHE_VERSION };
  }

  /**
   * F2F's own set names (for the set + number fallback), from the facet list; cached 24 h.
   * If F2F can't be reached, an older cached list is used; with no list at all this throws,
   * so cards are marked as errors (retryable) rather than wrongly "not on F2F".
   */
  private async getF2fSets(): Promise<string[]> {
    const cached = (await db.meta.get('f2fSets'))?.value as { fetchedAt: number; sets: string[] } | undefined;
    if (cached?.sets.length && Date.now() - cached.fetchedAt < SET_LIST_TTL) return cached.sets;
    try {
      const sets = await this.client.facetValues(buildSearchUrl({ collection: F2F_COLLECTIONS.mtgSingles, pageSize: 0, withFacets: true }), 'Set');
      if (!sets.length) throw new Error('F2F returned an empty set list');
      await db.meta.put({ key: 'f2fSets', value: { fetchedAt: Date.now(), sets }, updatedAt: Date.now() });
      return sets;
    } catch (e) {
      if (cached?.sets.length) return cached.sets;
      throw new Error(`Couldn't load F2F's set list (${describeError(e)})`);
    }
  }

  private async applyCache(run: Run, rates: BulkRates, settings: Settings) {
    if (settings.cacheTtlHours <= 0) return;
    const minTime = Date.now() - settings.cacheTtlHours * 3600_000;
    const pending = await db.items.where('[runId+status]').equals([run.id!, 'pending']).toArray();
    const cached = await db.f2fCache.bulkGet(pending.map((i) => i.key));
    const updates: Item[] = [];
    pending.forEach((item, idx) => {
      const c = cached[idx];
      // Misses are never reused: they are cheap to retry and matching keeps improving.
      if (c && c.fetchedAt >= minTime && c.v === CACHE_VERSION && c.match !== 'not_found' && c.match !== 'unlisted') {
        updates.push(this.finalize(item, { match: c.match, doc: c.doc, note: c.matchNote }, rates, run.creditBonus, true));
      }
    });
    if (updates.length) await db.items.bulkPut(updates);
  }

  private async fail(run: Run, items: Item[], error: unknown) {
    const message = describeError(error);
    // Re-read: parts of the same batch may have committed (and reset the counter) since `run` was loaded.
    const failures = ((await db.runs.get(run.id!))?.consecutiveFailures ?? run.consecutiveFailures) + 1;
    await db.transaction('rw', db.items, db.runs, async () => {
      await db.items.bulkPut(items.map((i) => ({ ...i, status: 'error' as const, error: message, updatedAt: Date.now() })));
      await db.runs.update(run.id!, { consecutiveFailures: failures, requests: this.client.requests, updatedAt: Date.now() });
    });
    // Totals first, then the status flip, so anything watching "paused" sees final numbers.
    await recomputeTotals(run.id!);
    if (failures >= MAX_CONSECUTIVE_FAILURES) {
      await db.runs.update(run.id!, {
        status: 'paused',
        error: `Paused after ${failures} failed requests in a row: ${message}. Resume when F2F is reachable again.`,
        updatedAt: Date.now(),
      });
    }
    await this.emit(run.id!, message);
  }

  /**
   * Looks up `items` so that every request fits in one F2F page. F2F caps pages at 100 hits and
   * orders ties differently from one request to the next, so paging can skip docs. A batch with
   * more hits is split and each part looked up again. Only a single print that still has more
   * than a page of hits is paged (deduplicated, best effort). `onPart` gets each settled part.
   */
  private async lookup(runId: number, items: Item[], build: (items: Item[]) => Batch, onPart: (items: Item[], docs: F2FDoc[]) => Promise<void>): Promise<void> {
    const batch = build(items);
    const first = await this.client.search(batch.url);
    if (first.docs.length >= first.total || !first.docs.length) return onPart(items, first.docs);
    if (items.length === 1) {
      const docs = new Map(first.docs.map((d) => [d.id, d]));
      const pages = Math.min(MAX_PAGES_SINGLE_PRINT, Math.ceil(first.total / F2F_MAX_PAGE_SIZE));
      for (let page = 2; page <= pages; page++) {
        await this.assertRunning(runId);
        const res = await this.client.search(batchPageUrl(batch.facets, F2F_MAX_PAGE_SIZE, page));
        res.docs.forEach((d) => docs.set(d.id, d));
        if (!res.docs.length) break;
      }
      return onPart(items, [...docs.values()]);
    }
    for (const part of splitEvenly(items, splitParts(items.length, first.total))) {
      await this.assertRunning(runId);
      await this.lookup(runId, part, build, onPart);
    }
  }

  /** Runs `lookup` for one batch, committing each settled part; parts that fail become retryable errors. */
  private async lookupBatch(
    run: Run,
    items: Item[],
    build: (items: Item[]) => Batch,
    settle: (items: Item[], docs: F2FDoc[]) => { updates: Item[]; cache: CacheEntry[] },
  ) {
    const settled = new Set<string>();
    try {
      await this.lookup(run.id!, items, build, async (part, docs) => {
        const { updates, cache } = settle(part, docs);
        await this.commit(run, updates, cache);
        part.forEach((i) => settled.add(i.key));
      });
    } catch (e) {
      if (e instanceof StopRun) throw e;
      await this.fail(run, items.filter((i) => !settled.has(i.key)), e);
    }
  }

  private async runBatch(run: Run, batch: Batch, byKey: Map<string, Item>, rates: BulkRates, settings: Settings) {
    const items = batch.keys.map((k) => byKey.get(k)!).filter(Boolean);
    await this.lookupBatch(run, items, (part) => buildBatch(part, nameFacets), (part, docs) => {
      const updates: Item[] = [];
      const cache: CacheEntry[] = [];
      for (const item of part) {
        const found = matchPrint(item, docs);
        if (found.match === 'not_found' && settings.fallbackEnabled) {
          updates.push({ ...item, status: 'fallback', updatedAt: Date.now() });
        } else {
          const result = found.match === 'not_found' ? missResult(item, found.note) : found;
          updates.push(this.finalize(item, result, rates, run.creditBonus));
          cache.push(this.cacheRow(item, result));
        }
      }
      return { updates, cache };
    });
  }

  /** Moxfield set code → F2F set name, learned from this run's matched cards (F2F SKUs carry the code). */
  private async learnedSetNames(runId: number): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await db.items
      .where('runId')
      .equals(runId)
      .each((i) => {
        if (i.doc?.setName && i.doc.skuSet === i.set && !out.has(i.set)) out.set(i.set, i.doc.setName);
      });
    return out;
  }

  private async commit(run: Run, updates: Item[], cache: CacheEntry[]) {
    await db.transaction('rw', db.items, db.runs, db.f2fCache, async () => {
      await db.items.bulkPut(updates);
      if (cache.length) await db.f2fCache.bulkPut(cache);
      await db.runs.update(run.id!, { consecutiveFailures: 0, requests: this.client.requests, updatedAt: Date.now() });
    });
    await this.emit(run.id!);
  }

  /**
   * Pass 2 for prints the name lookup missed: search F2F by set + collector number only, which
   * finds prints F2F lists under another name (e.g. "The Imperial City of Archades - Wall of Omens").
   */
  private async runFallback(runId: number, rates: BulkRates, settings: Settings) {
    const waiting = await db.items.where('[runId+status]').equals([runId, 'fallback']).toArray();
    if (!waiting.length) return;
    let run = await this.assertRunning(runId);
    const notFound = (items: Item[], note: string) => items.map((i) => this.finalize(i, missResult(i, note), rates, run.creditBonus));
    // Misses wait for pass 3 (Shopify product search), keeping why F2F's index didn't have them.
    const toShopSearch = (items: Item[], note: string): Item[] =>
      items.map((i) => ({ ...i, status: 'shop_search', matchNote: note, updatedAt: Date.now() }));

    let f2fSets: string[];
    try {
      f2fSets = await this.getF2fSets();
    } catch (e) {
      // Retryable: "Retry errors" on the run looks these cards up again.
      await this.fail(run, waiting, e);
      return;
    }
    const setOf = f2fSetLookup(f2fSets, await this.learnedSetNames(runId));
    const byKey = new Map(waiting.map((i) => [i.key, i]));
    const { batches, unknownSet } = makeSetBatches(waiting, setOf, { maxPrints: settings.batchSize, maxUrlLength: 6000, pageSize: F2F_MAX_PAGE_SIZE });
    if (unknownSet.length) await this.commit(run, toShopSearch(unknownSet.map((k) => byKey.get(k)!), "F2F doesn't carry this set"), []);

    const overCap = batches.slice(settings.fallbackCap).flatMap((b) => b.keys.map((k) => byKey.get(k)!));
    if (overCap.length) await this.commit(run, notFound(overCap, 'Fallback search limit reached (see Settings)'), []);

    const byNumber = setFacets(setOf);
    for (const batch of batches.slice(0, settings.fallbackCap)) {
      run = await this.assertRunning(runId);
      const current = run;
      await this.lookupBatch(current, batch.keys.map((k) => byKey.get(k)!), (part) => buildBatch(part, byNumber), (part, docs) => {
        const results = part.map((i) => [i, matchByNumber(i, docs)] as const);
        const found = results.filter(([, r]) => r.match !== 'not_found');
        const missed = results.filter(([, r]) => r.match === 'not_found').map(([i]) => i);
        return {
          updates: [...found.map(([i, r]) => this.finalize(i, r, rates, current.creditBonus)), ...toShopSearch(missed, 'Not listed on F2F')],
          cache: found.map(([i, r]) => this.cacheRow(i, r)),
        };
      });
    }
  }

  /**
   * Pass 3 for prints neither search found. F2F's search index misses some live products (blocks
   * of them, e.g. Magic 2015 #3 Avacyn), so ask Shopify's own product search. A print found there
   * is on F2F, but its buy price only shows on the sell-mode product page: it's marked
   * "price_check" (check by hand) and valued at the bulk rate meanwhile.
   */
  private async runShopSearch(runId: number, rates: BulkRates, settings: Settings) {
    const waiting = await db.items.where('[runId+status]').equals([runId, 'shop_search']).toArray();
    if (!waiting.length) return;
    let run = await this.assertRunning(runId);
    const notFound = (i: Item, note = i.matchNote) => this.finalize(i, missResult(i, note), rates, run.creditBonus);

    // F2F doesn't list oversized Archenemy schemes / Planechase planes at all.
    const oversized = waiting.filter((i) => isOversized(i.typeLine));
    const candidates = waiting.filter((i) => !isOversized(i.typeLine));
    const overCap = candidates.slice(settings.fallbackCap);
    if (oversized.length || overCap.length) {
      const limit = (i: Item) => notFound(i, `${i.matchNote ?? 'Not listed on F2F'} (search limit reached, see Settings)`);
      await this.commit(run, [...oversized.map((i) => notFound(i)), ...overCap.map(limit)], []);
    }

    // F2F's own set names help when Scryfall's differ ("Midnight Hunt Commander"); optional here.
    const f2fSets = await this.getF2fSets().catch(() => [] as string[]);
    const setOf = f2fSetLookup(f2fSets, await this.learnedSetNames(runId));
    for (const item of candidates.slice(0, settings.fallbackCap)) {
      run = await this.assertRunning(runId);
      try {
        const doc = await this.findOnShopify(runId, item, setOf(item));
        const result: MatchResult = doc ? { match: 'price_check', doc, note: PRICE_CHECK_NOTE } : missResult(item, item.matchNote);
        await this.commit(run, [this.finalize(item, result, rates, run.creditBonus)], doc ? [this.cacheRow(item, result)] : []);
      } catch (e) {
        if (e instanceof StopRun) throw e;
        await this.fail(run, [item], e);
      }
    }
  }

  /**
   * The exact print on Shopify: search its name (then name + set when the results are full, as
   * for cards with many prints), then read the product JSON for conditions and retail prices.
   */
  private async findOnShopify(runId: number, item: Item, f2fSetName?: string): Promise<F2FDoc | null> {
    for (const q of [item.frontName, `${item.frontName} ${f2fSetName ?? item.setName}`]) {
      await this.assertRunning(runId);
      const { total, docs } = await this.client.suggest(suggestUrl(q));
      const hit = matchShopify(item, docs, f2fSetName);
      if (hit) {
        await this.assertRunning(runId);
        const product = await this.client.product(productJsUrl(hit.handle));
        if (!product) return null;
        const doc = withProductVariants(hit, product);
        // The SKU can reveal a non-English print the title didn't.
        return !doc.language || doc.language.toLowerCase() === 'english' ? doc : null;
      }
      if (total < SUGGEST_LIMIT) return null;
    }
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Controls

export async function controlRun(runId: number, action: 'pause' | 'resume' | 'cancel' | 'retryErrors'): Promise<boolean> {
  const run = await db.runs.get(runId);
  if (!run) return false;
  const now = Date.now();
  switch (action) {
    case 'pause':
      if (run.status !== 'running' && run.status !== 'queued') return false;
      await db.runs.update(runId, { status: 'paused', updatedAt: now });
      return true;
    case 'resume':
      if (!['paused', 'failed', 'cancelled'].includes(run.status)) return false;
      await db.runs.update(runId, { status: 'queued', consecutiveFailures: 0, error: undefined, finishedAt: undefined, updatedAt: now });
      return true;
    case 'cancel':
      if (['completed', 'cancelled'].includes(run.status)) return false;
      await db.runs.update(runId, { status: 'cancelled', updatedAt: now });
      return true;
    case 'retryErrors': {
      const errored = await db.items.where('[runId+status]').equals([runId, 'error']).toArray();
      if (!errored.length) return false;
      await db.transaction('rw', db.items, db.runs, async () => {
        await db.items.bulkPut(errored.map((i) => ({ ...i, status: 'pending' as const, error: undefined })));
        await db.runs.update(runId, { status: 'queued', consecutiveFailures: 0, error: undefined, finishedAt: undefined, updatedAt: now });
      });
      return true;
    }
  }
}

/** Settings → "Clear cache": every cached F2F answer (lookups, bulk rates, set list). Runs are kept. */
export async function clearCaches() {
  await db.transaction('rw', db.f2fCache, db.meta, async () => {
    await db.f2fCache.clear();
    // Only F2F's own cached rows: meta also holds the Moxfield deck/collection sync state.
    await db.meta.bulkDelete(['bulkRates', 'f2fSets']);
  });
}

export async function deleteRun(runId: number) {
  await db.transaction('rw', db.runs, db.items, async () => {
    await db.items.where('runId').equals(runId).delete();
    await db.runs.delete(runId);
  });
}
