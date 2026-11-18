import { ActionIcon, Badge, Button, Checkbox, Group, ScrollArea, Stack, Text, TextInput, ThemeIcon, Tooltip, Tree, getTreeExpandedState, useTree, type TreeNodeData } from '@mantine/core';
import { IconAlertTriangle, IconChevronRight, IconExternalLink, IconFolder, IconLock, IconSearch, IconX } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { buildDeckTree, filterTree, folderCardCount, folderState, setIncluded, type DeckTreeNode } from './tree';
import type { DeckRow } from './types';

export interface DeckTreePickerProps {
  decks: DeckRow[];
  /** Decks left out. Anything not listed (including new decks) is included. */
  excluded: ReadonlySet<string>;
  onChange(next: Set<string>): void;
  /** The decks' site, for "Open on …" links. */
  siteLabel: string;
  /** A folder's page on the site (its "/"-separated path), when known. */
  folderUrl?: (path: string) => string | undefined;
  maxHeight?: number;
}

const toData = (nodes: DeckTreeNode[]): TreeNodeData[] =>
  nodes.map((n) => ({ value: n.value, label: n.label, children: n.children ? toData(n.children) : undefined }));

function indexNodes(nodes: DeckTreeNode[], map = new Map<string, DeckTreeNode>()) {
  for (const n of nodes) {
    map.set(n.value, n);
    if (n.children) indexNodes(n.children, map);
  }
  return map;
}

const FORMAT_LABEL: Record<string, string> = { commander: 'Commander', pauperEdh: 'Pauper EDH', none: '' };

/** The row's right end: its card count, then its "Open on …" link (an empty slot without one, so counts line up). */
function RowEnd({ count, title, href, siteLabel }: { count: number | undefined; title?: string; href: string | undefined; siteLabel: string }) {
  return (
    <>
      <Text size="xs" c="dimmed" className="ti-num" title={title} style={{ marginLeft: 'auto', flexShrink: 0 }}>
        {count ?? ''}
      </Text>
      {href ? (
        <Tooltip label={`Open on ${siteLabel}`}>
          <ActionIcon
            component="a"
            href={href}
            target="_blank"
            size="xs"
            variant="subtle"
            color="gray"
            aria-label={`Open on ${siteLabel}`}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
          >
            <IconExternalLink size={12} />
          </ActionIcon>
        </Tooltip>
      ) : (
        <span style={{ width: 18, flexShrink: 0 }} />
      )}
    </>
  );
}

function DeckLabel({ deck, siteLabel }: { deck: DeckRow; siteLabel: string }) {
  const format = FORMAT_LABEL[deck.format] ?? deck.format;
  return (
    <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
      <Text size="sm" truncate title={deck.name} c={deck.cardsUpdatedAt ? undefined : 'dimmed'}>
        {deck.name}
      </Text>
      {deck.visibility === 'private' && (
        <Tooltip label="Private deck">
          <IconLock size={13} style={{ flexShrink: 0, opacity: 0.6 }} />
        </Tooltip>
      )}
      {format && (
        <Badge size="xs" variant="light" color="gray">
          {format}
        </Badge>
      )}
      {deck.isNew && (
        <Badge size="xs" color="green">
          New
        </Badge>
      )}
      {deck.error && (
        <Tooltip label={`Last read failed: ${deck.error}`} multiline w={260}>
          <ThemeIcon size="xs" color="red" variant="light">
            <IconAlertTriangle size={11} />
          </ThemeIcon>
        </Tooltip>
      )}
      {!deck.cardsUpdatedAt && !deck.error && (
        <Text size="xs" c="dimmed">
          not read yet
        </Text>
      )}
      <RowEnd count={deck.cardCount} title="Cards in the deck (every board)" href={deck.publicUrl} siteLabel={siteLabel} />
    </Group>
  );
}

/** Deck / folder hierarchy with tri-state checkboxes. Reusable by any feature that works on a subset of decks. */
export function DeckTreePicker({ decks, excluded, onChange, siteLabel, folderUrl, maxHeight = 420 }: DeckTreePickerProps) {
  const [q, setQ] = useState('');
  // Rebuild only when something shown in the tree changes (not on every per-deck write of a sync).
  const signature = decks
    .map((d) => `${d.id}|${d.name}|${d.folderPath}|${d.format}|${d.visibility}|${d.isNew ? 1 : 0}|${d.error ?? ''}|${d.cardCount ?? ''}|${d.cardsUpdatedAt ? 1 : 0}`)
    .join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const full = useMemo(() => buildDeckTree(decks), [signature]);
  const nodes = useMemo(() => filterTree(full, q), [full, q]);
  const index = useMemo(() => indexNodes(nodes), [nodes]);
  const data = useMemo(() => toData(nodes), [nodes]);
  const tree = useTree();
  const searching = q.trim() !== '';

  // Searching opens every folder that has a match; clearing the search folds everything back.
  useEffect(() => {
    tree.setExpandedState(getTreeExpandedState(data, searching ? '*' : []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const byId = useMemo(() => new Map(decks.map((d) => [d.id, d])), [decks]);
  const visibleIds = useMemo(() => nodes.flatMap((n) => n.deckIds), [nodes]);
  const included = decks.reduce((s, d) => s + (excluded.has(d.id) ? 0 : 1), 0);

  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="wrap">
        <TextInput
          size="xs"
          placeholder="Search decks, commanders, folders…"
          leftSection={<IconSearch size={14} />}
          rightSection={
            q ? (
              <ActionIcon size="xs" variant="subtle" color="gray" onClick={() => setQ('')} aria-label="Clear search">
                <IconX size={12} />
              </ActionIcon>
            ) : null
          }
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          style={{ flex: 1, minWidth: 180 }}
        />
        <Button.Group>
          <Button size="xs" variant="default" onClick={() => onChange(setIncluded(excluded, visibleIds, true))}>
            {searching ? 'Check shown' : 'All'}
          </Button>
          <Button size="xs" variant="default" onClick={() => onChange(setIncluded(excluded, visibleIds, false))}>
            {searching ? 'Uncheck shown' : 'None'}
          </Button>
        </Button.Group>
        <Button.Group>
          <Button size="xs" variant="default" onClick={() => tree.expandAllNodes()}>
            Expand
          </Button>
          <Button size="xs" variant="default" onClick={() => tree.collapseAllNodes()}>
            Collapse
          </Button>
        </Button.Group>
      </Group>
      <Text size="xs" c="dimmed">
        {included} of {decks.length} decks included · new decks are included automatically
      </Text>
      {/* Rows never widen the list (long names are cut): it only scrolls down, so counts and links stay in view. */}
      <ScrollArea.Autosize mah={maxHeight} type="auto" scrollbars="y" offsetScrollbars="y" styles={{ content: { minWidth: 0 } }}>
        {nodes.length === 0 ? (
          <Text size="sm" c="dimmed" p="xs">
            No deck matches “{q}”.
          </Text>
        ) : (
          <Tree
            data={data}
            tree={tree}
            levelOffset={22}
            expandOnClick={false}
            renderNode={({ node, expanded, hasChildren, elementProps }) => {
              const n = index.get(node.value);
              if (!n) return null;
              const state = folderState(n.deckIds, excluded);
              const toggle = () => onChange(setIncluded(excluded, n.deckIds, state !== 'all'));
              const isFolder = n.kind === 'folder';
              const inFolder = isFolder ? n.deckIds.length - n.deckIds.filter((id) => excluded.has(id)).length : 0;
              return (
                <Group
                  gap={6}
                  wrap="nowrap"
                  {...elementProps}
                  onClick={(e) => {
                    if (isFolder) tree.toggleExpanded(node.value);
                    else toggle();
                    e.stopPropagation();
                  }}
                  style={{ ...elementProps.style, paddingBlock: 3, cursor: 'pointer', userSelect: 'none' }}
                >
                  {hasChildren ? (
                    <IconChevronRight size={14} style={{ flexShrink: 0, transform: expanded ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }} />
                  ) : (
                    <span style={{ width: 14, flexShrink: 0 }} />
                  )}
                  <Checkbox
                    size="xs"
                    checked={state === 'all'}
                    indeterminate={state === 'some'}
                    onChange={toggle}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`${state === 'all' ? 'Exclude' : 'Include'} ${n.label}`}
                  />
                  {isFolder ? (
                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
                      <IconFolder size={15} style={{ flexShrink: 0, opacity: 0.7 }} />
                      <Text size="sm" fw={500} truncate title={n.path}>
                        {n.label}
                      </Text>
                      <Text size="xs" c="dimmed" className="ti-num" title="Decks included / decks in the folder" style={{ flexShrink: 0 }}>
                        {inFolder}/{n.deckIds.length}
                      </Text>
                      <RowEnd
                        count={folderCardCount(n.deckIds, byId)}
                        title={searching ? 'Cards in the decks shown (every board)' : 'Cards in its decks (every board)'}
                        href={n.path ? folderUrl?.(n.path) : undefined}
                        siteLabel={siteLabel}
                      />
                    </Group>
                  ) : (
                    <DeckLabel deck={n.deck!} siteLabel={siteLabel} />
                  )}
                </Group>
              );
            }}
          />
        )}
      </ScrollArea.Autosize>
    </Stack>
  );
}
