import { Alert, Anchor, Badge, Button, Group, Paper, Progress, SimpleGrid, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconAlertTriangle, IconArrowLeft, IconBox, IconBuildingStore, IconCash } from '@tabler/icons-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DataTable, type DataTableSortStatus } from 'mantine-datatable';
import { useCallback, useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { db } from '@/lib/db';
import { f2fLinks } from '@/lib/f2f/links';
import { categoryOf, type Item } from '../types';
import { summarize } from '../summary';
import { Stat } from '@/lib/ui/Stat';
import { RunActions } from './RunActions';
import { ColumnsMenu, useHiddenColumns } from './ColumnsMenu';
import { buildColumns } from './columns';
import { applyFilters, applySort, filtersFromParams, sortFromParams, writeParams, type Filters, type Sort, type SortKey } from './filtering';
import { FiltersBar } from './FiltersBar';
import { dateTime, money, pct, PHASE_LABEL, STATUS_COLOR, STATUS_LABEL } from './format';

const PAGE_SIZES = [25, 50, 100, 250, 500];

/** Small "label | Cash | Credit" table used inside stat cards. */
function CashCreditTable({ rows }: { rows: { label: React.ReactNode; cash: string; credit: string; strong?: boolean }[] }) {
  return (
    <Table withRowBorders={false} withTableBorder={false} verticalSpacing={0} horizontalSpacing={6} fz="sm" className="ti-num" w="auto">
      <Table.Thead>
        <Table.Tr>
          <Table.Th />
          <Table.Th ta="right" c="teal">
            Cash
          </Table.Th>
          <Table.Th ta="right" c="teal">
            Credit
          </Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((r, i) => (
          <Table.Tr key={i}>
            <Table.Td c="dimmed" style={{ whiteSpace: 'nowrap' }}>
              {r.label}
            </Table.Td>
            <Table.Td ta="right" fw={700} fz={r.strong ? 'md' : undefined}>
              {r.cash}
            </Table.Td>
            <Table.Td ta="right" fw={700} fz={r.strong ? 'md' : undefined}>
              {r.credit}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export function RunDetailPage() {
  const runId = Number(useParams().runId);
  const [params, setParams] = useSearchParams();
  const [pageSize, setPageSize] = useLocalStorage({ key: 'tithies:f2f:pageSize', defaultValue: 100 });

  // null = not found (undefined means "still loading" for useLiveQuery).
  const run = useLiveQuery(async () => (await db.runs.get(runId)) ?? null, [runId]);
  const { hidden, save: saveHidden } = useHiddenColumns();
  const items = useLiveQuery(() => db.items.where('runId').equals(runId).toArray(), [runId]);

  const filters = useMemo(() => filtersFromParams(params), [params]);
  const sort = useMemo(() => sortFromParams(params), [params]);
  const page = Math.max(1, Number(params.get('page')) || 1);

  const update = useCallback(
    (f: Filters, s: Sort, p: number) => setParams(writeParams(params, f, s, p), { replace: true }),
    [params, setParams],
  );

  const all = items ?? [];
  const counts = useMemo(
    () => ({
      all: all.length,
      buylist: all.filter((i) => categoryOf(i) === 'buylist').length,
      bulk: all.filter((i) => categoryOf(i) === 'bulk').length,
      notBought: all.filter((i) => categoryOf(i) === 'not_bought').length,
    }),
    [all],
  );
  const view = useMemo(() => applySort(applyFilters(all, filters), sort), [all, filters, sort]);
  const lastPage = Math.max(1, Math.ceil(view.length / pageSize));
  const safePage = Math.min(page, lastPage);
  const records = view.slice((safePage - 1) * pageSize, safePage * pageSize);
  const viewTotals = useMemo(
    () => view.reduce((t, i) => ({ cash: t.cash + (i.buyCash ?? 0) * i.qty, credit: t.credit + (i.buyCredit ?? 0) * i.qty, copies: t.copies + i.qty }), { cash: 0, credit: 0, copies: 0 }),
    [view],
  );
  const columns = useMemo(() => buildColumns(hidden), [hidden]);
  // Live from items so runs created before a new total existed still show it.
  const t = useMemo(() => summarize(all, run?.totals.entries ?? 0), [all, run?.totals.entries]);

  if (run === undefined) return <Text c="dimmed">Loading…</Text>;
  if (run === null) {
    return (
      <Alert color="red" title="Run not found">
        <Anchor component={Link} to="/f2f/runs">
          Back to runs
        </Anchor>
      </Alert>
    );
  }

  const progress = t.prints ? (t.done / t.prints) * 100 : 0;
  const reviewCount = t.notFound + t.loose + t.priceCheck + t.errors;
  const sortStatus: DataTableSortStatus<Item> = { columnAccessor: sort.key, direction: sort.dir };

  return (
    <Stack>
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <Group gap="xs">
            <Button component={Link} to="/f2f/runs" variant="subtle" size="xs" leftSection={<IconArrowLeft size={14} />} px={4}>
              Runs
            </Button>
            <Title order={2}>Run #{run.id}</Title>
            <Badge color={STATUS_COLOR[run.status]} variant="light">
              {STATUS_LABEL[run.status]}
            </Badge>
          </Group>
          <Text size="sm" c="dimmed">
            {dateTime(run.createdAt)} · Moxfield filters: <b>{run.source.summary}</b> · {t.entries} rows → {t.prints} prints · {run.requests} F2F requests
          </Text>
        </Stack>
        <Group gap="xs">
          <Button component="a" href={f2fLinks.sellHome} target="_blank" size="xs" variant="light" color="teal" leftSection={<IconCash size={14} />}>
            F2F sell page
          </Button>
          <Button component="a" href={f2fLinks.sellBulk} target="_blank" size="xs" variant="light" color="orange" leftSection={<IconBox size={14} />}>
            F2F bulk prices
          </Button>
          <Button component="a" href={f2fLinks.shopHome} target="_blank" size="xs" variant="default" leftSection={<IconBuildingStore size={14} />}>
            F2F shop
          </Button>
        </Group>
      </Group>

      {run.status !== 'completed' && (
        <Paper withBorder p="sm" radius="md">
          <Group justify="space-between" mb={6}>
            <Text size="sm">
              {PHASE_LABEL[run.phase]} — {t.done}/{t.prints} prints checked
              {t.errors ? ` · ${t.errors} errors` : ''}
            </Text>
            <Text size="sm" className="ti-num">
              {progress.toFixed(1)} %
            </Text>
          </Group>
          <Progress value={progress} animated={run.status === 'running'} color={STATUS_COLOR[run.status]} />
        </Paper>
      )}
      {run.error && (
        <Alert color="yellow" icon={<IconAlertTriangle />}>
          {run.error}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 2, md: 3, lg: 6 }} spacing="sm">
        <Stat
          label="F2F buys"
          value={`${t.buylistPrints}`}
          lines={[`${t.buylistCopies} copies`]}
          color="teal"
          icon={<IconCash color="var(--mantine-color-teal-5)" />}
          active={filters.category === 'buylist'}
          hint={filters.category === 'buylist' ? 'Click to show all cards again' : 'Click to show only cards F2F buys'}
          onClick={() => update({ ...filters, category: filters.category === 'buylist' ? 'all' : 'buylist' }, sort, 1)}
        />
        <Stat
          label="Buylist value"
          lines={[
            <Tooltip
              key="retail"
              multiline
              w={280}
              label={`Total of F2F's own NM prices for these cards. "% of F2F" = your total ÷ that total${t.buylistNoRetail ? `; ${t.buylistNoRetail} cards without an F2F price are left out` : ''}.`}
            >
              <span>
                F2F sells them for <b>{money(t.buylistRetail)}</b>
              </span>
            </Tooltip>,
          ]}
        >
          <CashCreditTable
            rows={[
              { label: 'You get', cash: money(t.buylistCash), credit: money(t.buylistCredit), strong: true },
              {
                label: '% of F2F',
                cash: pct(t.buylistRetail ? (t.buylistCashWithRetail / t.buylistRetail) * 100 : null),
                credit: pct(t.buylistRetail ? (t.buylistCreditWithRetail / t.buylistRetail) * 100 : null),
              },
            ]}
          />
        </Stat>
        <Stat label="Buy / sell %" lines={['per card, buylist cards']}>
          <CashCreditTable
            rows={[
              { label: 'Median', cash: pct(t.medianPctCash), credit: pct(t.medianPctCredit) },
              { label: 'Average', cash: pct(t.meanPctCash), credit: pct(t.meanPctCredit) },
            ]}
          />
        </Stat>
        <Stat
          label="Bulk"
          value={`${t.bulkPrints}`}
          lines={[`${t.bulkCopies} copies`]}
          color="orange"
          icon={<IconBox color="var(--mantine-color-orange-5)" />}
          active={filters.category === 'bulk'}
          hint={filters.category === 'bulk' ? 'Click to show all cards again' : 'Click to show only bulk cards'}
          onClick={() => update({ ...filters, category: filters.category === 'bulk' ? 'all' : 'bulk' }, sort, 1)}
        />
        <Stat
          label="Bulk value"
          lines={[
            <Tooltip
              key="retail"
              multiline
              w={280}
              label={`Total of F2F's own NM prices for your bulk cards (when F2F lists them). "% of F2F" = your bulk payout ÷ that total.`}
            >
              <span>
                F2F sells them for <b>{money(t.bulkRetail)}</b>
              </span>
            </Tooltip>,
          ]}
        >
          <CashCreditTable
            rows={[
              { label: 'You get', cash: money(t.bulkCash), credit: money(t.bulkCredit), strong: true },
              {
                label: '% of F2F',
                cash: pct(t.bulkRetail ? (t.bulkCashWithRetail / t.bulkRetail) * 100 : null),
                credit: pct(t.bulkRetail ? (t.bulkCreditWithRetail / t.bulkRetail) * 100 : null),
              },
            ]}
          />
        </Stat>
        <Stat
          label="Needs review"
          value={`${reviewCount}`}
          color={reviewCount ? 'red' : undefined}
          icon={<IconAlertTriangle color="var(--mantine-color-red-6)" />}
          active={filters.problems}
          hint={filters.problems ? 'Click to show all cards again' : 'Click to show only cards that need review'}
          onClick={() => update({ ...filters, problems: !filters.problems, status: [] }, sort, 1)}
          lines={[`${t.notFound} not found · ${t.loose} loose · ${t.errors} errors`, ...(t.priceCheck ? [`${t.priceCheck} to price-check on F2F`] : [])]}
        />
      </SimpleGrid>

      <FiltersBar filters={filters} onChange={(f) => update(f, sort, 1)} items={all} counts={counts} />

      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {view.length} prints ({viewTotals.copies} copies) in view · {money(viewTotals.cash)} cash · {money(viewTotals.credit)} credit
          {run.bulkRates?.usedDefaults && (
            <Tooltip label="Some bulk lots were missing on F2F; built-in default rates were used for those.">
              <Text span c="yellow" ml={6}>
                (default bulk rates)
              </Text>
            </Tooltip>
          )}
        </Text>
        <Group gap="xs">
          <ColumnsMenu hidden={hidden} onChange={saveHidden} />
          <RunActions run={run} viewItems={() => view} />
        </Group>
      </Group>

      <Paper withBorder radius="md">
        <DataTable<Item>
          idAccessor="key"
          records={records}
          columns={columns}
          fetching={items === undefined}
          minHeight={records.length ? undefined : 200}
          noRecordsText={all.length ? 'No cards match these filters' : 'No cards'}
          striped
          highlightOnHover
          verticalSpacing={4}
          horizontalSpacing="xs"
          sortStatus={sortStatus}
          onSortStatusChange={(s) => update(filters, { key: s.columnAccessor as SortKey, dir: s.direction }, 1)}
          totalRecords={view.length}
          recordsPerPage={pageSize}
          page={safePage}
          onPageChange={(p) => update(filters, sort, p)}
          recordsPerPageOptions={PAGE_SIZES}
          onRecordsPerPageChange={(n) => {
            setPageSize(n);
            update(filters, sort, 1);
          }}
          recordsPerPageLabel="Cards per page"
          paginationText={({ from, to, totalRecords }) => `${from}–${to} of ${totalRecords}`}
        />
      </Paper>
    </Stack>
  );
}
