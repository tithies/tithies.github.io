/** Deck folder hierarchy built from "/"-separated folder paths ("Collection/Final Fantasy"). */
import type { DeckRow } from './types';

export const NO_FOLDER_LABEL = '(No folder)';
/** Value of the "(No folder)" group; real folder paths never start with "/". */
const NO_FOLDER_PATH = '/none';

export interface DeckTreeNode {
  /** `folder:<path>` or `deck:<id>` (unique, stable across syncs). */
  value: string;
  label: string;
  kind: 'folder' | 'deck';
  /** Folder path (folders only). */
  path?: string;
  deck?: DeckRow;
  /** Every deck in this node and below (a deck node: itself). */
  deckIds: string[];
  children?: DeckTreeNode[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const folderParts = (folderPath: string) =>
  folderPath
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);

interface FolderAcc {
  name: string;
  path: string;
  folders: Map<string, FolderAcc>;
  decks: DeckRow[];
}

const newFolder = (name: string, path: string): FolderAcc => ({ name, path, folders: new Map(), decks: [] });

function toNodes(f: FolderAcc): DeckTreeNode[] {
  const folders = [...f.folders.values()]
    .sort((a, b) => collator.compare(a.name, b.name))
    .map((sub): DeckTreeNode => {
      const children = toNodes(sub);
      return { value: `folder:${sub.path}`, label: sub.name, kind: 'folder', path: sub.path, deckIds: children.flatMap((c) => c.deckIds), children };
    });
  const decks = [...f.decks]
    .sort((a, b) => collator.compare(a.name, b.name))
    .map((d): DeckTreeNode => ({ value: `deck:${d.id}`, label: d.name, kind: 'deck', deck: d, deckIds: [d.id] }));
  return [...folders, ...decks];
}

/**
 * Folders first (natural sort), then decks. A folder can hold decks and subfolders at once.
 * Intermediate folders are created when only deeper ones exist ("Utils/Copy" without "Utils").
 * Decks with no folder go in a "(No folder)" group at the end.
 */
export function buildDeckTree(decks: DeckRow[]): DeckTreeNode[] {
  const root = newFolder('', '');
  const loose: DeckRow[] = [];
  for (const d of decks) {
    const parts = folderParts(d.folderPath);
    if (!parts.length) {
      loose.push(d);
      continue;
    }
    let f = root;
    for (const part of parts) {
      const path = f.path ? `${f.path}/${part}` : part;
      let next = f.folders.get(part);
      if (!next) {
        next = newFolder(part, path);
        f.folders.set(part, next);
      }
      f = next;
    }
    f.decks.push(d);
  }
  const nodes = toNodes(root);
  if (loose.length) {
    const none = newFolder(NO_FOLDER_LABEL, NO_FOLDER_PATH);
    none.decks = loose;
    const children = toNodes(none);
    nodes.push({ value: `folder:${NO_FOLDER_PATH}`, label: NO_FOLDER_LABEL, kind: 'folder', path: NO_FOLDER_PATH, deckIds: children.flatMap((c) => c.deckIds), children });
  }
  return nodes;
}

export type CheckState = 'all' | 'some' | 'none';

/** Checkbox state of a folder: decks are included unless excluded. */
export function folderState(deckIds: readonly string[], excluded: ReadonlySet<string>): CheckState {
  let included = 0;
  for (const id of deckIds) if (!excluded.has(id)) included++;
  return included === 0 ? 'none' : included === deckIds.length ? 'all' : 'some';
}

/** New exclusion set after (un)checking every deck in `deckIds`. */
export function setIncluded(excluded: ReadonlySet<string>, deckIds: readonly string[], include: boolean): Set<string> {
  const next = new Set(excluded);
  for (const id of deckIds) {
    if (include) next.delete(id);
    else next.add(id);
  }
  return next;
}

const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * Keeps decks matching every word of `q` (name, commanders, format, folder) and the folders leading
 * to them. A folder whose own name matches keeps all its contents. Folder `deckIds` then only count
 * the visible decks, so checking a folder while searching only affects what you see.
 */
export function filterTree(nodes: DeckTreeNode[], q: string): DeckTreeNode[] {
  const terms = fold(q).split(/\s+/).filter(Boolean);
  if (!terms.length) return nodes;
  const matches = (text: string) => {
    const hay = fold(text);
    return terms.every((t) => hay.includes(t));
  };
  const walk = (list: DeckTreeNode[]): DeckTreeNode[] =>
    list.flatMap((n): DeckTreeNode[] => {
      if (n.kind === 'deck') {
        const d = n.deck!;
        return matches(`${d.name} ${d.commanders.join(' ')} ${d.format} ${d.folderPath}`) ? [n] : [];
      }
      if (matches(n.path ?? n.label)) return [n];
      const children = walk(n.children ?? []);
      return children.length ? [{ ...n, children, deckIds: children.flatMap((c) => c.deckIds) }] : [];
    });
  return walk(nodes);
}

/** Every folder value in the tree (to expand everything). */
export function folderValues(nodes: DeckTreeNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === 'folder' ? [n.value, ...folderValues(n.children ?? [])] : []));
}
