import { buildSearchUrl, F2F_COLLECTIONS } from '@/lib/f2f/api';
import { describeError, F2FClient } from '@/lib/f2f/client';
import { db } from '@/lib/db';
import { groupPrints, type MoxEntry } from '@/lib/moxfield/normalize';
import { getSettings, type Settings } from '@/lib/settings';
import { batchPageUrl, f2fSetLookup, makeBatches, makeSetBatches, type Batch } from './batching';
import { DEFAULT_BULK_RATES, parseBulkRates } from './bulk';
import { evaluate, matchByNumber, matchPrint, type MatchResult } from './matcher';
import { summarize } from './summary';
import { emptyTotals, type BulkRates, type CacheEntry, type Item, type Run, type RunProgress, type RunSource } from './types';

const BULK_RATES_TTL = 24 * 3600_000;
const SET_LIST_TTL = 24 * 3600_000;
/** Bump when matching logic changes so older cached lookups are redone. */
export const CACHE_VERSION = 2;
const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PAGES_PER_BATCH = 5;

// ---------------------------------------------------------------------------------------------
// Run creation

export async function createRun(source: RunSource, entries: MoxEntry[], creditBonus: number): Promise<{ runId: number; prints: number }> {
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
    const batches = makeBatches(pending, { maxPrints: settings.batchSize, maxUrlLength: 6000, pageSize: 500 });
    for (const batch of batches) {
      run = await this.assertRunning(runId);
      await this.runBatch(run, batch, byKey, rates, settings);
    }

    // Pass 2: keyword fallback for prints the batch lookup missed.
    await db.runs.update(runId, { phase: 'fallback' });
    await this.runFallback(runId, rates, settings);

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
      if (c && c.fetchedAt >= minTime && c.v === CACHE_VERSION && c.match !== 'not_found') {
        updates.push(this.finalize(item, { match: c.match, doc: c.doc, note: c.matchNote }, rates, run.creditBonus, true));
      }
    });
    if (updates.length) await db.items.bulkPut(updates);
  }

  private async fail(run: Run, items: Item[], error: unknown) {
    const message = describeError(error);
    const failures = run.consecutiveFailures + 1;
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

  private async fetchBatch(batch: Batch) {
    const docs = [];
    for (let page = 1; page <= MAX_PAGES_PER_BATCH; page++) {
      const res = await this.client.search(page === 1 ? batch.url : batchPageUrl(batch.facets, 500, page));
      docs.push(...res.docs);
      if (docs.length >= res.total || !res.docs.length) break;
    }
    return docs;
  }

  private async runBatch(run: Run, batch: Batch, byKey: Map<string, Item>, rates: BulkRates, settings: Settings) {
    const items = batch.keys.map((k) => byKey.get(k)!).filter(Boolean);
    let docs;
    try {
      docs = await this.fetchBatch(batch);
    } catch (e) {
      await this.fail(run, items, e);
      return;
    }
    const updates: Item[] = [];
    const cache: CacheEntry[] = [];
    for (const item of items) {
      const result = matchPrint(item, docs);
      if (result.match === 'not_found' && settings.fallbackEnabled) {
        updates.push({ ...item, status: 'fallback', updatedAt: Date.now() });
      } else {
        updates.push(this.finalize(item, result, rates, run.creditBonus));
        cache.push(this.cacheRow(item, result));
      }
    }
    await this.commit(run, updates, cache);
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
    const notFound = (items: Item[], note: string) =>
      items.map((i) => this.finalize(i, { match: 'not_found', doc: null, note }, rates, run.creditBonus));

    let f2fSets: string[];
    try {
      f2fSets = await this.getF2fSets();
    } catch (e) {
      // Retryable: "Retry errors" on the run looks these cards up again.
      await this.fail(run, waiting, e);
      return;
    }
    const setOf = f2fSetLookup(f2fSets);
    const byKey = new Map(waiting.map((i) => [i.key, i]));
    const { batches, unknownSet } = makeSetBatches(waiting, setOf, { maxPrints: settings.batchSize, maxUrlLength: 6000, pageSize: 500 });
    if (unknownSet.length) await this.commit(run, notFound(unknownSet.map((k) => byKey.get(k)!), "F2F doesn't carry this set"), []);

    const overCap = batches.slice(settings.fallbackCap).flatMap((b) => b.keys.map((k) => byKey.get(k)!));
    if (overCap.length) await this.commit(run, notFound(overCap, 'Fallback search limit reached (see Settings)'), []);

    for (const batch of batches.slice(0, settings.fallbackCap)) {
      run = await this.assertRunning(runId);
      const items = batch.keys.map((k) => byKey.get(k)!);
      let docs;
      try {
        docs = await this.fetchBatch(batch);
      } catch (e) {
        await this.fail(run, items, e);
        continue;
      }
      const results = items.map((i) => [i, matchByNumber(i, docs)] as const);
      await this.commit(
        run,
        results.map(([i, r]) => this.finalize(i, r.match === 'not_found' ? { ...r, note: 'Not listed on F2F' } : r, rates, run.creditBonus)),
        results.map(([i, r]) => this.cacheRow(i, r)),
      );
    }
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
