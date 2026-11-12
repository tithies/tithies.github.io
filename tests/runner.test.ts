import { vi } from 'vitest';
import type { F2FDoc } from '@/lib/f2f/api';
import { F2FClient } from '@/lib/f2f/client';
import { db } from '@/lib/db';
import type { CollectionEntry } from '@/lib/cards/types';
import { normalizeEntry } from '@/lib/moxfield/normalize';
import { saveSettings } from '@/lib/settings';
import { clearCaches, controlRun, createRun, Runner } from '@/features/f2f-buylist/runner';
import { PRICE_CHECK_NOTE } from '@/features/f2f-buylist/matcher';
import { parseSuggest, productJsUrl, type ProductJs, type SuggestResponse } from '@/lib/f2f/shopify';
import { docs, fixture } from './helpers';

const bulkDocs = docs('f2f-bulk.json');
const cardDocs = [...docs('f2f-batch.json'), ...docs('f2f-dfc.json')];
const flavorDocs = docs('f2f-flavor.json');
const f2fSets = fixture<{ sets: string[] }>('f2f-sets.json').sets;

const entry = (name: string, set: string, setName: string, cn: string, finish: CollectionEntry['finish'], rarity = 'rare', qty = 1, flavorName = ''): CollectionEntry => ({
  id: `${set}-${cn}-${finish}`,
  qty,
  condition: 'nearMint',
  finish,
  lang: 'en',
  isProxy: false,
  isAlter: false,
  card: { id: cn, scryfallId: '', set, setName, setType: 'expansion', name, faces: name.split(' // '), flavorName, cn, rarity, typeLine: 'Creature', isToken: false, usd: { nonFoil: 1, foil: 2, etched: null } },
});

const ENTRIES: CollectionEntry[] = [
  entry('Sheoldred, the Apocalypse', 'dmu', 'Dominaria United', '435', 'foil', 'mythic', 2),
  entry('Sol Ring', 'tmc', 'Teenage Mutant Ninja Turtles Eternal', '59', 'foil', 'uncommon'),
  entry('Sol Ring', 'plst', 'The List', 'BLC-129', 'nonFoil', 'uncommon', 3),
  entry('Mythic Proportions', 'ons', 'Onslaught', '274', 'foil'),
  entry('Not A Real Card', 'zzz', 'Nowhere', '999', 'nonFoil', 'mythic'),
  // Flavor-name print: found in pass 1 via F2F's "Flavor - Name" title.
  entry('Wall of Omens', 'fca', 'Final Fantasy: Through the Ages', '27', 'foil', 'uncommon', 1, 'The Imperial City of Archades'),
  // Same card without Moxfield's flavor name: found by the set + number fallback.
  entry('Wall of Omens', 'fca', 'Final Fantasy: Through the Ages', '27', 'nonFoil', 'uncommon'),
  ...fixture<{ data: unknown[] }>('moxfield-page.json').data.map(normalizeEntry).filter((e): e is CollectionEntry => e !== null),
];

/** Pass-1 requests only (name + number), not the other-versions check (name + set). */
const nameBatches = (urls: string[]) => urls.filter((u) => u.includes('/Card%20Name/') && !u.includes('/Set/')).length;

async function waitFor(pred: () => Promise<boolean>, ms = 5000) {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('Runner', () => {
  let urls: string[];
  /** Shopify predictive-search and product JSON requests (pass 3). */
  let shopUrls: string[];
  beforeEach(async () => {
    await Promise.all([db.runs.clear(), db.items.clear(), db.f2fCache.clear(), db.meta.clear()]);
    await saveSettings({ requestIntervalMs: 500, jitterMs: 0, batchSize: 5, fallbackEnabled: true, cacheTtlHours: 6 });
    urls = [];
    // Mock F2F: exact "Card Name" filtering means flavor-name prints only come back when their
    // "Flavor - Name" title is in the request; the set + number fallback ignores names.
    vi.spyOn(F2FClient.prototype, 'search').mockImplementation(async (url: string) => {
      urls.push(url);
      if (url.includes('/collections/616828141940/')) return { total: bulkDocs.length, docs: bulkDocs };
      await new Promise((r) => setTimeout(r, 40)); // simulate network so pauses land mid-run
      if (url.includes('/Set/')) return { total: flavorDocs.length, docs: flavorDocs };
      const extra = url.includes('Imperial%2520City') ? flavorDocs : [];
      return { total: cardDocs.length + extra.length, docs: [...cardDocs, ...extra] };
    });
    vi.spyOn(F2FClient.prototype, 'facetValues').mockImplementation(async (url: string) => {
      urls.push(url);
      return f2fSets;
    });
    // Shopify knows none of the cards unless a test says otherwise.
    shopUrls = [];
    vi.spyOn(F2FClient.prototype, 'suggest').mockImplementation(async (url: string) => {
      shopUrls.push(url);
      return { total: 0, docs: [] };
    });
    vi.spyOn(F2FClient.prototype, 'product').mockImplementation(async (url: string) => {
      shopUrls.push(url);
      return null;
    });
  });
  // One runner per test, like the single instance in the background worker.
  let runner: Runner;
  beforeEach(() => {
    runner = new Runner({ onProgress: () => {}, onActiveChange: () => {} });
  });
  afterEach(async () => {
    await db.runs.toCollection().modify({ status: 'cancelled' });
    await waitFor(async () => !runner.isActive);
    vi.restoreAllMocks();
  });

  const startRunner = () => runner.kick();

  it('processes a run end to end: buylist, bulk, fallback, totals', async () => {
    const { runId, prints } = await createRun({ url: 'u', pageUrl: 'p', query: {}, summary: 'Whole collection' }, ENTRIES, 0.3);
    expect(prints).toBe(ENTRIES.length);
    startRunner();
    await waitFor(async () => (await db.runs.get(runId))?.status === 'completed');

    const items = await db.items.where('runId').equals(runId).toArray();
    expect(items.every((i) => i.status === 'done')).toBe(true);
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey['dmu|435|foil']).toMatchObject({ category: 'buylist', buyCash: 210, buyCredit: 273, match: 'exact' });
    expect(byKey['tmc|59|foil'].doc?.finish).toBe('Surge Foil');
    expect(byKey['zzz|999|nonFoil']).toMatchObject({ category: 'bulk', match: 'not_found', buyCash: 0.25, matchNote: "F2F doesn't carry this set" });
    expect(byKey['fca|27|foil']).toMatchObject({ category: 'buylist', match: 'exact', buyCash: 0.1, retail: 0.75 });
    expect(byKey['fca|27|nonFoil']).toMatchObject({ category: 'bulk', match: 'exact', retail: 0.49 });
    expect(byKey['sos|170|nonFoil']).toMatchObject({ category: 'bulk', match: 'exact' });

    const run = (await db.runs.get(runId))!;
    expect(run.totals.done).toBe(prints);
    expect(run.totals.buylistCash).toBeCloseTo(items.filter((i) => i.category === 'buylist').reduce((s, i) => s + i.qty * i.buyCash!, 0), 6);
    expect(run.bulkRates?.rare).toBe(0.07);
    // 1 bulk-rate request + ceil(prints / 5) name batches + 1 set-list request + set + number fallback batches.
    expect(nameBatches(urls)).toBe(Math.ceil(prints / 5));
    expect(urls.filter((u) => u.endsWith('/pageSize/0/page/1')).length).toBe(1);
    expect(urls.filter((u) => u.includes('/Set/')).length).toBeGreaterThan(0);
    expect(urls.some((u) => u.includes('/keyword/'))).toBe(false);
  });

  it('reuses cached results on the next run', async () => {
    const first = await createRun({ url: 'u', pageUrl: 'p', query: {}, summary: '' }, ENTRIES, 0.3);
    startRunner();
    await waitFor(async () => (await db.runs.get(first.runId))?.status === 'completed');
    const firstItems = await db.items.where('runId').equals(first.runId).toArray();
    const misses = firstItems.filter((i) => i.match === 'not_found');
    expect(misses.length).toBeGreaterThan(0);
    urls.length = 0;
    const second = await createRun({ url: 'u', pageUrl: 'p', query: {}, summary: '' }, ENTRIES, 0.3);
    startRunner();
    await waitFor(async () => (await db.runs.get(second.runId))?.status === 'completed');
    const secondItems = await db.items.where('runId').equals(second.runId).toArray();
    // Hits come from the cache; misses are always looked up again (bulk rates and set list stay cached).
    expect(secondItems.filter((i) => i.fromCache).length).toBe(firstItems.length - misses.length);
    expect(secondItems.filter((i) => !i.fromCache).map((i) => i.key).sort()).toEqual(misses.map((i) => i.key).sort());
    expect(nameBatches(urls)).toBe(Math.ceil(misses.length / 5));
    expect(urls.some((u) => u.includes('616828141940') || u.endsWith('/pageSize/0/page/1'))).toBe(false);
  });

  it('pauses and resumes without redoing finished batches', async () => {
    const { runId, prints } = await createRun({ url: 'u', pageUrl: 'p', query: {}, summary: '' }, ENTRIES, 0.3);
    startRunner();
    await waitFor(async () => (await db.items.where('[runId+status]').equals([runId, 'pending']).count()) <= prints - 5);
    await controlRun(runId, 'pause');
    // The batch already in flight still commits; then the runner stops.
    await waitFor(async () => !runner.isActive);
    const doneBefore = (await db.items.where('[runId+status]').equals([runId, 'done']).count()) + (await db.items.where('[runId+status]').equals([runId, 'fallback']).count());
    const callsBefore = nameBatches(urls);
    expect(doneBefore).toBeLessThan(prints);

    await controlRun(runId, 'resume');
    startRunner();
    await waitFor(async () => (await db.runs.get(runId))?.status === 'completed');
    const callsAfter = nameBatches(urls);
    expect(callsAfter).toBe(Math.ceil(prints / 5));
    expect(callsAfter).toBeGreaterThan(callsBefore);
  });

  it("marks cards as errors (not 'not on F2F') when the F2F set list can't be loaded", async () => {
    vi.spyOn(F2FClient.prototype, 'facetValues').mockRejectedValue(new Error('HTTP 503'));
    const { runId } = await createRun({ url: 'u', pageUrl: 'p', query: {}, summary: '' }, ENTRIES, 0.3);
    startRunner();
    await waitFor(async () => (await db.runs.get(runId))?.status === 'completed');
    const items = await db.items.where('runId').equals(runId).toArray();
    const errored = items.filter((i) => i.status === 'error');
    expect(errored.length).toBeGreaterThan(0);
    expect(errored.every((i) => i.error?.includes("Couldn't load F2F's set list"))).toBe(true);
    expect(items.some((i) => i.matchNote === "F2F doesn't carry this set")).toBe(false);
    // Once F2F answers again, "Retry errors" finishes them.
    vi.spyOn(F2FClient.prototype, 'facetValues').mockResolvedValue(f2fSets);
    expect(await controlRun(runId, 'retryErrors')).toBe(true);
    startRunner();
    await waitFor(async () => (await db.runs.get(runId))?.status === 'completed' && (await db.items.where('[runId+status]').equals([runId, 'error']).count()) === 0);
    expect((await db.items.get([runId, 'fca|27|nonFoil']))?.match).toBe('exact');
  });

  it('falls back to an older cached set list when F2F is unreachable', async () => {
    await db.meta.put({ key: 'f2fSets', value: { fetchedAt: 0, sets: f2fSets }, updatedAt: 0 });
    vi.spyOn(F2FClient.prototype, 'facetValues').mockRejectedValue(new Error('HTTP 503'));
    const { runId } = await createRun({ url: 'u', pageUrl: 'p', query: {}, summary: '' }, ENTRIES, 0.3);
    startRunner();
    await waitFor(async () => (await db.runs.get(runId))?.status === 'completed');
    expect(await db.items.where('[runId+status]').equals([runId, 'error']).count()).toBe(0);
    expect((await db.items.get([runId, 'fca|27|nonFoil']))?.match).toBe('exact');
  });

  it('"Clear cache" removes every cached F2F answer but keeps runs', async () => {
    const { runId } = await createRun({ url: 'u', pageUrl: 'p', query: {}, summary: '' }, ENTRIES, 0.3);
    startRunner();
    await waitFor(async () => (await db.runs.get(runId))?.status === 'completed');
    expect(await db.f2fCache.count()).toBeGreaterThan(0);
    expect((await db.meta.toArray()).map((m) => m.key).sort()).toEqual(['bulkRates', 'f2fSets']);
    await clearCaches();
    expect(await db.f2fCache.count()).toBe(0);
    expect(await db.meta.count()).toBe(0);
    expect(await db.runs.get(runId)).toBeDefined();
    expect(await db.items.where('runId').equals(runId).count()).toBe(ENTRIES.length);
  });

  it('splits batches with more hits than one F2F page instead of paging through them', async () => {
    await saveSettings({ batchSize: 20 });
    const facet = (url: string, name: string) => {
      const m = url.match(new RegExp(`/${encodeURIComponent(name)}/([^/]+)`));
      return m ? decodeURIComponent(decodeURIComponent(m[1])).split('$^') : [];
    };
    const doc = (name: string, setName: string, code: string, cn: string): F2FDoc => ({
      id: `${code}-${name}-${cn}`,
      handle: `${code}-${cn}`,
      title: name,
      name,
      names: [name],
      setName,
      skuSet: code,
      cn,
      finish: 'Non-Foil',
      rarity: 'Rare',
      language: 'English',
      publishedF2FSell: true,
      image: null,
      variants: [{ condition: 'NM', retail: 2, buy: 1, stock: 1, sku: `SIN-MTG-${code.toUpperCase()}-${cn}-ENG-NM-NF` }],
    });
    const served: { total: number; prints: number }[] = [];
    // Like F2F: every name × number exists in some reprint set (hits ≈ prints²), the wanted
    // prints sort last, and a page never holds more than 100 hits.
    vi.spyOn(F2FClient.prototype, 'search').mockImplementation(async (url: string) => {
      if (url.includes('/collections/616828141940/')) return { total: bulkDocs.length, docs: bulkDocs };
      const names = facet(url, 'Card Name');
      const numbers = facet(url, 'Collector Number');
      const noise = names.flatMap((n) => numbers.map((cn) => doc(n, 'Reprint Set', 'rpr', cn)));
      const wanted = names.map((n) => doc(n, 'Big Set', 'big', n.split(' ')[1])).filter((d) => numbers.includes(d.cn));
      const all = [...noise, ...wanted];
      const page = Number(url.match(/\/page\/(\d+)\//)![1]);
      served.push({ total: all.length, prints: names.length });
      return { total: all.length, docs: all.slice((page - 1) * 100, page * 100) };
    });
    const entries = Array.from({ length: 20 }, (_, i) => entry(`Card ${i + 1}`, 'big', 'Big Set', String(i + 1), 'nonFoil'));
    const { runId } = await createRun({ url: 'u', pageUrl: 'p', query: {}, summary: '' }, entries, 0.3);
    startRunner();
    await waitFor(async () => (await db.runs.get(runId))?.status === 'completed');

    const items = await db.items.where('runId').equals(runId).toArray();
    expect(items.map((i) => i.match)).toEqual(Array(20).fill('exact'));
    expect(items.every((i) => i.doc?.setName === 'Big Set' && i.category === 'buylist')).toBe(true);
    // 420 hits for 20 prints → split into parts that each fit in one page; nothing is paged.
    expect(served[0]).toEqual({ total: 420, prints: 20 });
    expect(served.slice(1).every((s) => s.total <= 100)).toBe(true);
    expect(served.slice(1).reduce((n, s) => n + s.prints, 0)).toBe(20);
    expect(urls.some((u) => /\/page\/[2-9]\//.test(u))).toBe(false);
  });

  it("finds prints missing from F2F's search on Shopify and flags them for a manual price check", async () => {
    const avacynResults = parseSuggest(fixture<SuggestResponse>('shopify-suggest-avacyn.json'));
    vi.spyOn(F2FClient.prototype, 'suggest').mockImplementation(async (url: string) => {
      shopUrls.push(url);
      return url.includes('Avacyn') ? avacynResults : { total: 3, docs: [] };
    });
    vi.spyOn(F2FClient.prototype, 'product').mockImplementation(async (url: string) => {
      shopUrls.push(url);
      return fixture<ProductJs>('shopify-product-avacyn.json');
    });
    const scheme = entry('Chaos Is My Plaything', 'dsc', 'Duskmourn: House of Horror Commander', '329', 'nonFoil');
    scheme.card = { ...scheme.card, typeLine: 'Scheme' };
    const entries = [entry('Avacyn, Guardian Angel', 'm15', 'Magic 2015', '3', 'nonFoil'), entry('Not A Real Card', 'zzz', 'Nowhere', '999', 'nonFoil', 'mythic'), scheme];
    const { runId } = await createRun({ url: 'u', pageUrl: 'p', query: {}, summary: '' }, entries, 0.3);
    startRunner();
    await waitFor(async () => (await db.runs.get(runId))?.status === 'completed');

    const avacyn = await db.items.get([runId, 'm15|3|nonFoil']);
    expect(avacyn).toMatchObject({ status: 'done', match: 'price_check', matchNote: PRICE_CHECK_NOTE, category: 'bulk', buyCash: 0.07, retail: 2.49, stock: null });
    expect(avacyn?.doc).toMatchObject({ handle: 'avacyn-guardian-angel-3-magic-2015-non-foil', source: 'shopify', skuSet: 'm15' });
    expect(await db.items.get([runId, 'zzz|999|nonFoil'])).toMatchObject({ status: 'done', match: 'not_found', matchNote: "F2F doesn't carry this set" });
    // F2F never lists oversized schemes: "unlisted", not bought, and not something to review.
    expect(await db.items.get([runId, 'dsc|329|nonFoil'])).toMatchObject({ status: 'done', match: 'unlisted', category: 'not_bought', buyCash: 0 });
    // Avacyn: name search + product JSON. The made-up card: one search (results not full). The scheme: none.
    expect(shopUrls.filter((u) => u.includes('/search/suggest.json')).length).toBe(2);
    expect(shopUrls.filter((u) => u.endsWith('.js'))).toEqual([productJsUrl('avacyn-guardian-angel-3-magic-2015-non-foil')]);
    expect(shopUrls.some((u) => u.includes('Chaos'))).toBe(false);
    expect((await db.runs.get(runId))!.totals).toMatchObject({ priceCheck: 1, unlisted: 1, notFound: 1 });
    expect((await db.f2fCache.get('m15|3|nonFoil'))?.match).toBe('price_check');
  });

  it('searches Shopify again with the set name when the name alone fills the results', async () => {
    vi.spyOn(F2FClient.prototype, 'suggest').mockImplementation(async (url: string) => {
      shopUrls.push(url);
      return { total: 10, docs: [] };
    });
    const { runId } = await createRun({ url: 'u', pageUrl: 'p', query: {}, summary: '' }, [entry('Not A Real Card', 'zzz', 'Nowhere', '999', 'nonFoil')], 0.3);
    startRunner();
    await waitFor(async () => (await db.runs.get(runId))?.status === 'completed');
    expect(shopUrls.map((u) => decodeURIComponent(new URL(u).searchParams.get('q') ?? ''))).toEqual(['Not A Real Card', 'Not A Real Card Nowhere']);
    expect((await db.items.get([runId, 'zzz|999|nonFoil']))?.match).toBe('not_found');
  });

  it('pauses after three failures in a row and can retry errors', async () => {
    vi.spyOn(F2FClient.prototype, 'search').mockImplementation(async (url: string) => {
      if (url.includes('/collections/616828141940/')) return { total: bulkDocs.length, docs: bulkDocs };
      throw new Error('boom');
    });
    const { runId, prints } = await createRun({ url: 'u', pageUrl: 'p', query: {}, summary: '' }, ENTRIES, 0.3);
    startRunner();
    await waitFor(async () => (await db.runs.get(runId))?.status === 'paused');
    const run = (await db.runs.get(runId))!;
    expect(run.error).toContain('3 failed requests');
    expect(run.totals.errors).toBe(prints);
    expect(await controlRun(runId, 'retryErrors')).toBe(true);
    expect(await db.items.where('[runId+status]').equals([runId, 'error']).count()).toBe(0);
  });
});
