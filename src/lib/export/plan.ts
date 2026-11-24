/**
 * What an export will do, computed from a live read of the target account (pure: the dialog's
 * preview and the background job compute the same plan, and compare digests).
 */
import type { AccountKey } from '@/lib/accounts/types';
import { langOf } from '@/lib/cards/languages';
import { copyKey } from '@/lib/cards/prints';
import type { CollectionEntry } from '@/lib/cards/types';
import type { DeckSummary } from '@/lib/decks/types';
import { folderDecks, groupingFields } from './grouping';
import {
  isDeckTarget,
  type DeckContent,
  type DeckPlan,
  type DeckTarget,
  type ExportItem,
  type ExportPlan,
  type ExportTarget,
  type PlanWarning,
  type RemovedEntry,
  type TargetRead,
  type TargetState,
} from './types';

/** Most decks one deck folder export makes or adds to. */
export const MAX_FOLDER_DECKS = 100;
/** The board deck exports write into. */
export const MAINBOARD = 'mainboard';

/** Most rows in one import, and most entries removed in one request (the site's limits, see its exporter). */
export interface PlanLimits {
  importRows: number;
  removeEntries: number;
  pageSize: number;
  /**
   * Items the site's import can't add as they are, added one request each instead (Moxfield: a
   * print in another language than English, whose CSV import would pick the English print).
   */
  oneByOne?: (item: ExportItem) => boolean;
  /**
   * Decks: most cards a deck holds (every board), most copies of a card one add by card id sends,
   * import text lines per request, and the items the import text can't add as they are.
   */
  deck?: {
    maxCards: number;
    maxAddQty: number;
    importLines: number;
    oneByOne: (item: ExportItem) => boolean;
    /** The site's rule for a folder's names (a full path, "/"-separated), and what to say when one breaks it. */
    folderName?: { test: (path: string) => boolean; text: string };
  };
}

export interface PlanContext {
  /** The account the cards come from (its comparison), if any. */
  sourceAccountKey: AccountKey | null;
  /** "alice" */
  targetName: string;
  limits: PlanLimits;
  /** Tithies has a recent snapshot of the target's collection: reading it again is usually one page (its changes). */
  savedCollection?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;

/**
 * What the preview must read: nothing more than the binder list for a new binder, the binder's
 * cards for an existing one, the collection's totals to add to it, the whole of it to replace it.
 */
export function previewRead(target: ExportTarget): TargetRead {
  // Decks: the deck list and folders (its counts are enough to add), plus an existing deck's cards (for its check).
  if (target.kind === 'deck') return { kind: 'decks', publicIds: [target.publicId] };
  if (isDeckTarget(target)) return { kind: 'decks' };
  if (target.kind === 'newBinder') return { kind: 'binders' };
  if (target.kind === 'binder') return { kind: 'binder', binderId: target.binderId };
  return target.mode === 'replace' ? { kind: 'collection' } : { kind: 'totals' };
}

/** What the export reads before changing anything: the preview's read, and the whole collection to add to it (the check compares every print). */
export function beforeRead(target: ExportTarget): TargetRead {
  return target.kind === 'collection' ? { kind: 'collection' } : previewRead(target);
}

/** What the check reads afterwards: the binder the cards went into, or the whole collection (decks: the decks written, see the job). */
export function afterRead(target: ExportTarget, binderId: string | null): TargetRead {
  if (isDeckTarget(target)) return { kind: 'decks' };
  return target.kind !== 'collection' && binderId ? { kind: 'binder', binderId } : { kind: 'collection' };
}

/** The state was read for this target (the dialog reads it before previewing). */
export function stateCovers(state: TargetState, read: TargetRead): boolean {
  const r = state.read;
  if (read.kind === 'decks') return r.kind === 'decks' && !!state.decks && (read.publicIds ?? []).every((id) => !!state.deckCards?.[id]);
  if (r.kind === 'decks') return false;
  if (read.kind === 'binders') return true;
  if (read.kind === 'binder') return (r.kind === 'binder' && r.binderId === read.binderId) || r.kind === 'collection';
  if (read.kind === 'totals') return r.kind === 'totals' || r.kind === 'collection';
  return r.kind === 'collection';
}

/** Merges items of the same print in the same language (set + collector number + finish + language, whatever their list key), drops empty ones. */
export function mergeItems(items: readonly ExportItem[]): ExportItem[] {
  const by = new Map<string, ExportItem>();
  for (const i of items) {
    if (!(i.qty > 0)) continue;
    const key = copyKey(i.set, i.cn, i.finish, i.lang);
    const prev = by.get(key);
    by.set(key, prev ? { ...prev, qty: prev.qty + i.qty } : { ...i, key });
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

const removed = (e: CollectionEntry): RemovedEntry => ({
  entryId: e.id,
  cardId: e.card.id,
  name: e.card.name,
  set: e.card.set,
  cn: e.card.cn,
  finish: e.finish,
  qty: e.qty,
  condition: e.condition,
  lang: e.lang,
  isProxy: e.isProxy,
  isAlter: e.isAlter,
  ...(e.binderId ? { binderId: e.binderId } : {}),
});

/** FNV-1a, enough to notice a change between the preview and the run. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

const copies = (entries: readonly { qty: number }[]) => entries.reduce((s, e) => s + e.qty, 0);

/** A target's fields in a fixed order (the digest doesn't depend on how the object was built). */
const targetFields = (t: ExportTarget): unknown[] => {
  switch (t.kind) {
    case 'newBinder':
      return [t.accountKey, t.kind, t.name, t.visibility];
    case 'binder':
      return [t.accountKey, t.kind, t.binderId, t.mode];
    case 'collection':
      return [t.accountKey, t.kind, t.mode];
    case 'newDeck':
      return [t.accountKey, t.kind, t.name, t.visibility, t.folderId];
    case 'deck':
      return [t.accountKey, t.kind, t.deckId, t.publicId];
    case 'newFolder':
      return [t.accountKey, t.kind, t.name, t.parentFolderId, t.visibility, groupingFields(t.grouping)];
    case 'folder':
      return [t.accountKey, t.kind, t.folderId, t.visibility, groupingFields(t.grouping)];
  }
};
const chunks = (n: number, size: number) => (n > 0 ? Math.ceil(n / Math.max(1, size)) : 0);

export function planExport(target: ExportTarget, rawItems: readonly ExportItem[], state: TargetState, ctx: PlanContext): ExportPlan {
  if (isDeckTarget(target)) return planDeckExport(target, rawItems, state, ctx);
  const items = mergeItems(rawItems);
  const add = { prints: items.length, copies: copies(items) };
  const warnings: PlanWarning[] = [];
  const steps: string[] = [];
  const who = ctx.targetName;
  let blocked: string | undefined = stateCovers(state, previewRead(target)) ? undefined : `Read ${who}'s ${target.kind === 'binder' ? 'binder' : 'collection'} first.`;
  let binder = null;
  let targetLabel: string;
  let toRemove: CollectionEntry[] = [];
  let wholeCollection = false;
  let before: number;
  /** A new binder: the account already has a binder of that name. */
  let sameName = false;

  if (target.kind === 'newBinder') {
    targetLabel = `the new binder “${target.name.trim()}”`;
    before = 0;
    if (!target.name.trim()) blocked = 'Give the new binder a name.';
    sameName = state.binders.some((b) => b.name.trim().toLowerCase() === target.name.trim().toLowerCase());
    if (sameName) {
      warnings.push({ level: 'warning', text: `${who} already has a binder named “${target.name.trim()}”: a second one with the same name would be created.` });
    }
    steps.push(`Create the ${target.visibility} binder “${target.name.trim()}” on ${who}`);
  } else if (target.kind === 'binder') {
    binder = state.binders.find((b) => b.id === target.binderId) ?? null;
    targetLabel = binder ? `the binder “${binder.name}”` : 'a binder that no longer exists';
    if (!binder) blocked = `This binder isn't on ${who} any more: read the account again.`;
    const inBinder = state.entries.filter((e) => e.binderId === target.binderId);
    before = copies(inBinder);
    if (target.mode === 'replace') {
      toRemove = inBinder;
      if (inBinder.length) {
        steps.push(`Delete the ${plural(copies(inBinder), 'copy', 'copies')} (${plural(inBinder.length, 'entry', 'entries')}) now in ${targetLabel}`);
        warnings.push({
          level: 'danger',
          text: `Binder cards are collection cards on this site: if you confirm, the ${plural(copies(inBinder), 'copy', 'copies')} now in ${targetLabel} will be deleted from ${who}'s collection, not just taken out of the binder.`,
        });
      }
    }
  } else {
    targetLabel = `${who}'s collection`;
    before = state.read.kind === 'collection' ? copies(state.entries) : (state.totals?.copies ?? 0);
    if (target.mode === 'replace') {
      toRemove = state.entries;
      wholeCollection = true;
      if (state.entries.length) {
        steps.push(`Delete ${who}'s whole collection: ${plural(before, 'copy', 'copies')} in ${plural(state.entries.length, 'entry', 'entries')}, binders' cards included`);
        warnings.push({
          level: 'danger',
          text: `If you confirm, every card of ${who}'s collection will be deleted (${plural(before, 'copy', 'copies')}), including the cards in binders. Only the cards of this export would be left.`,
        });
      }
    }
  }

  const single = ctx.limits.oneByOne ? items.filter(ctx.limits.oneByOne).length : 0;
  const csvImports = chunks(items.length - single, ctx.limits.importRows);
  const imports = csvImports + single;
  if (items.length) {
    steps.push(
      `Add ${plural(add.copies, 'copy', 'copies')} (${plural(add.prints, 'print')}) to ${target.kind === 'collection' ? `${who}'s collection, not in a binder` : targetLabel}, Near Mint, each card in its language${csvImports > 1 ? `, in ${csvImports} imports` : ''}${single ? `; ${plural(single, 'print')} in another language than English one by one, to keep their exact print` : ''}`,
    );
  } else {
    blocked ??= 'Nothing to export.';
  }
  steps.push(target.kind === 'collection' ? `Read ${who}'s collection again and check every copy` : `Read the binder again and check every copy`);

  if (ctx.sourceAccountKey && ctx.sourceAccountKey === target.accountKey) {
    warnings.push({
      level: 'warning',
      text: `${who} is the account you're comparing. Binder cards are collection cards, so if you confirm, the exported cards will become part of its collection: “Missing from collection” cards would stop being missing, and “Not in any deck” cards would then be in it twice.`,
    });
  }

  const removeCopies = copies(toRemove);
  const after = target.kind === 'collection' ? (wholeCollection ? 0 : before) + add.copies : (target.kind === 'binder' && target.mode === 'replace' ? 0 : before) + add.copies;
  const writes =
    (target.kind === 'newBinder' ? 1 : 0) + (wholeCollection ? (toRemove.length ? 1 : 0) : chunks(toRemove.length, ctx.limits.removeEntries)) + imports;
  // The export's own reads: the binder list, then (before) what the target needs, and (after) the binder or the collection.
  const pages = (entries: number) => Math.max(1, chunks(entries, ctx.limits.pageSize));
  const collectionEntries = state.read.kind === 'collection' ? state.entries.length : (state.totals?.entries ?? 0);
  const targetEntries = target.kind === 'binder' ? state.entries.filter((e) => e.binderId === target.binderId).length : 0;
  // Before: the binder, or every page of the collection (only the changes since the saved snapshot when there is one).
  const beforePages = target.kind === 'newBinder' ? 0 : target.kind === 'binder' ? pages(targetEntries) : ctx.savedCollection ? 1 : pages(collectionEntries);
  // Check: the binder as it is after, or only the collection's changes since "before".
  const checkPages = target.kind === 'binder' ? pages((target.mode === 'replace' ? 0 : targetEntries) + items.length) : pages(items.length);
  const reads = 1 + beforePages + checkPages;

  // What the run must find unchanged: what the plan read of the binders (the binder targeted and
  // its name, or whether a binder has the new one's name), and every entry it deletes. Nothing
  // else: an export made just before to another binder of the account (several targets) doesn't
  // change this one.
  const binderFacts =
    target.kind === 'binder' ? (binder ? [binder.id, binder.name] : null) : target.kind === 'newBinder' ? sameName : null;
  const digest = hash(JSON.stringify([targetFields(target), items.map((i) => [i.key, i.qty]), binderFacts, toRemove.map((e) => [e.id, e.qty]).sort()]));

  return {
    target,
    binder,
    targetLabel,
    items,
    add,
    remove: { entries: toRemove.map(removed), copies: removeCopies, wholeCollection },
    before,
    after,
    steps,
    writes,
    reads,
    requests: { before: beforePages, write: writes, check: checkPages },
    warnings,
    digest,
    ...(blocked ? { blocked } : {}),
  };
}

const n = (v: number) => v.toLocaleString('en-CA');
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** Copies in a deck as the deck list says (every board; the mainboard count includes the commanders). */
const listedSize = (d: DeckSummary) => d.mainboardCount + d.sideboardCount + d.maybeboardCount;
const contentSize = (c: DeckContent) => c.cards.reduce((s, x) => s + x.qty, 0);

/**
 * The print language a card arrives in, in a deck: its own for an item added by card id, else the
 * English print (the import text has no language).
 */
export const deckPrintLang = (i: ExportItem, oneByOne: (i: ExportItem) => boolean) => (oneByOne(i) ? langOf({ lang: i.printLang }) : 'en');
/** A deck print: set|cn|finish|print language (a deck has no Language field). */
export const deckKey = (set: string, cn: string, finish: string, printLang: string) => `${set.toLowerCase()}|${cn}|${finish}|${printLang}`;

/** Items merged by the print they become in a deck (two Language fields of one print are one deck card). */
export function mergeForDeck(items: readonly ExportItem[], oneByOne: (i: ExportItem) => boolean): ExportItem[] {
  const by = new Map<string, ExportItem>();
  for (const i of items) {
    if (!(i.qty > 0)) continue;
    const lang = deckPrintLang(i, oneByOne);
    const key = deckKey(i.set, i.cn, i.finish, lang);
    const prev = by.get(key);
    by.set(key, prev ? { ...prev, qty: prev.qty + i.qty } : { ...i, key, lang });
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key));
}

/**
 * A deck export: a new deck, an existing deck (its cards stay), or a deck folder (new or existing)
 * with one deck per group. The cards are added to the mainboard. A deck that would hold more cards
 * than the site shows refuses the export.
 */
function planDeckExport(target: DeckTarget, rawItems: readonly ExportItem[], state: TargetState, ctx: PlanContext): ExportPlan {
  const items = mergeItems(rawItems);
  const add = { prints: items.length, copies: copies(items) };
  const warnings: PlanWarning[] = [];
  const steps: string[] = [];
  const who = ctx.targetName;
  const lim = ctx.limits.deck;
  let blocked: string | undefined = !lim ? "Tithies can't export to decks on this site." : stateCovers(state, previewRead(target)) ? undefined : `Read ${who}'s decks first.`;
  const oneByOne = lim?.oneByOne ?? (() => false);
  const maxCards = lim?.maxCards ?? Number.POSITIVE_INFINITY;
  const maxAdd = lim?.maxAddQty ?? Number.POSITIVE_INFINITY;
  const decks = state.decks ?? [];
  const folders = state.folders ?? [];
  let targetLabel = '';
  let folder: ExportPlan['folder'];
  let groups: { name: string; items: ExportItem[]; existing: DeckSummary | null }[] = [];
  /** What the run must find unchanged (see the digest below). */
  let facts: unknown = null;
  const isFolder = target.kind === 'newFolder' || target.kind === 'folder';

  switch (target.kind) {
    case 'newDeck': {
      const name = target.name.trim();
      const f = target.folderId ? (folders.find((x) => x.id === target.folderId) ?? null) : null;
      targetLabel = `the new deck “${name}”`;
      if (!name) blocked ??= 'Give the new deck a name.';
      if (target.folderId && !f) blocked ??= `This folder isn't on ${who} any more: read the account again.`;
      if (f) folder = { id: f.id, path: f.path, create: false };
      const same = decks.some((d) => (d.folderId ?? null) === (target.folderId ?? null) && sameName(d.name, name));
      if (same) warnings.push({ level: 'warning', text: `${who} already has a deck named “${name}”${f ? ' in this folder' : ''}: a second one with the same name would be created.` });
      groups = [{ name, items, existing: null }];
      facts = [f?.path ?? null, same];
      break;
    }
    case 'deck': {
      const d = decks.find((x) => x.id === target.deckId && x.publicId === target.publicId) ?? null;
      targetLabel = d ? `the deck “${d.name}”` : 'a deck that no longer exists';
      if (!d) blocked ??= `This deck isn't on ${who} any more: read the account again.`;
      if (d) groups = [{ name: d.name, items, existing: d }];
      facts = d ? [d.id, d.lastUpdatedAt] : null;
      break;
    }
    case 'newFolder': {
      const name = target.name.trim();
      const parent = target.parentFolderId ? (folders.find((x) => x.id === target.parentFolderId) ?? null) : null;
      const path = parent ? `${parent.path}/${name}` : name;
      targetLabel = `the new folder “${path}”`;
      if (!name) blocked ??= 'Give the new folder a name.';
      else if (lim?.folderName && !lim.folderName.test(path)) blocked ??= lim.folderName.text;
      if (target.parentFolderId && !parent) blocked ??= `The folder to put it in isn't on ${who} any more: read the account again.`;
      const exists = folders.some((f) => sameName(f.path, path));
      if (exists) blocked ??= `${who} already has a folder “${path}”: pick it as an existing folder instead.`;
      folder = { id: null, path, create: true };
      groups = folderDecks(items, target.grouping, path).map((g) => ({ ...g, existing: null }));
      facts = [parent?.path ?? null, exists];
      steps.push(`Create the folder “${path}” on ${who}`);
      break;
    }
    case 'folder': {
      const f = folders.find((x) => x.id === target.folderId) ?? null;
      targetLabel = f ? `the folder “${f.path}”` : 'a folder that no longer exists';
      if (!f) blocked ??= `This folder isn't on ${who} any more: read the account again.`;
      if (f) {
        folder = { id: f.id, path: f.path, create: false };
        // Its own decks only (not those of the folders in it), the same one every time for a name.
        const inFolder = decks.filter((d) => d.folderId === f.id).sort((a, b) => a.id.localeCompare(b.id));
        groups = folderDecks(items, target.grouping, f.path).map((g) => {
          const same = inFolder.filter((d) => sameName(d.name, g.name));
          if (same.length > 1) warnings.push({ level: 'info', text: `The folder has ${same.length} decks named “${g.name}”: the cards go into the first one.` });
          return { ...g, existing: same[0] ?? null };
        });
      }
      facts = [f?.path ?? null, groups.map((g) => (g.existing ? [g.existing.id, g.existing.lastUpdatedAt] : null))];
      break;
    }
  }

  if (isFolder && items.some((i) => !i.group)) {
    blocked ??= "Tithies needs each card's set, rarity and color identity (read from Scryfall) to split the cards into decks: wait for them, or try again.";
  }
  if (groups.length > MAX_FOLDER_DECKS) blocked ??= `That would make ${n(groups.length)} decks: at most ${MAX_FOLDER_DECKS} in one export. Split the cards into fewer groups.`;

  const deckPlans: DeckPlan[] = groups.map((g) => {
    const dItems = mergeForDeck(g.items, oneByOne);
    const c = copies(dItems);
    const content = g.existing ? state.deckCards?.[g.existing.publicId] : undefined;
    const now = g.existing ? (content ? contentSize(content) : listedSize(g.existing)) : 0;
    const after = now + c;
    let over: string | undefined;
    if (content?.tooBig) over = `“${g.name}” already has more cards than a deck shows (over ${n(maxCards)}): Tithies couldn't check it.`;
    else if (after > maxCards) over = `“${g.name}” would have ${n(after)} cards${g.existing ? ` (${n(now)} now)` : ''}: a deck shows at most ${n(maxCards)}.`;
    const big = dItems.find((i) => oneByOne(i) && i.qty > maxAdd);
    if (!over && big) over = `“${g.name}”: ${big.name} has ${n(big.qty)} copies in another language than English, and Tithies adds at most ${n(maxAdd)} of those at once.`;
    return { name: g.name, existing: g.existing ? { id: g.existing.id, publicId: g.existing.publicId } : null, items: dItems, copies: c, before: now, after, ...(over ? { over } : {}) };
  });
  const overs = deckPlans.filter((d) => d.over);
  if (overs.length) {
    const hint = isFolder ? 'Split them into more groups, or take cards out of the export.' : 'Take cards out of the export, or export to a deck folder split into several decks.';
    blocked ??= `${overs.length === 1 ? overs[0].over : `${overs.length} decks are too big: ${overs.slice(0, 3).map((d) => d.over).join(' ')}${overs.length > 3 ? ' …' : ''}`} ${hint}`;
  }
  if (!items.length) blocked ??= 'Nothing to export.';

  // The steps: each deck when there are few, else what they add up to (the Decks list has them all).
  const visibility = target.kind === 'deck' ? '' : `${target.visibility} `;
  const created = deckPlans.filter((d) => !d.existing);
  const into = deckPlans.filter((d) => d.existing);
  const what = (d: DeckPlan) => `${plural(d.copies, 'copy', 'copies')} (${plural(d.items.length, 'print')})`;
  if (deckPlans.length <= 6) {
    for (const d of deckPlans) {
      if (!d.existing) steps.push(`Create the ${visibility}deck “${d.name}”${folder ? ` in the folder “${folder.path}”` : ''}, with ${what(d)} in its mainboard`);
      else steps.push(`Add ${what(d)} to the mainboard of “${d.name}”${isFolder ? ' (already in the folder)' : ''} (its cards stay)`);
    }
  } else {
    if (created.length) steps.push(`Create ${plural(created.length, `${visibility}deck`)} in the folder, ${plural(copies(created.flatMap((d) => d.items)), 'copy', 'copies')} in all (see Decks below)`);
    if (into.length) steps.push(`Add ${plural(copies(into.flatMap((d) => d.items)), 'copy', 'copies')} to the mainboard of the ${plural(into.length, 'deck')} already in the folder with the same name`);
  }
  const single = deckPlans.reduce((s, d) => s + d.items.filter(oneByOne).length, 0);
  const otherLanguage = items.some((i) => langOf(i) !== deckPrintLang(i, oneByOne));
  if (items.length) {
    steps.push(
      `Each card goes in as its exact print and finish${single ? `; ${plural(single, 'print')} in another language than English one by one, to keep their exact print` : ''}${
        otherLanguage ? '. A deck has no Language field: a copy whose Language differs from its print goes in as its print' : ''
      }`,
    );
  }
  steps.push(deckPlans.length > 1 ? 'Read each deck again and check every copy' : 'Read the deck again and check every copy');

  if (ctx.sourceAccountKey && ctx.sourceAccountKey === target.accountKey) {
    warnings.push({
      level: 'warning',
      text: `${who} is the account you're comparing. Once its decks are synced again, the exported cards count as cards of its decks: “Not in any deck” cards would stop being so, and the cards it doesn't own would be needed once more (“Missing from collection”).`,
    });
  }

  // Writes: the folder, then per deck its creation (with the first import text) or its imports, and one per card added by id.
  let writes = folder?.create ? 1 : 0;
  let versionReads = 0;
  for (const d of deckPlans) {
    const text = chunks(d.items.filter((i) => !oneByOne(i)).length, lim?.importLines ?? 1000);
    const one = d.items.filter(oneByOne).length;
    const w = d.existing ? text + one : 1 + Math.max(0, text - 1) + one;
    writes += w;
    // A new deck's next change needs its id and version: read once, in case its creation didn't say.
    if (!d.existing && w > 1) versionReads++;
  }
  const beforeReads = 2 + deckPlans.filter((d) => d.existing).length;
  const checkReads = deckPlans.length;

  // What the run must find unchanged: the deck or folder targeted (and the decks of the folder it
  // adds to), and whether the names it creates are taken.
  const digest = hash(JSON.stringify([targetFields(target), items.map((i) => [i.key, i.qty, i.group ? [i.group.set, i.group.rarity, i.group.colors] : null]), facts]));

  return {
    target,
    binder: null,
    targetLabel,
    items,
    add,
    remove: { entries: [], copies: 0, wholeCollection: false },
    decks: deckPlans,
    ...(folder ? { folder } : {}),
    before: deckPlans.reduce((s, d) => s + d.before, 0),
    after: deckPlans.reduce((s, d) => s + d.after, 0),
    steps,
    writes,
    reads: beforeReads + versionReads + checkReads,
    requests: { before: beforeReads, write: writes, check: checkReads + versionReads },
    warnings,
    digest,
    ...(blocked ? { blocked } : {}),
  };
}
