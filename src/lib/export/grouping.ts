/**
 * Splitting a deck folder export into decks (pure). The cards are split group by group: every
 * card by set (say), then each set its own way (Final Fantasy by rarity, Bloomburrow not at all),
 * then each of those groups its own way… A group that isn't split is one deck, named after the
 * groups it is in ("Final Fantasy - Rare - Red"). Groups by set use the set a set belongs to (FIC
 * and FIN are both "Final Fantasy"); every color identity of two colors or more is "MultiColor".
 */
import { rootSet, type CardFacts, type ScryfallSet } from '@/lib/cards/scryfall';
import type { ExportItem, GroupKey, Grouping, ItemGroup } from './types';

export const GROUP_KEYS: readonly GroupKey[] = ['set', 'rarity', 'color'];
export const GROUP_KEY_LABELS: Record<GroupKey, string> = { set: 'Set', rarity: 'Rarity', color: 'Color identity' };
/** How a group's children are called ("Apply to every set here"). */
export const GROUP_KEY_PLURAL: Record<GroupKey, string> = { set: 'set', rarity: 'rarity', color: 'color' };

/** Most paths in a grouping (each group split its own way). */
export const MAX_GROUPING_PATHS = 5000;

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'mythic', 'special', 'bonus', 'unknown'];
const RARITY_LABELS: Record<string, string> = {
  common: 'Common',
  uncommon: 'Uncommon',
  rare: 'Rare',
  mythic: 'Mythic',
  special: 'Special',
  bonus: 'Bonus',
  unknown: 'Unknown rarity',
};
/** Color groups: one per color, then multicolor, colorless, unknown. */
const COLOR_ORDER = ['w', 'u', 'b', 'r', 'g', 'm', 'c', 'x'];
const COLOR_LABELS: Record<string, string> = { w: 'White', u: 'Blue', b: 'Black', r: 'Red', g: 'Green', m: 'MultiColor', c: 'Colorless', x: 'Unknown color' };

/** A value in a path: letters and digits only (set codes are). */
const clean = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The group of `item` for `key`: its value (in paths) and label (in deck names). */
export function groupOf(item: ExportItem, key: GroupKey): { value: string; label: string } {
  const g = item.group;
  if (key === 'set') {
    const value = clean(g?.set ?? item.set) || 'unknown';
    return { value, label: (g?.setName ?? item.setName) || value.toUpperCase() };
  }
  if (key === 'rarity') {
    const r = clean(g?.rarity ?? '');
    const value = RARITY_LABELS[r] ? r : r ? r : 'unknown';
    return { value, label: RARITY_LABELS[value] ?? value.charAt(0).toUpperCase() + value.slice(1) };
  }
  const c = g?.colors;
  const value = c === undefined || c === '?' ? 'x' : c.length === 0 ? 'c' : c.length > 1 ? 'm' : c.toLowerCase();
  return { value, label: COLOR_LABELS[value] ?? 'Unknown color' };
}

const order = (key: GroupKey, a: { value: string; label: string }, b: { value: string; label: string }) => {
  if (key === 'set') return a.label.localeCompare(b.label) || a.value.localeCompare(b.value);
  const list = key === 'rarity' ? RARITY_ORDER : COLOR_ORDER;
  const ia = list.indexOf(a.value);
  const ib = list.indexOf(b.value);
  return (ia < 0 ? list.length : ia) - (ib < 0 ? list.length : ib) || a.value.localeCompare(b.value);
};

/** One group of cards: every card (the root), or the cards of one set, of one rarity in it… */
export interface GroupNode {
  /** '' for the root, then "set:fin", "set:fin/rarity:rare"… */
  path: string;
  /** Its labels from the root down ("Final Fantasy", "Rare"); empty for the root. */
  labels: string[];
  label: string;
  items: ExportItem[];
  copies: number;
  /** The keys its path splits by (from the root down). */
  used: GroupKey[];
  /** How it is split (null: it is one deck), and its groups. */
  split: GroupKey | null;
  children: GroupNode[];
}

const copiesOf = (items: readonly ExportItem[]) => items.reduce((s, i) => s + i.qty, 0);

/** Splits the items group by group, as `grouping` says (a key is used once per path at most). */
export function groupTree(items: readonly ExportItem[], grouping: Grouping): GroupNode {
  const build = (path: string, labels: string[], used: GroupKey[], list: ExportItem[]): GroupNode => {
    const want = grouping[path];
    const split = want && GROUP_KEYS.includes(want) && !used.includes(want) ? want : null;
    const node: GroupNode = { path, labels, label: labels[labels.length - 1] ?? 'All cards', items: list, copies: copiesOf(list), used, split, children: [] };
    if (!split) return node;
    const by = new Map<string, { value: string; label: string; items: ExportItem[] }>();
    for (const i of list) {
      const g = groupOf(i, split);
      const b = by.get(g.value);
      if (b) b.items.push(i);
      else by.set(g.value, { ...g, items: [i] });
    }
    node.children = [...by.values()]
      .sort((a, b) => order(split, a, b))
      .map((g) => build(path ? `${path}/${split}:${g.value}` : `${split}:${g.value}`, [...labels, g.label], [...used, split], g.items));
    return node;
  };
  return build('', [], [], [...items]);
}

/** The groups that aren't split: one deck each. */
export function leaves(node: GroupNode): GroupNode[] {
  return node.split ? node.children.flatMap(leaves) : [node];
}

/** The node at `path`, if the tree has it. */
export function findNode(node: GroupNode, path: string): GroupNode | null {
  if (node.path === path) return node;
  for (const c of node.children) {
    if (path === c.path || path.startsWith(`${c.path}/`)) return findNode(c, path);
  }
  return null;
}

/** The folder's last name ("Collection/Final Fantasy" → "Final Fantasy"). */
export const lastSegment = (path: string) => path.split('/').filter(Boolean).pop()?.trim() || path.trim();

/** A deck's name: its groups' labels, "Final Fantasy - Rare - Red" (the folder's own name when nothing is split). */
export const deckName = (node: GroupNode, folderName: string) => (node.labels.length ? node.labels.join(' - ') : lastSegment(folderName));

const nameKey = (name: string) => name.trim().toLowerCase();

/** The decks of a folder export: one per group not split, by name (groups of the same name are one deck). */
export function folderDecks(items: readonly ExportItem[], grouping: Grouping, folderName: string): { name: string; items: ExportItem[] }[] {
  const by = new Map<string, { name: string; items: ExportItem[] }>();
  for (const leaf of leaves(groupTree(items, grouping))) {
    if (!leaf.items.length) continue;
    const name = deckName(leaf, folderName);
    const d = by.get(nameKey(name));
    if (d) d.items.push(...leaf.items);
    else by.set(nameKey(name), { name, items: [...leaf.items] });
  }
  return [...by.values()];
}

/** Only the paths the tree uses (a choice for a group the cards don't have is dropped). */
export function pruneGrouping(items: readonly ExportItem[], grouping: Grouping): Grouping {
  const out: Grouping = {};
  const walk = (n: GroupNode) => {
    if (!n.split) return;
    out[n.path] = n.split;
    n.children.forEach(walk);
  };
  walk(groupTree(items, grouping));
  return out;
}

/** Sets how the group at `path` is split (null: not split); the choices below it are kept (they apply again if it is split the same way). */
export function setSplit(grouping: Grouping, path: string, key: GroupKey | null): Grouping {
  const next = { ...grouping };
  if (key) next[path] = key;
  else delete next[path];
  return next;
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/**
 * Splits every group next to `path` (its siblings) the way `path` is split, all the way down:
 * "Apply to every set here". Their own choices are replaced.
 */
export function copyToSiblings(grouping: Grouping, tree: GroupNode, path: string): Grouping {
  if (!path) return grouping;
  const parent = findNode(tree, parentOf(path));
  if (!parent) return grouping;
  const own = Object.entries(grouping).filter(([p]) => p === path || p.startsWith(`${path}/`));
  const next: Grouping = { ...grouping };
  for (const sib of parent.children) {
    if (sib.path === path) continue;
    for (const p of Object.keys(next)) if (p === sib.path || p.startsWith(`${sib.path}/`)) delete next[p];
    for (const [p, k] of own) next[sib.path + p.slice(path.length)] = k;
  }
  return next;
}

const SEGMENT = /^(set|rarity|color):[a-z0-9]{1,20}$/;

/** A grouping from an extension page, if it is one (null when not valid). */
export function cleanGrouping(raw: unknown): Grouping | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_GROUPING_PATHS) return null;
  const out: Grouping = {};
  for (const [path, key] of entries) {
    if (typeof key !== 'string' || !GROUP_KEYS.includes(key as GroupKey)) return null;
    const segments = path ? path.split('/') : [];
    if (segments.length > GROUP_KEYS.length - 1 || !segments.every((s) => SEGMENT.test(s))) return null;
    const used = segments.map((s) => s.slice(0, s.indexOf(':')));
    if (new Set(used).size !== used.length || used.includes(key)) return null;
    out[path] = key as GroupKey;
  }
  return out;
}

/** A grouping's entries in a fixed order (the digest doesn't depend on how it was built). */
export const groupingFields = (g: Grouping) => Object.entries(g).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Each item's group (set it belongs to, rarity, color identity), from Scryfall's facts; an item Scryfall doesn't know keeps its own set. */
export function withGroups(items: readonly ExportItem[], facts: ReadonlyMap<string, CardFacts>, sets: ReadonlyMap<string, ScryfallSet>): ExportItem[] {
  return items.map((i) => {
    const f = facts.get(i.scryfallId);
    const root = rootSet(sets, f?.set || i.set);
    const group: ItemGroup = {
      set: clean(root?.code ?? (f?.set || i.set)) || 'unknown',
      setName: root?.name ?? i.setName,
      rarity: f ? clean(f.rarity) : '',
      colors: f ? f.colors : '?',
    };
    return { ...i, group };
  });
}

const GROUP_SET = /^[a-z0-9]{1,20}$/;
const GROUP_RARITY = /^[a-z0-9]{0,20}$/;
const GROUP_COLORS = /^([WUBRG]{0,5}|\?)$/;

/** An item's group from an extension page, if it is one. */
export const validGroup = (g: unknown): g is ItemGroup => {
  const x = g as ItemGroup | null;
  return (
    !!x &&
    typeof x === 'object' &&
    typeof x.set === 'string' &&
    GROUP_SET.test(x.set) &&
    typeof x.setName === 'string' &&
    x.setName.length <= 200 &&
    typeof x.rarity === 'string' &&
    GROUP_RARITY.test(x.rarity) &&
    typeof x.colors === 'string' &&
    GROUP_COLORS.test(x.colors)
  );
};
