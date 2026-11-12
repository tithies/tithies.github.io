import { ActionIcon, Anchor, Badge, Button, Group, HoverCard, Menu, MultiSelect, Paper, Stack, Switch, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedCallback, useLocalStorage } from '@mantine/hooks';
import { IconDownload, IconExternalLink, IconSearch } from '@tabler/icons-react';
import { DataTable, type DataTableColumn, type DataTableSortStatus } from 'mantine-datatable';
import { useStickyTableHeader } from '@/lib/ui/useStickyTableHeader';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { DeckRow } from '@/lib/decks/types';
import { scryfallCardLink, scryfallImage } from '@/lib/f2f/links';
import { FINISH_LABEL, finishLabel } from '@/lib/format';
import { CardThumb } from '@/lib/ui/CardThumb';
import type { MismatchRow, OtherPrint } from '../compare';
import { downloadMismatchCsv } from '../csv';
import {
  applyMismatchFilters,
  applyMismatchSort,
  EMPTY_MISMATCH_FILTERS,
  mismatchFiltersFromParams,
  mismatchSortFromParams,
  writeMismatchParams,
  type MismatchFilters,
  type MismatchSort,
  type MismatchSortKey,
} from '../filtering';

const PAGE_SIZES = [25, 50, 100, 250, 500];
const tight = { noWrap: true, width: '1%' } as const;

const num = (children: React.ReactNode, c?: string) => (
  <Text size="sm" className="ti-num" c={c} ta="right">
    {children}
  </Text>
);

/** "Collection has DMU #435 Non-foil ×1 not in a deck" */
function hintText(o: OtherPrint): string {
  const print = `${o.set.toUpperCase()} #${o.cn} ${finishLabel(o.finish)}`;
  return o.diff > 0 ? `Collection has ${print} ×${o.diff} not in a deck` : `Decks use ${print} ×${-o.diff} not in the collection`;
}

function DeckUses({ row, decks, boardLabel }: { row: MismatchRow; decks: ReadonlyMap<string, DeckRow>; boardLabel: (board: string) => string }) {
  if (!row.decks.length) return <Text size="sm" c="dimmed">—</Text>;
  const label = (deckId: string, board: string) => `${decks.get(deckId)?.name ?? 'Unknown deck'}${board === 'mainboard' ? '' : ` · ${boardLabel(board)}`}`;
  const first = row.decks.slice(0, 2);
  return (
    <HoverCard openDelay={200} position="left" shadow="md" withinPortal disabled={row.decks.length <= 2}>
      <HoverCard.Target>
        <Stack gap={0}>
          {first.map((u) => (
            <Text key={`${u.deckId}|${u.board}`} size="xs" truncate maw={260}>
              <Anchor href={decks.get(u.deckId)?.publicUrl} target="_blank" size="xs" inherit>
                {label(u.deckId, u.board)}
              </Anchor>
              {u.qty > 1 ? ` ×${u.qty}` : ''}
            </Text>
          ))}
          {row.decks.length > 2 && (
            <Text size="xs" c="dimmed">
              +{row.decks.length - 2} more
            </Text>
          )}
        </Stack>
      </HoverCard.Target>
      <HoverCard.Dropdown p="xs">
        <Table withRowBorders={false} verticalSpacing={0} fz="xs">
          <Table.Tbody>
            {row.decks.map((u) => (
              <Table.Tr key={`${u.deckId}|${u.board}`}>
                <Table.Td>
                  <Anchor href={decks.get(u.deckId)?.publicUrl} target="_blank" size="xs">
                    {decks.get(u.deckId)?.name ?? 'Unknown deck'}
                  </Anchor>
                </Table.Td>
                <Table.Td c="dimmed">{boardLabel(u.board)}</Table.Td>
                <Table.Td ta="right" className="ti-num">
                  ×{u.qty}
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </HoverCard.Dropdown>
    </HoverCard>
  );
}

function buildColumns(decks: ReadonlyMap<string, DeckRow>, boardLabel: (board: string) => string): DataTableColumn<MismatchRow>[] {
  return [
    {
      accessor: 'kind',
      title: '',
      ...tight,
      sortable: true,
      render: (r) =>
        r.kind === 'missing' ? (
          <Tooltip label="Used in decks, but the collection doesn't have enough copies of this exact print">
            <Badge color="red" variant="light">
              Missing
            </Badge>
          </Tooltip>
        ) : (
          <Tooltip label="In the collection, but no included deck uses these copies">
            <Badge color="orange" variant="light">
              Not in a deck
            </Badge>
          </Tooltip>
        ),
    },
    {
      accessor: 'image',
      title: '',
      ...tight,
      render: (r) => <CardThumb alt={r.name} small={scryfallImage(r.scryfallId, 'small')} large={scryfallImage(r.scryfallId, 'normal')} />,
    },
    {
      accessor: 'name',
      title: 'Card',
      sortable: true,
      render: (r) => (
        <Stack gap={0}>
          <Text size="sm" fw={500}>
            {r.name}
          </Text>
          {r.otherPrints.slice(0, 2).map((o) => (
            <Text key={o.key} size="xs" c="yellow" lineClamp={1} title={hintText(o)}>
              {hintText(o)}
            </Text>
          ))}
          {r.otherPrints.length > 2 && (
            <Text size="xs" c="dimmed">
              +{r.otherPrints.length - 2} other prints
            </Text>
          )}
        </Stack>
      ),
    },
    {
      accessor: 'set',
      title: 'Set',
      ...tight,
      sortable: true,
      render: (r) => (
        <Tooltip label={r.setName}>
          <Badge variant="default" radius="sm">
            {r.set.toUpperCase()}
          </Badge>
        </Tooltip>
      ),
    },
    { accessor: 'cn', title: '#', ...tight, sortable: true, render: (r) => <Text size="sm">{r.cn}</Text> },
    {
      accessor: 'finish',
      title: 'Finish',
      ...tight,
      sortable: true,
      render: (r) => (
        <Badge variant={r.finish === 'nonFoil' ? 'default' : 'light'} color={r.finish === 'foil' ? 'grape' : r.finish === 'etched' ? 'indigo' : undefined}>
          {finishLabel(r.finish)}
        </Badge>
      ),
    },
    { accessor: 'deckQty', title: 'In decks', ...tight, sortable: true, textAlign: 'right', render: (r) => num(r.deckQty) },
    { accessor: 'collectionQty', title: 'In collection', ...tight, sortable: true, textAlign: 'right', render: (r) => num(r.collectionQty) },
    {
      accessor: 'diff',
      title: (
        <Tooltip label="Collection − decks: negative = copies missing from the collection, positive = copies in no deck" multiline w={240}>
          <span>Diff</span>
        </Tooltip>
      ),
      ...tight,
      sortable: true,
      textAlign: 'right',
      render: (r) => num(r.diff > 0 ? `+${r.diff}` : r.diff, r.diff < 0 ? 'red' : 'orange'),
    },
    { accessor: 'decks', title: 'Decks', sortable: true, render: (r) => <DeckUses row={r} decks={decks} boardLabel={boardLabel} /> },
    {
      accessor: 'links',
      title: '',
      ...tight,
      render: (r) => (
        <Tooltip label="Scryfall">
          <ActionIcon component="a" href={scryfallCardLink(r.set, r.cn)} target="_blank" variant="subtle" color="gray" aria-label="Scryfall">
            <IconExternalLink size={16} />
          </ActionIcon>
        </Tooltip>
      ),
    },
  ];
}

interface Props {
  rows: MismatchRow[];
  decks: ReadonlyMap<string, DeckRow>;
  /** The decks' site board names ("Sideboard"…). */
  boardLabel: (board: string) => string;
  loading?: boolean;
  emptyText: string;
}

export function MismatchTable({ rows, decks, boardLabel, loading, emptyText }: Props) {
  const tableRef = useStickyTableHeader();
  const [params, setParams] = useSearchParams();
  const [pageSize, setPageSize] = useLocalStorage({ key: 'tithies:decks:pageSize', defaultValue: 50 });
  const filters = useMemo(() => mismatchFiltersFromParams(params), [params]);
  const sort = useMemo(() => mismatchSortFromParams(params), [params]);
  const page = Math.max(1, Number(params.get('page')) || 1);
  const update = (f: MismatchFilters, s: MismatchSort, p: number) => setParams(writeMismatchParams(params, f, s, p), { replace: true });

  const [q, setQ] = useState(filters.q);
  useEffect(() => setQ(filters.q), [filters.q]);
  const pushQ = useDebouncedCallback((v: string) => update({ ...filters, q: v }, sort, 1), 250);

  const deckName = (id: string) => decks.get(id)?.name ?? 'Unknown deck';
  const view = useMemo(() => applyMismatchSort(applyMismatchFilters(rows, filters, deckName), sort, deckName), [rows, filters, sort, decks]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastPage = Math.max(1, Math.ceil(view.length / pageSize));
  const safePage = Math.min(page, lastPage);
  const records = view.slice((safePage - 1) * pageSize, safePage * pageSize);
  const columns = useMemo(() => buildColumns(decks, boardLabel), [decks, boardLabel]);
  const sortStatus: DataTableSortStatus<MismatchRow> = { columnAccessor: sort.key, direction: sort.dir };

  const setOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.set, r.setName);
    return [...m].sort((a, b) => a[1].localeCompare(b[1])).map(([value, name]) => ({ value, label: `${name} (${value.toUpperCase()})` }));
  }, [rows]);
  const filtered = filters.q.trim() !== '' || filters.sets.length > 0 || filters.finishes.length > 0 || filters.hinted;

  return (
    <Stack gap="xs">
      <Group gap="xs" align="flex-end" wrap="wrap">
        <TextInput
          label="Search"
          placeholder="Card, set, number or deck…"
          leftSection={<IconSearch size={14} />}
          value={q}
          onChange={(e) => {
            setQ(e.currentTarget.value);
            pushQ(e.currentTarget.value);
          }}
          style={{ flex: 1, minWidth: 220 }}
        />
        <MultiSelect
          label="Set"
          placeholder={filters.sets.length ? undefined : 'Any'}
          data={setOptions}
          value={filters.sets}
          onChange={(v) => update({ ...filters, sets: v }, sort, 1)}
          searchable
          clearable
          w={260}
        />
        <MultiSelect
          label="Finish"
          placeholder={filters.finishes.length ? undefined : 'Any'}
          data={Object.entries(FINISH_LABEL).map(([value, label]) => ({ value, label }))}
          value={filters.finishes}
          onChange={(v) => update({ ...filters, finishes: v }, sort, 1)}
          clearable
          w={200}
        />
        <Switch
          label="Likely wrong print only"
          checked={filters.hinted}
          onChange={(e) => update({ ...filters, hinted: e.currentTarget.checked }, sort, 1)}
          mb={6}
        />
        {filtered && (
          <Button variant="subtle" size="xs" mb={4} onClick={() => update(EMPTY_MISMATCH_FILTERS, sort, 1)}>
            Clear filters
          </Button>
        )}
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Button variant="default" leftSection={<IconDownload size={14} />} disabled={!rows.length} ml="auto">
              CSV
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => downloadMismatchCsv(view, deckName, boardLabel, filtered ? '-filtered' : '')}>Current view ({view.length} rows)</Menu.Item>
            <Menu.Item onClick={() => downloadMismatchCsv(applyMismatchSort(rows, sort, deckName), deckName, boardLabel)}>All mismatches ({rows.length} rows)</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <Paper ref={tableRef} withBorder radius="md">
        <DataTable<MismatchRow>
          idAccessor="key"
          records={records}
          columns={columns}
          fetching={loading}
          minHeight={records.length ? undefined : 200}
          noRecordsText={rows.length ? 'No mismatch matches these filters' : emptyText}
          striped
          highlightOnHover
          verticalSpacing={4}
          horizontalSpacing="xs"
          sortStatus={sortStatus}
          onSortStatusChange={(s) => update(filters, { key: s.columnAccessor as MismatchSortKey, dir: s.direction }, 1)}
          totalRecords={view.length}
          recordsPerPage={pageSize}
          page={safePage}
          onPageChange={(p) => update(filters, sort, p)}
          recordsPerPageOptions={PAGE_SIZES}
          onRecordsPerPageChange={(n) => {
            setPageSize(n);
            update(filters, sort, 1);
          }}
          recordsPerPageLabel="Rows per page"
          paginationText={({ from, to, totalRecords }) => `${from}–${to} of ${totalRecords}`}
        />
      </Paper>
    </Stack>
  );
}
