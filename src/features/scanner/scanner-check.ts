/**
 * Phase 3 on the page: once a photo's cards are named against the every-print index, each card's print among
 * same-art reprints (print-check.ts) and its language (language.ts). The engine cuts the card out (672 × 936),
 * reads its text (OCR models, loaded on first use from the installed Scanner files) and compares it with the
 * candidates' Scryfall pictures; the rules are the trainer's (verify.py), checked against its cases.
 */
import PQueue from 'p-queue';
import type { ScannerEngine } from './engine-client';
import type { Quad } from './geometry';
import { languageOf, otherScripts, type LanguageResult } from './language';
import type { CardMatch, MethodResult } from './pipeline';
import { afterVisual, beforeVisual, candidates, MAX_PICTURES, printed, type PrintDecision } from './print-check';
import type { TextLineRead, TextModelName } from './protocol';
import { ensureFile, type Installed, type OcrRole } from './published';

/** The method whose results the check reorders (it writes CHECK_METHOD, models.ts). */
export const CHECKED_METHOD = 'dino-pad-cls';
export { CHECK_METHOD } from './models';

const ROLE: Record<TextModelName, OcrRole> = { det: 'ocrDet', latin: 'ocrLatin', main: 'ocrMain', korean: 'ocrKorean', cyrillic: 'ocrCyrillic' };

export interface CardCheck {
  print?: PrintDecision;
  language?: LanguageResult;
  /** Lines read with the Latin recognizer (for the page and the results JSON). */
  lines?: TextLineRead[];
  ms: number;
}

/** Scryfall: pictures politely (4 at a time, at most 8 a second), printed names by card name (cached). */
const scryfall = new PQueue({ concurrency: 4, intervalCap: 8, interval: 1000 });
const names = new Map<string, Promise<Record<string, string[]> | null>>();

export function printedNames(name: string, fetchFn: typeof fetch = fetch): Promise<Record<string, string[]> | null> {
  let p = names.get(name);
  if (!p) {
    p = (async () => {
      const out: Record<string, string[]> = {};
      let url: string | null = `https://api.scryfall.com/cards/search?${new URLSearchParams({ q: `!"${name}"`, unique: 'prints', include_multilingual: 'true' })}`;
      for (let page = 0; url && page < 4; page++) {
        const res = (await scryfall.add(() => fetchFn(url!, { headers: { Accept: 'application/json' } }))) as Response;
        if (!res.ok) return page ? out : null;
        const data = (await res.json()) as { data: { lang: string; name: string; printed_name?: string; card_faces?: { name: string; printed_name?: string }[] }[]; has_more?: boolean; next_page?: string };
        for (const c of data.data) {
          for (const face of c.card_faces ?? [c]) {
            const n = face.printed_name ?? c.printed_name ?? face.name ?? c.name;
            const list = (out[c.lang] ??= []);
            if (!list.includes(n)) list.push(n);
          }
        }
        url = data.has_more ? (data.next_page ?? null) : null;
      }
      return out;
    })().catch(() => null);
    names.set(name, p);
  }
  return p;
}

/** A print's Scryfall 'large' picture (672 × 936), or null. */
async function picture(hit: CardMatch, fetchFn: typeof fetch = fetch): Promise<ImageBitmap | null> {
  const id = hit.scryfallId;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const url = `https://cards.scryfall.io/large/${hit.back ? 'back' : 'front'}/${id[0]}/${id[1]}/${id}.jpg`;
  try {
    const res = (await scryfall.add(() => fetchFn(url))) as Response;
    return res.ok ? await createImageBitmap(await res.blob()) : null;
  } catch {
    return null;
  }
}

/** The OCR models in the engine, loaded on first use from the installed files. */
export class TextModels {
  private loaded = new Map<TextModelName, Promise<void>>();
  private dicts: Promise<Record<string, string[]>> | null = null;

  constructor(
    private readonly engine: ScannerEngine,
    private readonly installed: Installed,
  ) {}

  /** The installed files have the OCR models (the detector and Latin recognizer at least). */
  get available(): boolean {
    const f = this.installed.manifest.files;
    return !!(f.ocrDet && f.ocrLatin && f.ocrDicts);
  }

  ensure(name: TextModelName): Promise<void> {
    let p = this.loaded.get(name);
    if (!p) {
      p = (async () => {
        const bytes = await ensureFile(this.installed, ROLE[name]);
        let chars: string[] | undefined;
        if (name !== 'det') {
          this.dicts ??= ensureFile(this.installed, 'ocrDicts').then((b) => JSON.parse(new TextDecoder().decode(b)) as Record<string, string[]>);
          chars = (await this.dicts)[name];
        }
        await this.engine.call({ type: 'loadTextModel', name, bytes, chars }, [bytes]);
      })();
      p.catch(() => this.loaded.delete(name));
      this.loaded.set(name, p);
    }
    return p;
  }
}

/** The card's corners the right way up for the cut-out (the search matched it turned when `turned`). */
const upright = (quad: Quad, turned: boolean): Quad => (turned ? [quad[2], quad[3], quad[0], quad[1]] : quad);

let nextDetail = 1;

/**
 * Checks one card of a photo loaded in the engine: its print among the same-art candidates in `result.more`, and
 * its language. Returns the reordered result (the pick first) and what was decided.
 */
export async function checkCard(
  engine: ScannerEngine,
  models: TextModels,
  photoId: string,
  quad: Quad,
  result: MethodResult,
  opts: { prints: boolean; language: boolean },
): Promise<{ result: MethodResult; check: CardCheck }> {
  const t0 = performance.now();
  const hits = result.more ?? result.candidates;
  const detailId = `d${nextDetail++}`;
  const check: CardCheck = { ms: 0 };
  let pick = 0;
  await engine.call({ type: 'cardDetail', photoId, detailId, quad: upright(quad, result.turned) });
  try {
    await models.ensure('det');
    await models.ensure('latin');
    const lines = (await engine.call({ type: 'readText', detailId, model: 'latin' })).lines;
    check.lines = lines;
    if (opts.prints) {
      const b = beforeVisual(hits, lines);
      let d = b.decided;
      if (!d) {
        const pool = b.pool.slice(0, MAX_PICTURES);
        const pics = await Promise.all(pool.map((i) => picture(hits[i])));
        const used = pool.filter((_, k) => pics[k]);
        const bitmaps = pics.filter((x): x is ImageBitmap => !!x);
        let visual: { winner: number | null; margin: number } | null = null;
        if (bitmaps.length >= 2) visual = await engine.call({ type: 'checkPrint', detailId, pictures: bitmaps }, bitmaps);
        else bitmaps.forEach((x) => x.close());
        d = afterVisual(b.pool, b.narrowed, used, visual, b.read);
      }
      check.print = d;
      pick = d.pick;
    }
    if (opts.language) {
      const chosen = hits[pick];
      const sets = [...new Set([pick, ...candidates(hits)].map((i) => printed(hits[i])[0]))];
      check.language = await languageOf(lines, {
        sets,
        name: chosen?.name ?? null,
        deps: {
          otherScripts: () =>
            otherScripts(lines, async (model, idx) => {
              await models.ensure(model);
              return (await engine.call({ type: 'readText', detailId, model, lines: idx })).lines;
            }),
          printedNames,
        },
      });
    }
  } finally {
    await engine.call({ type: 'releaseDetail', detailId }).catch(() => undefined);
    check.ms = performance.now() - t0;
  }
  const chosen = hits[pick];
  const candidatesOut = [chosen, ...hits.filter((_, i) => i !== pick)].slice(0, 5);
  return { result: { ...result, candidates: candidatesOut }, check };
}
