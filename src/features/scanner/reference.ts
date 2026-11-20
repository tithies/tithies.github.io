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
  const all: Job[] = prints.flatMap((p) => {
    const jobs: Job[] = [{ p, back: false, key: rowKey(modelKey, p.scryfallId, false) }];
    // Two-faced prints: the back picture too, unless Scryfall has none (adventures, split cards).
    if ((p.faces ?? 1) > 1 && !noBack.has(p.scryfallId)) jobs.push({ p, back: true, key: rowKey(modelKey, p.scryfallId, true) });
    return jobs;
  });
  const todo = all.filter((j) => !have.has(j.key) && scryfallImage(j.p.scryfallId, 'normal'));
  const progress: BuildProgress = { done: 0, total: todo.length, failed: 0, skipped: all.length - todo.length, startedAt: Date.now() };
  opts.onProgress({ ...progress });
  const fetches = new PQueue({ concurrency: 4, intervalCap: 10, interval: 1000 });
  const missingBacks: string[] = [];
  const fetchImage = (j: Job) =>
    fetches.add(async () => {
      const res = await fetch(scryfallImage(j.p.scryfallId, 'normal', j.back ? 'back' : 'front')!, { signal: opts.signal });
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
          return { ...print, scryfallId: j.key, printId: j.p.scryfallId, back: j.back || undefined, modelKey, vectors: features[i].vectors, phash: features[i].phash, addedAt: now };
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
