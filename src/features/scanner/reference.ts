/**
 * The reference set of phase 0: the prints the current account owns (its synced collection),
 * each turned into vectors from its Scryfall image. Images are fetched politely (4 at a time,
 * at most 10 a second) and not kept; vectors are saved after each group of 8 prints, so a
 * cancelled or interrupted build resumes where it stopped.
 */
import PQueue from 'p-queue';
import type { CollectionEntry } from '@/lib/cards/types';
import { scryfallImage } from '@/lib/f2f/links';
import type { ScannerEngine } from './engine-client';
import { currentRefIds, MODEL_KEY, scannerDb, type RefRow } from './store';

export interface PrintInfo {
  scryfallId: string;
  name: string;
  set: string;
  setName: string;
  cn: string;
  lang?: string;
}

/** One entry per print (Scryfall id) of the collection. */
export function ownedPrints(entries: readonly CollectionEntry[]): PrintInfo[] {
  const byId = new Map<string, PrintInfo>();
  for (const e of entries) {
    const c = e.card;
    if (!c.scryfallId || byId.has(c.scryfallId)) continue;
    byId.set(c.scryfallId, { scryfallId: c.scryfallId, name: c.name, set: c.set, setName: c.setName, cn: c.cn, lang: c.lang });
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

export async function buildReferences(
  engine: ScannerEngine,
  prints: readonly PrintInfo[],
  opts: { signal: AbortSignal; onProgress: (p: BuildProgress) => void },
): Promise<BuildProgress> {
  const have = await currentRefIds();
  const todo = prints.filter((p) => !have.has(p.scryfallId) && scryfallImage(p.scryfallId, 'normal'));
  const progress: BuildProgress = { done: 0, total: todo.length, failed: 0, skipped: prints.length - todo.length, startedAt: Date.now() };
  opts.onProgress({ ...progress });
  const fetches = new PQueue({ concurrency: 4, intervalCap: 10, interval: 1000 });
  const fetchImage = (p: PrintInfo) =>
    fetches.add(async () => {
      const res = await fetch(scryfallImage(p.scryfallId, 'normal')!, { signal: opts.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return createImageBitmap(await res.blob());
    });
  /** One group's images; a failed one is null (counted, and tried again next build). */
  const fetchGroup = (group: PrintInfo[]) =>
    Promise.all(
      group.map((p) =>
        fetchImage(p).catch((e) => {
          if (!opts.signal.aborted) console.warn(`Scanner reference ${p.set} #${p.cn} (${p.scryfallId}):`, e);
          return null;
        }),
      ),
    );
  const groups: PrintInfo[][] = [];
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
    const ok = groups[g].flatMap((p, i) => (bitmaps[i] ? [{ p, bitmap: bitmaps[i]! }] : []));
    progress.failed += groups[g].length - ok.length;
    if (ok.length) {
      const { features } = await engine.call({ type: 'imageFeatures', bitmaps: ok.map((x) => x.bitmap) }, ok.map((x) => x.bitmap));
      const now = Date.now();
      await scannerDb.refs.bulkPut(ok.map(({ p }, i): RefRow => ({ ...p, modelKey: MODEL_KEY, vectors: features[i].vectors, phash: features[i].phash, addedAt: now })));
      progress.done += ok.length;
    }
    opts.onProgress({ ...progress });
  }
  fetches.clear();
  return progress;
}
