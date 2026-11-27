/**
 * What each scanned card says, once the user's corrections and the checks are applied: its print, language, finish
 * and how sure it is; and the session's cards as export items (lib/export), one per card. The export merges the same
 * print, finish and language into one line with a quantity.
 */
import type { Finish } from '@/lib/cards/types';
import type { ExportItem } from '@/lib/export/types';
import { confidence, type CardMatch } from './pipeline';
import { candidates, type PrintHow } from './print-check';
import type { StoredCard, StoredPhoto } from './scan-session';

/** The finishes bitmask of the every-print index (index-file.ts): 1 non-foil, 2 foil, 4 etched (8 glossy is a kind of non-foil). */
const FINISH_BITS: [Finish, number][] = [
  ['nonFoil', 1],
  ['foil', 2],
  ['etched', 4],
];

type PrintRow = CardMatch & { finishes?: number; art?: number };

/** The finishes a print exists in (every finish when the print doesn't say). */
export function finishesOf(p: PrintRow | undefined): Finish[] {
  const bits = p?.finishes;
  if (!bits) return ['nonFoil', 'foil', 'etched'];
  const out = FINISH_BITS.filter(([, b]) => bits & b).map(([f]) => f);
  return out.length ? out : ['nonFoil'];
}

/** Non-foil, unless the print exists only in foil (or only etched). */
export const defaultFinish = (p: PrintRow | undefined): Finish => finishesOf(p)[0];

/** The print the card is taken for: the user's pick, else the check's, else the search's best. */
export function chosenPrint(c: StoredCard): PrintRow | undefined {
  if (c.edit?.print) return c.edit.print;
  const pick = c.check?.print?.pick;
  if (pick !== undefined) return (c.result.more ?? c.result.candidates)[pick] ?? c.result.candidates[0];
  return c.result.candidates[0];
}

/** Scryfall language code: the user's, else the one read on the card, else English. */
export const cardLang = (c: StoredCard): string => c.edit?.lang ?? c.check?.language?.lang ?? 'en';

/** The user's finish when the chosen print exists in it, else the print's default. */
export function cardFinish(c: StoredCard): Finish {
  const p = chosenPrint(c);
  const f = c.edit?.finish;
  return f && finishesOf(p).includes(f) ? f : defaultFinish(p);
}

/** The prints the check decides between: the same name and artwork among the search's top 20 (indices into `more`). */
export const sameArtPrints = (c: StoredCard): number[] => (c.result.more ? candidates(c.result.more) : []);

const DECIDED: PrintHow[] = ['only print', 'read', 'read + checked', 'checked', 'checked: kept'];

/**
 * How sure a card is, for its colour:
 * - 'user': the user corrected it;
 * - 'sure': the name is sure, and its print decided (the only print with that artwork, read on the card, or the picture check);
 * - 'review': the name needs a look, or the print is unsure (or not checked among several same-art prints);
 * - 'unknown': no good match.
 */
export type CardStatus = 'user' | 'sure' | 'review' | 'unknown';

export function cardStatus(c: StoredCard): CardStatus {
  if (c.edit?.print || c.edit?.lang || c.edit?.finish) return 'user';
  const name = confidence(c.result, 'dino-pad-cls', 'tuned');
  if (name !== 'sure') return name;
  if (sameArtPrints(c).length < 2) return 'sure';
  return c.check?.print && DECIDED.includes(c.check.print.how) ? 'sure' : 'review';
}

/** A card in the list: not removed. */
export const listed = (c: StoredCard): boolean => !c.edit?.removed;

/** The session's cards to export: listed, not sent yet, one item each (key photo id:number). */
export function toExportItems(photos: readonly StoredPhoto[]): ExportItem[] {
  const out: ExportItem[] = [];
  for (const p of photos) {
    for (const c of p.cards) {
      if (!listed(c) || c.sentAt) continue;
      const print = chosenPrint(c);
      if (!print) continue;
      out.push({
        key: `${p.id}:${c.n}`,
        // Moxfield's import finds the print by set and number.
        cardId: '',
        scryfallId: print.scryfallId,
        name: print.name,
        set: print.set,
        setName: print.setName,
        cn: print.cn,
        finish: cardFinish(c),
        lang: cardLang(c),
        // The print's own language (the index's prints: English but for the few printed only in another language).
        printLang: print.lang ?? 'en',
        qty: 1,
        note: 'Scanned',
      });
    }
  }
  return out;
}
