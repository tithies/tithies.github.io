/**
 * After an export: compares the target account's collection (or the decks written) with what it should be, print by
 * print (copies per print + finish + Language field + the print's own language; in the binder for
 * binder targets). Everything the export didn't touch must be unchanged; for the exported prints,
 * after = before − removed + added. A card imported as another print, or in another language,
 * shows up as short + extra.
 */
import { copyKey } from '@/lib/cards/prints';
import { langOf } from '@/lib/cards/languages';
import type { CollectionEntry } from '@/lib/cards/types';
import type { DeckCard } from '@/lib/decks/types';
import { deckKey, MAINBOARD } from './plan';
import type { DeckPlan, ExportPlan, ExportVerification, VerifyDiff } from './types';

interface Slot {
  key: string;
  name: string;
  set: string;
  cn: string;
  finish: VerifyDiff['finish'];
  lang: string;
  printLang: string;
  qty: number;
}

/** game|set|cn|finish|Language field, then "|print language" when the print is in another language. */
const slotKey = (game: string, set: string, cn: string, finish: VerifyDiff['finish'], lang: string, printLang: string) =>
  `${game}|${copyKey(set, cn, finish, lang)}${printLang !== lang ? `|${printLang}` : ''}`;
/** An entry's print language (unknown: the Language field's). */
const entryPrint = (e: CollectionEntry) => langOf({ lang: e.card.lang || e.lang });
/** The print language an item must arrive in (unknown: the Language field's). */
const itemPrint = (i: ExportPlan['items'][number]) => langOf({ lang: i.printLang ?? i.lang });
const entryKey = (e: CollectionEntry) => slotKey(e.game ?? 'paper', e.card.set, e.card.cn, e.finish, langOf(e), entryPrint(e));
const itemKey = (i: ExportPlan['items'][number]) => slotKey('paper', i.set, i.cn, i.finish, langOf(i), itemPrint(i));

/** Copies per print (+ finish + language), split by "in scope" (the binder, or the whole collection) vs the rest. */
function tally(entries: readonly CollectionEntry[], inScope: (e: CollectionEntry) => boolean) {
  const scope = new Map<string, Slot>();
  const rest = new Map<string, Slot>();
  for (const e of entries) {
    const key = entryKey(e);
    const m = inScope(e) ? scope : rest;
    const s = m.get(key);
    if (s) s.qty += e.qty;
    else m.set(key, { key, name: e.card.name, set: e.card.set, cn: e.card.cn, finish: e.finish, lang: langOf(e), printLang: entryPrint(e), qty: e.qty });
  }
  return { scope, rest };
}

/**
 * `before`/`after`: the whole collection, read just before the first change and after the last.
 * `binderId`: the binder the cards went into (binder targets; a new binder's id once created).
 */
export function verifyExport(plan: ExportPlan, before: readonly CollectionEntry[], after: readonly CollectionEntry[], binderId: string | null, now = Date.now()): ExportVerification {
  const inScope = (e: CollectionEntry) => (binderId ? e.binderId === binderId : true);
  const b = tally(before, inScope);
  const a = tally(after, inScope);

  // Expected in scope: before − removed (the plan's entries, all of them for a collection replace) + the export.
  const expected = new Map<string, Slot>();
  for (const s of b.scope.values()) expected.set(s.key, { ...s });
  const removedIds = new Set(plan.remove.entries.map((r) => r.entryId));
  for (const e of before) {
    if (!removedIds.has(e.id) || !inScope(e)) continue;
    const key = entryKey(e);
    const s = expected.get(key);
    if (s) s.qty -= e.qty;
  }
  const cartKeys = new Set<string>();
  for (const i of plan.items) {
    const key = itemKey(i);
    cartKeys.add(key);
    const s = expected.get(key);
    if (s) s.qty += i.qty;
    else expected.set(key, { key, name: i.name, set: i.set, cn: i.cn, finish: i.finish, lang: langOf(i), printLang: itemPrint(i), qty: i.qty });
  }
  // A collection replace also deletes what is outside binders: "rest" is empty then, in both.
  const expectedRest = plan.remove.wholeCollection ? new Map<string, Slot>() : b.rest;

  const short: VerifyDiff[] = [];
  const extra: VerifyDiff[] = [];
  const otherChanged: VerifyDiff[] = [];
  const diff = (s: Slot, exp: number, found: number, outside?: boolean): VerifyDiff => ({
    key: s.key.slice(s.key.indexOf('|') + 1),
    name: s.name,
    set: s.set,
    cn: s.cn,
    finish: s.finish,
    lang: s.lang,
    printLang: s.printLang,
    expected: exp,
    found,
    ...(outside ? { outside } : {}),
  });

  for (const key of new Set([...expected.keys(), ...a.scope.keys()])) {
    const exp = Math.max(0, expected.get(key)?.qty ?? 0);
    const found = a.scope.get(key)?.qty ?? 0;
    if (exp === found) continue;
    const s = (expected.get(key) ?? a.scope.get(key))!;
    if (cartKeys.has(key)) (found < exp ? short : extra).push(diff(s, exp, found));
    // Not in the export: a print that wasn't there is extra (a card imported as another print); one that was there changed.
    else if (!b.scope.has(key) && found > exp) extra.push(diff(s, exp, found));
    else otherChanged.push(diff(s, exp, found));
  }
  for (const key of new Set([...expectedRest.keys(), ...a.rest.keys()])) {
    const exp = expectedRest.get(key)?.qty ?? 0;
    const found = a.rest.get(key)?.qty ?? 0;
    if (exp !== found) otherChanged.push(diff((expectedRest.get(key) ?? a.rest.get(key))!, exp, found, true));
  }

  const byName = (x: VerifyDiff, y: VerifyDiff) => x.name.localeCompare(y.name) || x.key.localeCompare(y.key);
  let expectedCopies = 0;
  let foundCopies = 0;
  for (const key of cartKeys) {
    expectedCopies += Math.max(0, expected.get(key)?.qty ?? 0);
    foundCopies += a.scope.get(key)?.qty ?? 0;
  }
  return {
    ok: !short.length && !extra.length && !otherChanged.length,
    scope: binderId ? 'binder' : 'collection',
    expectedCopies,
    foundCopies,
    short: short.sort(byName),
    extra: extra.sort(byName),
    otherChanged: otherChanged.sort(byName),
    checkedAt: now,
  };
}

/** One deck a deck export wrote: its cards before (none for a new one) and after. */
export interface DeckCheck {
  name: string;
  /** The plan's deck (its cards). */
  plan: DeckPlan;
  before: readonly DeckCard[];
  after: readonly DeckCard[];
}

/** Copies per board|print (set|cn|finish|print language: a deck has no Language field). */
function deckTally(cards: readonly DeckCard[]) {
  const m = new Map<string, Slot & { board: string }>();
  for (const c of cards) {
    const printLang = langOf({ lang: c.card.lang });
    const key = `${c.board}|${deckKey(c.card.set, c.card.cn, c.finish, printLang)}`;
    const s = m.get(key);
    if (s) s.qty += c.qty;
    else m.set(key, { key, board: c.board, name: c.card.name, set: c.card.set, cn: c.card.cn, finish: c.finish, lang: printLang, printLang, qty: c.qty });
  }
  return m;
}

/**
 * After a deck export: each deck's mainboard must be what it was (nothing for a new deck) plus its
 * cards, print by print; its other boards must be unchanged.
 */
export function verifyDecks(decks: readonly DeckCheck[], now = Date.now()): ExportVerification {
  const short: VerifyDiff[] = [];
  const extra: VerifyDiff[] = [];
  const otherChanged: VerifyDiff[] = [];
  let expectedCopies = 0;
  let foundCopies = 0;
  for (const d of decks) {
    const b = deckTally(d.before);
    const a = deckTally(d.after);
    const expected = new Map<string, Slot & { board: string }>();
    for (const [k, s] of b) expected.set(k, { ...s });
    const cartKeys = new Set<string>();
    for (const i of d.plan.items) {
      const printLang = i.lang ?? 'en';
      const key = `${MAINBOARD}|${deckKey(i.set, i.cn, i.finish, printLang)}`;
      cartKeys.add(key);
      const s = expected.get(key);
      if (s) s.qty += i.qty;
      else expected.set(key, { key, board: MAINBOARD, name: i.name, set: i.set, cn: i.cn, finish: i.finish, lang: printLang, printLang, qty: i.qty });
    }
    const diff = (s: Slot & { board: string }, exp: number, found: number): VerifyDiff => ({
      key: s.key,
      name: s.name,
      set: s.set,
      cn: s.cn,
      finish: s.finish,
      lang: s.lang,
      printLang: s.printLang,
      expected: exp,
      found,
      deck: d.name,
      ...(s.board !== MAINBOARD ? { outside: true, board: s.board } : {}),
    });
    for (const key of new Set([...expected.keys(), ...a.keys()])) {
      const exp = expected.get(key)?.qty ?? 0;
      const found = a.get(key)?.qty ?? 0;
      if (cartKeys.has(key)) {
        expectedCopies += exp;
        foundCopies += found;
      }
      if (exp === found) continue;
      const s = (expected.get(key) ?? a.get(key))!;
      if (cartKeys.has(key)) (found < exp ? short : extra).push(diff(s, exp, found));
      // In the mainboard but not in the export: a card added as another print (extra), or one that was there and changed.
      else if (s.board === MAINBOARD && !b.has(key) && found > exp) extra.push(diff(s, exp, found));
      else otherChanged.push(diff(s, exp, found));
    }
  }
  const byName = (x: VerifyDiff, y: VerifyDiff) => (x.deck ?? '').localeCompare(y.deck ?? '') || x.name.localeCompare(y.name) || x.key.localeCompare(y.key);
  return {
    ok: !short.length && !extra.length && !otherChanged.length,
    scope: 'decks',
    expectedCopies,
    foundCopies,
    short: short.sort(byName),
    extra: extra.sort(byName),
    otherChanged: otherChanged.sort(byName),
    checkedAt: now,
  };
}
