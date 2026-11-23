/**
 * The reference set of phase 0: the prints the current account owns (its synced collection),
 * each turned into vectors from its Scryfall image (and the back face's, for double-faced cards). Images are fetched politely (4 at a time,
 * at most 10 a second) and not kept; vectors are saved after each group of 8 prints, so a
 * cancelled or interrupted build resumes where it stopped.
 */
import PQueue from 'p-queue';
import type { CollectionEntry } from '@/lib/cards/types';
import { scryfallImage } from '@/lib/f2f/links';
import type { ScannerEngine } from './engine-client';
import { addNoBack, currentRefIds, MODEL_KEY, noBackIds, rowKey, scannerDb, type RefRow } from './store';

export interface PrintInfo {
  scryfallId: string;
  name: string;
  set: string;
  setName: string;
  cn: string;
  lang?: string;
  /** How many faces it has (two-faced prints may have a back picture). */
  faces?: number;
  /** The picture is the back face (reference rows only). */
  back?: boolean;
}

/** One entry per print (Scryfall id) of the collection. */
export function ownedPrints(entries: readonly CollectionEntry[]): PrintInfo[] {
  const byId = new Map<string, PrintInfo>();
  for (const e of entries) {
    const c = e.card;
    if (!c.scryfallId || byId.has(c.scryfallId)) continue;
    byId.set(c.scryfallId, { scryfallId: c.scryfallId, name: c.name, set: c.set, setName: c.setName, cn: c.cn, lang: c.lang, faces: c.faces?.length ?? 1 });
  }
  return [...byId.values()];
}

export interface BuildProgress {
  done: number;
  total: number;
  failed: number;
  /** Prints already in the reference set when the build started. */
  skipped: number;
  startedAt: number;
}

/** Images per engine call: 8 prints × 2 model runs = one batch of 16 pictures (engine/features.ts). */
const GROUP = 8;

const SCRYFALL_COLLECTION = 'https://api.scryfall.com/cards/collection';
/** Identifiers per /cards/collection request (Scryfall's limit). */
const COLLECTION_MAX = 75;

interface ScryfallCard {
  id: string;
  set: string;
  collector_number: string;
  lang: string;
  image_status?: string;
}

async function scryfallCollection(identifiers: object[], signal: AbortSignal, fetchFn: typeof fetch): Promise<ScryfallCard[]> {
  const out: ScryfallCard[] = [];
  for (let i = 0; i < identifiers.length; i += COLLECTION_MAX) {
    // Scryfall asks for 50–100 ms between requests.
    if (i) await new Promise((r) => setTimeout(r, 120));
    const res = await fetchFn(SCRYFALL_COLLECTION, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifiers: identifiers.slice(i, i + COLLECTION_MAX) }),
      signal,
    });
    if (!res.ok) throw new Error(`Scryfall /cards/collection: HTTP ${res.status}`);
    out.push(...((await res.json()) as { data: ScryfallCard[] }).data);
  }
  return out;
}

/**
 * Pictures to use instead of a print's own (print id → the stand-in's id). A non-English print Scryfall has no scan of
 * shows the English picture under a "Localized image not available" box (image_status "placeholder"), which spoils its
 * vectors: the English print of the same set and number has the same art without the box. Prints without a language
 * (read before Tithies kept it) are taken as English. A failed lookup gives no stand-ins (the build goes on as before).
 */
export async function pictureStandIns(prints: readonly PrintInfo[], signal: AbortSignal, fetchFn: typeof fetch = fetch): Promise<Map<string, string>> {
  const standIns = new Map<string, string>();
  const foreign = prints.filter((p) => p.lang && p.lang !== 'en');
  if (!foreign.length) return standIns;
  try {
    const placeholders = (await scryfallCollection(foreign.map((p) => ({ id: p.scryfallId })), signal, fetchFn)).filter((c) => c.lang !== 'en' && c.image_status === 'placeholder');
    if (!placeholders.length) return standIns;
    const english = await scryfallCollection(placeholders.map((c) => ({ set: c.set, collector_number: c.collector_number })), signal, fetchFn);
    const bySetCn = new Map(english.filter((c) => c.lang === 'en' && c.image_status !== 'placeholder').map((c) => [`${c.set}|${c.collector_number}`, c.id]));
    for (const c of placeholders) {
      const id = bySetCn.get(`${c.set}|${c.collector_number}`);
      if (id) standIns.set(c.id, id);
    }
  } catch (e) {
    if (!signal.aborted) console.warn('Scanner reference: looking up pictures of non-English prints failed', e);
  }
  return standIns;
}

/** One picture to turn into vectors: a print's front, or the back of a double-faced one. */
interface Job {
  p: PrintInfo;
  back: boolean;
  key: string;
}

export async function buildReferences(
  engine: ScannerEngine,
  prints: readonly PrintInfo[],
  opts: { signal: AbortSignal; onProgress: (p: BuildProgress) => void; modelKey?: string },
): Promise<BuildProgress> {
  const modelKey = opts.modelKey ?? MODEL_KEY;
  const have = await currentRefIds(modelKey);
  const noBack = await noBackIds();
  const standIns = await pictureStandIns(prints, opts.signal);
  const all: Job[] = prints.flatMap((p) => {
    const jobs: Job[] = [{ p, back: false, key: rowKey(modelKey, p.scryfallId, false) }];
    // Two-faced prints: the back picture too, unless Scryfall has none (adventures, split cards).
    if ((p.faces ?? 1) > 1 && !noBack.has(p.scryfallId)) jobs.push({ p, back: true, key: rowKey(modelKey, p.scryfallId, true) });
    return jobs;
  });
  // Rows made from a picture that now has a stand-in are made again.
  const standInJobs = all.filter((j) => standIns.has(j.p.scryfallId) && have.has(j.key));
  const standInRows = await scannerDb.refs.bulkGet(standInJobs.map((j) => j.key));
  standInJobs.forEach((j, i) => {
    if (standInRows[i]?.picture !== standIns.get(j.p.scryfallId)) have.delete(j.key);
  });
  const picture = (j: Job) => standIns.get(j.p.scryfallId) ?? j.p.scryfallId;
  const todo = all.filter((j) => !have.has(j.key) && scryfallImage(j.p.scryfallId, 'normal'));
  const progress: BuildProgress = { done: 0, total: todo.length, failed: 0, skipped: all.length - todo.length, startedAt: Date.now() };
  opts.onProgress({ ...progress });
  const fetches = new PQueue({ concurrency: 4, intervalCap: 10, interval: 1000 });
  const missingBacks: string[] = [];
  const fetchImage = (j: Job) =>
    fetches.add(async () => {
      const res = await fetch(scryfallImage(picture(j), 'normal', j.back ? 'back' : 'front')!, { signal: opts.signal });
      if (res.status === 404 && j.back) {
        missingBacks.push(j.p.scryfallId);
        return null;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return createImageBitmap(await res.blob());
    });
  /** One group's pictures; a failed one is null (counted, and tried again next build). */
  const fetchGroup = (group: Job[]) =>
    Promise.all(
      group.map((j) =>
        fetchImage(j).catch((e) => {
          if (!opts.signal.aborted) console.warn(`Scanner reference ${j.p.set} #${j.p.cn}${j.back ? ' (back)' : ''} (${j.p.scryfallId}):`, e);
          return undefined;
        }),
      ),
    );
  const groups: Job[][] = [];
  for (let i = 0; i < todo.length; i += GROUP) groups.push(todo.slice(i, i + GROUP));
  // While the engine works on one group, the next one downloads.
  let next = groups.length ? fetchGroup(groups[0]) : null;
  for (let g = 0; g < groups.length && next; g++) {
    const bitmaps = await next;
    next = g + 1 < groups.length && !opts.signal.aborted ? fetchGroup(groups[g + 1]) : null;
    if (opts.signal.aborted) {
      for (const b of bitmaps) b?.close();
      break;
    }
    const ok = groups[g].flatMap((j, i) => (bitmaps[i] ? [{ j, bitmap: bitmaps[i]! }] : []));
    // A back face Scryfall doesn't have (null) is not a failure: there's nothing to add.
    progress.done += bitmaps.filter((b) => b === null).length;
    progress.failed += bitmaps.filter((b) => b === undefined).length;
    if (ok.length) {
      const { features } = await engine.call({ type: 'imageFeatures', bitmaps: ok.map((x) => x.bitmap) }, ok.map((x) => x.bitmap));
      const now = Date.now();
      await scannerDb.refs.bulkPut(
        ok.map(({ j }, i): RefRow => {
          const { faces: _faces, back: _back, ...print } = j.p;
          const pic = standIns.get(j.p.scryfallId);
          return { ...print, scryfallId: j.key, printId: j.p.scryfallId, back: j.back || undefined, ...(pic ? { picture: pic } : {}), modelKey, vectors: features[i].vectors, phash: features[i].phash, addedAt: now };
        }),
      );
      progress.done += ok.length;
    }
    opts.onProgress({ ...progress });
  }
  fetches.clear();
  if (missingBacks.length) await addNoBack(missingBacks);
  return progress;
}
