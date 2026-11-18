import { ActionIcon, Anchor, Badge, Button, Group, HoverCard, Menu, MultiSelect, NumberInput, Paper, Stack, Switch, Table, Text, TextInput, Tooltip } from '@mantine/core';
import { useDebouncedCallback, useLocalStorage } from '@mantine/hooks';
import { IconDownload, IconExternalLink, IconFileExport, IconListDetails, IconPlus, IconSearch, IconTrash, IconX } from '@tabler/icons-react';
import { MAX_EXPORT_QTY, type ExportList } from '@/lib/export/list';
import { exportQty, rowItemKeys, rowToItems } from '../export';
import type { ExportItem } from '@/lib/export/types';
import { langLabel, langOf, sortLangs } from '@/lib/cards/languages';
import { LangBadge } from '@/lib/ui/LangBadge';
import { DataTable, type DataTableColumn, type DataTableSortStatus } from 'mantine-datatable';
import { useStickyTableHeader } from '@/lib/ui/useStickyTableHeader';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { DeckRow } from '@/lib/decks/types';
import { scryfallCardLink, scryfallImage } from '@/lib/f2f/links';
import { finishLabel, FINISH_LABEL } from '@/lib/format';
import { CardThumb } from '@/lib/ui/CardThumb';
import { renderPagination } from '@/lib/ui/pagination';
import { ONE_LINE_PILLS, SetMultiSelect } from '@/lib/ui/SetMultiSelect';
import type { ComparisonRow, DeckUse, OtherPrint } from '../compare';
import { downloadComparisonCsv } from '../csv';
import {
  applyComparisonFilters,
  applyComparisonSort,
  EMPTY_COMPARISON_FILTERS,
  comparisonFiltersFromParams,
  comparisonSortFromParams,
  writeComparisonParams,
  type ComparisonFilters,
  type ComparisonSort,
  type ComparisonSortKey,
} from '../filtering';

const PAGE_SIZES = [25, 50, 100, 250, 500];
/** The typing area of a multi-select starts small and grows, so a picked value and it share one line. */
const tight = { noWrap: true, width: '1%' } as const;

const num = (children: React.ReactNode, c?: string) => (
  <Text size="sm" className="ti-num" c={c} ta="right">
    {children}
  </Text>
);

/** "Collection has DMU #435 Non-foil ×1 not in a deck" ("… Non-foil French …" when only the language differs from the row's). */
function hintText(o: OtherPrint, row: ComparisonRow): string {
  const print = `${o.set.toUpperCase()} #${o.cn} ${finishLabel(o.finish)}${langOf(o) !== langOf(row) ? ` ${langLabel(o.lang)}` : ''}`;
  return o.diff > 0 ? `Collection has ${print} ×${o.diff} not in a deck` : `Decks use ${print} ×${-o.diff} not in the collection`;
}

function DeckUses({ row, decks, boardLabel }: { row: ComparisonRow; decks: ReadonlyMap<string, DeckRow>; boardLabel: (board: string) => string }) {
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

/** "in Deck A, Deck B · Sideboard +2 more": the decks of a likely-wrong-print hint, linked. */
function HintDecks({ uses, decks, boardLabel }: { uses: DeckUse[]; decks: ReadonlyMap<string, DeckRow>; boardLabel: (board: string) => string }) {
  const shown = uses.slice(0, 2);
  return (
    <Text size="xs" c="dimmed" lineClamp={1}>
      in{' '}
      {shown.map((u, i) => (
        <Fragment key={`${u.deckId}|${u.board}`}>
          {i > 0 && ', '}
          <Anchor href={decks.get(u.deckId)?.publicUrl} target="_blank" size="xs" inherit>
            {decks.get(u.deckId)?.name ?? 'Unknown deck'}
            {u.board === 'mainboard' ? '' : ` · ${boardLabel(u.board)}`}
          </Anchor>
          {u.qty > 1 ? ` ×${u.qty}` : ''}
        </Fragment>
      ))}
      {uses.length > 2 && ` +${uses.length - 2} more`}
    </Text>
  );
}

/** Collection copies whose Language field isn't the print's language: the warning on the row. */
function rowLangWarning(r: ComparisonRow): string | null {
  if (!r.mismatchCopies) return null;
  const others = sortLangs(Object.keys(r.langs).filter((l) => l !== r.lang && r.langs[l] > 0)).map(langLabel);
  const part = r.mismatchCopies < r.collectionQty ? ` (${r.mismatchCopies} of ${r.collectionQty} copies)` : '';
  return `Moxfield's Language says ${others.join(' / ')}${part}, but this print is ${langLabel(r.lang)}. Decks are compared by print; an export keeps the Language field.`;
}

/** Add the row to the export, or (once in it) its quantity and remove. A row in several languages is edited in the export review. */
function ExportCell({ row, exportList }: { row: ComparisonRow; exportList: ExportList }) {
  const items = rowToItems(row);
  const inList = items.map((i) => exportList.get(i.key)).filter((i): i is ExportItem => Boolean(i));
  if (!inList.length) {
    return (
      <Tooltip label={`Add to the export (×${exportQty(row)})`}>
        <ActionIcon variant="subtle" onClick={() => exportList.add(items)} aria-label={`Add ${row.name} to the export`}>
          <IconFileExport size={16} />
        </ActionIcon>
      </Tooltip>
    );
  }
  if (items.length > 1) {
    const total = inList.reduce((s, i) => s + i.qty, 0);
    return (
      <Group gap={2} wrap="nowrap">
        <Tooltip label={`${inList.map((i) => `${i.qty} ${langLabel(i.lang)}`).join(', ')}: change the copies in the export review`} multiline w={240}>
          <Text size="sm" className="ti-num" px={4}>
            ×{total} · {inList.length} languages
          </Text>
        </Tooltip>
        <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => exportList.remove(items.map((i) => i.key))} aria-label={`Remove ${row.name} from the export`}>
          <IconX size={14} />
        </ActionIcon>
      </Group>
    );
  }
  const item = inList[0];
  return (
    <Group gap={2} wrap="nowrap">
      <NumberInput
        size="xs"
        w={64}
        min={1}
        max={MAX_EXPORT_QTY}
        allowDecimal={false}
        value={item.qty}
        onChange={(v) => typeof v === 'number' && exportList.setQty(item.key, v)}
        aria-label={`Copies of ${row.name} to export`}
      />
      <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => exportList.remove([item.key])} aria-label={`Remove ${row.name} from the export`}>
        <IconX size={14} />
      </ActionIcon>
    </Group>
  );
}

function buildColumns(decks: ReadonlyMap<string, DeckRow>, boardLabel: (board: string) => string, exportList?: ExportList): DataTableColumn<ComparisonRow>[] {
  return [
    ...(exportList
      ? [
          {
            accessor: 'export',
            title: (
              <Tooltip label="Export: the cards to send to a binder or a collection">
                <IconFileExport size={16} />
              </Tooltip>
            ),
            ...tight,
            render: (r: ComparisonRow) => <ExportCell row={r} exportList={exportList} />,
          } satisfies DataTableColumn<ComparisonRow>,
        ]
      : []),
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
        ) : r.kind === 'unassigned' ? (
          <Tooltip label="In the collection, but no included deck uses these copies">
            <Badge color="orange" variant="light">
              Not in a deck
            </Badge>
          </Tooltip>
        ) : (
          <Tooltip label="As many copies of this exact print in the included decks as in the collection">
            <Badge color="teal" variant="light">
              Match
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
          <Group gap={6} wrap="nowrap" align="center">
            <Text size="sm" fw={500}>
              {r.name}
            </Text>
            <LangBadge lang={r.lang} warning={rowLangWarning(r)} />
          </Group>
          {r.otherPrints.slice(0, 2).map((o) => (
            <Stack key={o.key} gap={0}>
              <Text size="xs" c="yellow" lineClamp={1} title={hintText(o, r)}>
                {hintText(o, r)}
              </Text>
              {/* Decks use the other print: those decks are where to fix it. */}
              {o.diff < 0 && o.decks.length > 0 && <HintDecks uses={o.decks} decks={decks} boardLabel={boardLabel} />}
            </Stack>
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
        <Tooltip
          label="The copies of this row: missing from the collection (−), in no deck (+), or on both sides (a match). A print that partly matches has two rows."
          multiline
          w={260}
        >
          <span>Copies</span>
        </Tooltip>
      ),
      ...tight,
      sortable: true,
      textAlign: 'right',
      render: (r) => num(r.kind === 'missing' ? `−${r.copies}` : r.kind === 'unassigned' ? `+${r.copies}` : r.copies, r.kind === 'missing' ? 'red' : r.kind === 'unassigned' ? 'orange' : 'teal'),
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
  rows: ComparisonRow[];
  /** Every row of the comparison, shown or not (for the export shortcuts). */
  allRows?: ComparisonRow[];
  /** What the page will export (adds an export column and shortcuts). */
  exportList?: ExportList;
  decks: ReadonlyMap<string, DeckRow>;
  /** The decks' site board names ("Sideboard"…). */
  boardLabel: (board: string) => string;
  loading?: boolean;
  emptyText: string;
  /** How many exports this page made lately, and how to see them again (in the export menu). */
  recentExports?: number;
  onSeeExports?: () => void;
}

export function ComparisonTable({ rows, allRows = rows, exportList, decks, boardLabel, loading, emptyText, recentExports = 0, onSeeExports }: Props) {
  const tableRef = useStickyTableHeader();
  const [params, setParams] = useSearchParams();
  const [pageSize, setPageSize] = useLocalStorage({ key: 'tithies:decks:pageSize', defaultValue: 50 });
  const filters = useMemo(() => comparisonFiltersFromParams(params), [params]);
  const sort = useMemo(() => comparisonSortFromParams(params), [params]);
  const page = Math.max(1, Number(params.get('page')) || 1);
  const update = (f: ComparisonFilters, s: ComparisonSort, p: number) => setParams(writeComparisonParams(params, f, s, p), { replace: true });

  const [q, setQ] = useState(filters.q);
  useEffect(() => setQ(filters.q), [filters.q]);
  const pushQ = useDebouncedCallback((v: string) => update({ ...filters, q: v }, sort, 1), 250);

  const deckName = (id: string) => decks.get(id)?.name ?? 'Unknown deck';
  const view = useMemo(() => applyComparisonSort(applyComparisonFilters(rows, filters, deckName), sort, deckName), [rows, filters, sort, decks]); // eslint-disable-line react-hooks/exhaustive-deps
  const lastPage = Math.max(1, Math.ceil(view.length / pageSize));
  const safePage = Math.min(page, lastPage);
  const records = view.slice((safePage - 1) * pageSize, safePage * pageSize);
  const columns = useMemo(() => buildColumns(decks, boardLabel, exportList), [decks, boardLabel, exportList]);
  const missingRows = useMemo(() => allRows.filter((r) => r.kind === 'missing'), [allRows]);
  const matchedRows = useMemo(() => allRows.filter((r) => r.kind === 'match'), [allRows]);
  const unassignedRows = useMemo(() => allRows.filter((r) => r.kind === 'unassigned'), [allRows]);
  const shownInExport = exportList ? view.filter((r) => rowItemKeys(r).some((k) => exportList.has(k))).length : 0;
  const sortStatus: DataTableSortStatus<ComparisonRow> = { columnAccessor: sort.key, direction: sort.dir };

  // Picked sets show as their code ("M20") so the field stays one line; the list shows (and searches) names too.
  const setNames = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.set, r.setName);
    return m;
  }, [rows]);
  const languages = useMemo(() => sortLangs(rows.map((r) => r.lang)).map((l) => ({ value: l, label: langLabel(l) })), [rows]);
  const filtered = filters.q.trim() !== '' || filters.sets.length > 0 || filters.finishes.length > 0 || filters.languages.length > 0 || filters.hinted;

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
        <SetMultiSelect
          label="Set"
          placeholder={filters.sets.length ? undefined : 'Any'}
          names={setNames}
          value={filters.sets}
          onChange={(v) => update({ ...filters, sets: v }, sort, 1)}
          w={260}
        />
        <MultiSelect
          label="Finish"
          placeholder={filters.finishes.length ? undefined : 'Any'}
          data={Object.entries(FINISH_LABEL).map(([value, label]) => ({ value, label }))}
          value={filters.finishes}
          onChange={(v) => update({ ...filters, finishes: v }, sort, 1)}
          clearable
          styles={ONE_LINE_PILLS}
          w={200}
        />
        {(languages.length > 1 || filters.languages.length > 0) && (
          <MultiSelect
            label="Language"
            placeholder={filters.languages.length ? undefined : 'Any'}
            data={languages}
            value={filters.languages}
            onChange={(v) => update({ ...filters, languages: v }, sort, 1)}
            clearable
            styles={ONE_LINE_PILLS}
            w={200}
          />
        )}
        <Switch
          label="Likely wrong print only"
          checked={filters.hinted}
          onChange={(e) => update({ ...filters, hinted: e.currentTarget.checked }, sort, 1)}
          mb={6}
        />
        {filtered && (
          <Button variant="subtle" size="xs" mb={4} onClick={() => update(EMPTY_COMPARISON_FILTERS, sort, 1)}>
            Clear filters
          </Button>
        )}
        {exportList && (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button variant="light" leftSection={<IconFileExport size={14} />} ml="auto" disabled={!allRows.length && !exportList.prints}>
                Export{exportList.prints ? ` (${exportList.prints})` : ''}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>Add to the export (copies = the difference; for a match, its copies)</Menu.Label>
              <Menu.Item leftSection={<IconPlus size={14} />} disabled={!view.length} onClick={() => exportList.add(view.flatMap(rowToItems))}>
                Rows shown, every page ({view.length})
              </Menu.Item>
              <Menu.Item leftSection={<IconPlus size={14} />} disabled={!missingRows.length} onClick={() => exportList.add(missingRows.flatMap(rowToItems))}>
                Every “Missing from collection” row ({missingRows.length})
              </Menu.Item>
              <Menu.Item leftSection={<IconPlus size={14} />} disabled={!unassignedRows.length} onClick={() => exportList.add(unassignedRows.flatMap(rowToItems))}>
                Every “Not in any deck” row ({unassignedRows.length})
              </Menu.Item>
              <Menu.Item leftSection={<IconPlus size={14} />} disabled={!matchedRows.length} onClick={() => exportList.add(matchedRows.flatMap(rowToItems))}>
                Every “Matching” row ({matchedRows.length})
              </Menu.Item>
              <Menu.Divider />
              <Menu.Item leftSection={<IconX size={14} />} disabled={!shownInExport} onClick={() => exportList.remove(view.flatMap(rowItemKeys))}>
                Remove the rows shown from the export ({shownInExport})
              </Menu.Item>
              <Menu.Item color="red" leftSection={<IconTrash size={14} />} disabled={!exportList.prints} onClick={() => exportList.clear()}>
                Clear the list to export ({exportList.prints})
              </Menu.Item>
              {onSeeExports && (
                <>
                  <Menu.Divider />
                  <Menu.Item leftSection={<IconListDetails size={14} />} disabled={!recentExports} onClick={onSeeExports}>
                    Recent exports ({recentExports})
                  </Menu.Item>
                </>
              )}
            </Menu.Dropdown>
          </Menu>
        )}
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Button variant="default" leftSection={<IconDownload size={14} />} disabled={!rows.length} ml={exportList ? undefined : 'auto'}>
              CSV
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => downloadComparisonCsv(view, deckName, boardLabel, filtered ? '-filtered' : '')}>Current view ({view.length} rows)</Menu.Item>
            <Menu.Item onClick={() => downloadComparisonCsv(applyComparisonSort(rows, sort, deckName), deckName, boardLabel)}>All rows ({rows.length})</Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <Paper ref={tableRef} withBorder radius="md">
        <DataTable<ComparisonRow>
          idAccessor="key"
          records={records}
          columns={columns}
          fetching={loading}
          minHeight={records.length ? undefined : 200}
          noRecordsText={rows.length ? 'No row matches these filters' : emptyText}
          striped
          highlightOnHover
          rowBackgroundColor={exportList ? (r) => (exportList.has(r.key) ? { dark: 'rgba(34, 139, 230, 0.12)', light: 'rgba(34, 139, 230, 0.08)' } : undefined) : undefined}
          verticalSpacing={4}
          horizontalSpacing="xs"
          sortStatus={sortStatus}
          onSortStatusChange={(s) => update(filters, { key: s.columnAccessor as ComparisonSortKey, dir: s.direction }, 1)}
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
          renderPagination={renderPagination}
        />
      </Paper>
    </Stack>
  );
}
