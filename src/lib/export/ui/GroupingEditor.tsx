import { ActionIcon, Box, Group, ScrollArea, Select, Stack, Text, Tooltip } from '@mantine/core';
import { IconChevronDown, IconChevronRight, IconCopy } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { copyToSiblings, deckName, folderDecks, GROUP_KEY_LABELS, GROUP_KEY_PLURAL, GROUP_KEYS, groupTree, setSplit, type GroupNode } from '../grouping';
import type { ExportItem, GroupKey, Grouping } from '../types';

const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const NONE = 'none';

export interface GroupingEditorProps {
  /** The cards, each with its group (set, rarity, color identity). */
  items: ExportItem[];
  grouping: Grouping;
  onChange: (g: Grouping) => void;
  /** The folder's name (a deck when nothing is split is named after it). */
  folderName: string;
  /** Most cards a deck holds. */
  maxCards: number;
  /** Cards in the folder's decks already there, by lowercased name (an existing folder: same-name decks get the cards). */
  existing: ReadonlyMap<string, number>;
}

interface RowProps extends Omit<GroupingEditorProps, 'items'> {
  node: GroupNode;
  tree: GroupNode;
  depth: number;
  /** What its parent splits by, and how many groups it has (for "split every … the same way"). */
  parentSplit: GroupKey | null;
  siblings: number;
}

function NodeRow(p: RowProps) {
  const { node, depth } = p;
  const [open, setOpen] = useState(depth === 0);
  const free = GROUP_KEYS.filter((k) => !node.used.includes(k));
  const leaf = !node.split;
  const name = leaf ? deckName(node, p.folderName) : '';
  const there = leaf ? (p.existing.get(name.trim().toLowerCase()) ?? null) : null;
  const size = node.copies + (there ?? 0);
  const tooBig = leaf && size > p.maxCards;
  const pad = depth * 18;
  return (
    <>
      <Group gap={6} wrap="nowrap" pl={pad} py={2}>
        {node.split ? (
          <ActionIcon size="sm" variant="subtle" color="gray" onClick={() => setOpen((o) => !o)} aria-label={open ? `Fold ${node.label}` : `Unfold ${node.label}`}>
            {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          </ActionIcon>
        ) : (
          <Box w={22} />
        )}
        <Text size="sm" fw={depth === 0 ? 600 : undefined} style={{ flex: 1, minWidth: 0 }} truncate>
          {node.label}
        </Text>
        <Text size="xs" c={tooBig ? 'red' : 'dimmed'} className="ti-num" style={{ whiteSpace: 'nowrap' }}>
          {plural(node.copies, 'card')}
        </Text>
        {free.length > 0 ? (
          <Select
            size="xs"
            w={190}
            data={[{ value: NONE, label: "Don't split: one deck" }, ...free.map((k) => ({ value: k, label: `Split by ${GROUP_KEY_LABELS[k].toLowerCase()}` }))]}
            value={node.split ?? NONE}
            onChange={(v) => {
              const key = !v || v === NONE ? null : (v as GroupKey);
              if (key) setOpen(true);
              p.onChange(setSplit(p.grouping, node.path, key));
            }}
            allowDeselect={false}
            aria-label={`How to split ${node.label}`}
          />
        ) : (
          <Box w={190} />
        )}
        {p.parentSplit && p.siblings > 1 ? (
          <Tooltip label={`Split every ${GROUP_KEY_PLURAL[p.parentSplit]} next to it the same way, all the way down`}>
            <ActionIcon size="sm" variant="subtle" onClick={() => p.onChange(copyToSiblings(p.grouping, p.tree, node.path))} aria-label={`Split every ${GROUP_KEY_PLURAL[p.parentSplit]} like ${node.label}`}>
              <IconCopy size={14} />
            </ActionIcon>
          </Tooltip>
        ) : (
          <Box w={28} />
        )}
      </Group>
      {leaf && (
        <Text size="xs" c={tooBig ? 'red' : 'dimmed'} pl={pad + 28} pb={2}>
          Deck “{name}”{there != null ? ` · the deck already in the folder gets them (${plural(there, 'card')} now)` : ''}
          {tooBig ? ` · ${n(size)} cards: a deck holds at most ${n(p.maxCards)}` : ''}
        </Text>
      )}
      {node.split &&
        open &&
        node.children.map((c) => <NodeRow key={c.path} {...p} node={c} depth={depth + 1} parentSplit={node.split} siblings={node.children.length} />)}
    </>
  );
}

/**
 * How a deck folder export splits the cards into decks: a tree of the real groups, each split its
 * own way (by set, rarity or color identity) or not (one deck, named after its groups).
 */
export function GroupingEditor(props: GroupingEditorProps) {
  const { items, grouping, folderName, maxCards, existing } = props;
  const tree = useMemo(() => groupTree(items, grouping), [items, grouping]);
  const decks = useMemo(() => folderDecks(items, grouping, folderName), [items, grouping, folderName]);
  const sizes = decks.map((d) => d.items.reduce((s, i) => s + i.qty, 0) + (existing.get(d.name.trim().toLowerCase()) ?? 0));
  const largest = sizes.length ? Math.max(...sizes) : 0;
  const over = sizes.filter((s) => s > maxCards).length;
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        Decks in the folder
      </Text>
      <Text size="xs" c="dimmed">
        Split the cards by set, rarity or color identity, then split each group its own way. A group that isn't split is one deck, named after its groups
        (“Final Fantasy - Rare - Red”). Sets include their own sets (FIC goes with FIN, “Final Fantasy”); two colors or more are “MultiColor”.
      </Text>
      <ScrollArea.Autosize mah={380} type="auto">
        <NodeRow {...props} node={tree} tree={tree} depth={0} parentSplit={null} siblings={1} />
      </ScrollArea.Autosize>
      <Text size="xs" c={over ? 'red' : 'dimmed'} className="ti-num">
        {plural(decks.length, 'deck')} · the largest has {plural(largest, 'card')}
        {over ? ` · ${plural(over, 'deck')} over ${n(maxCards)} cards: split ${over === 1 ? 'it' : 'them'} further` : ''}
      </Text>
    </Stack>
  );
}
