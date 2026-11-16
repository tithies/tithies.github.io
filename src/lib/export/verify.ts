/**
 * After an export: compares the target account's collection with what it should be, print by
 * print (copies per print + finish; in the binder for binder targets). Everything the export
 * didn't touch must be unchanged; for the exported prints, after = before − removed + added.
 */
import { printKey } from '@/lib/cards/prints';
import type { CollectionEntry } from '@/lib/cards/types';
import type { ExportPlan, ExportVerification, VerifyDiff } from './types';

interface Slot {
  key: string;
  name: string;
  set: string;
  cn: string;
  finish: VerifyDiff['finish'];
  qty: number;
}

/** Copies per print (+ finish), split by "in scope" (the binder, or the whole collection) vs the rest. */
function tally(entries: readonly CollectionEntry[], inScope: (e: CollectionEntry) => boolean) {
  const scope = new Map<string, Slot>();
  const rest = new Map<string, Slot>();
  for (const e of entries) {
    const key = `${e.game ?? 'paper'}|${printKey(e.card.set, e.card.cn, e.finish)}`;
    const m = inScope(e) ? scope : rest;
    const s = m.get(key);
    if (s) s.qty += e.qty;
    else m.set(key, { key, name: e.card.name, set: e.card.set, cn: e.card.cn, finish: e.finish, qty: e.qty });
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
    const key = `${e.game ?? 'paper'}|${printKey(e.card.set, e.card.cn, e.finish)}`;
    const s = expected.get(key);
    if (s) s.qty -= e.qty;
  }
  const cartKeys = new Set<string>();
  for (const i of plan.items) {
    const key = `paper|${printKey(i.set, i.cn, i.finish)}`;
    cartKeys.add(key);
    const s = expected.get(key);
    if (s) s.qty += i.qty;
    else expected.set(key, { key, name: i.name, set: i.set, cn: i.cn, finish: i.finish, qty: i.qty });
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
