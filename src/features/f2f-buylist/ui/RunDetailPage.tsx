import { Alert, Anchor, Badge, Button, Grid, Group, Paper, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { useLocalStorage } from '@mantine/hooks';
import { IconAlertTriangle, IconArrowLeft, IconBox, IconBuildingStore, IconCash } from '@tabler/icons-react';
import { DataTable, type DataTableSortStatus } from 'mantine-datatable';
import { useStickyTableHeader } from '@/lib/ui/useStickyTableHeader';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { useRun, useRunItems } from '@/lib/accounts/hooks';
import { accountLabel, type AccountKey } from '@/lib/accounts/types';
import { boardCopies } from '@/lib/decks/BoardCheckboxes';
import { useCollectionMeta, useDeckData, useDecks, useDecksMeta, useSyncState } from '@/lib/decks/hooks';
import { siteOf } from '@/lib/sites/registry';
import { JobProgress } from '@/lib/ui/JobProgress';
import { renderPagination } from '@/lib/ui/pagination';
import { SiteIcon } from '@/lib/ui/SiteIcon';
import { f2fLinks } from '@/lib/f2f/links';
import { categoryOf, type Item } from '../types';
import { buySellStats, summarize, type BuySellStats, type PctStats } from '../summary';
import { useSellingDeckFilter } from '../deck-filter';
import { freeCopies, type FreeCopies } from '../in-decks';
import { Stat } from '@/lib/ui/Stat';
import { RunActions } from './RunActions';
import { CollectionReadProgress } from './CollectionRun';
import { ColumnsMenu, useHiddenColumns } from './ColumnsMenu';
import { buildColumns, reviewRowClass, type QtyNote } from './columns';
import { DeckFilter } from './DeckFilter';
import { applyFilters, applySort, filtersFromParams, sortFromParams, writeParams, type Filters, type Sort, type SortKey } from './filtering';
import { FiltersBar } from './FiltersBar';
import { dateTime, money, pct, PHASE_LABEL, runStep, STATUS_COLOR, STATUS_LABEL } from './format';

const PAGE_SIZES = [25, 50, 100, 250, 500];

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;

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

/** `part` ÷ `whole` in %, or "—" without a whole. */
const ratio = (part: number, whole: number) => pct(whole ? (part / whole) * 100 : null);

function Copies({ n }: { n: number }) {
  return (
    <Text size="xs" c="dimmed" className="ti-num">
      {n.toLocaleString('en-CA')} {n === 1 ? 'copy' : 'copies'}
    </Text>
  );
}

/** Per-card buy ÷ sell %: median and average, cash and credit, for F2F buys, bulk and both. */
function PctTable({ stats }: { stats: BuySellStats }) {
  const rows: { label: string; s: PctStats; color?: string }[] = [
    { label: 'F2F buys', s: stats.buylist, color: 'teal' },
    { label: 'Bulk', s: stats.bulk, color: 'orange' },
    { label: 'All', s: stats.all },
  ];
  const th = (text: string) => (
    <Table.Th ta="right" c="teal">
      {text}
    </Table.Th>
  );
  return (
    <Table withRowBorders={false} withTableBorder={false} verticalSpacing={0} horizontalSpacing={8} fz="sm" className="ti-num" w="auto">
      <Table.Thead>
        <Table.Tr>
          <Table.Th />
          <Table.Th colSpan={2} ta="center" c="dimmed" fw={600}>
            Median
          </Table.Th>
          <Table.Th colSpan={2} ta="center" c="dimmed" fw={600}>
            Average
          </Table.Th>
          <Table.Th />
        </Table.Tr>
        <Table.Tr>
          <Table.Th />
          {th('Cash')}
          {th('Credit')}
          {th('Cash')}
          {th('Credit')}
          <Table.Th ta="right" c="dimmed" fw={400}>
            Prints
          </Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map(({ label, s, color }) => (
          <Table.Tr key={label}>
            <Table.Td c={color ?? 'dimmed'} style={{ whiteSpace: 'nowrap' }}>
              {label}
            </Table.Td>
            <Table.Td ta="right" fw={700}>
              {pct(s.medianCash)}
            </Table.Td>
            <Table.Td ta="right" fw={700}>
              {pct(s.medianCredit)}
            </Table.Td>
            <Table.Td ta="right" fw={700}>
              {pct(s.meanCash)}
            </Table.Td>
            <Table.Td ta="right" fw={700}>
              {pct(s.meanCredit)}
            </Table.Td>
            <Table.Td ta="right" c="dimmed">
              {s.cards.toLocaleString('en-CA')}
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/**
 * Runs this dashboard tab already switched the current account for. Opening a run of another
 * account switches to it once; after that (e.g. another tab switched back) it stays put, so two
 * tabs showing runs of different accounts can't keep switching each other.
 */
const switchedFor = new Set<number>();

/** Whether opening run `runId` (of `runAccount`) should make its account current now. */
export function shouldSwitchForRun(runId: number, runAccount: string, current: string | null, done: Set<number> = switchedFor): boolean {
  if (runAccount === current || done.has(runId)) return false;
  done.add(runId);
  return true;
}

export function RunDetailPage() {
  const tableRef = useStickyTableHeader();
  const runId = Number(useParams().runId);
  const [params, setParams] = useSearchParams();
  const [pageSize, setPageSize] = useLocalStorage({ key: 'tithies:f2f:pageSize', defaultValue: 50 });

  // null = not found (undefined means "still loading" for useLiveQuery).
  const run = useRun(runId);
  const { hidden, save: saveHidden } = useHiddenColumns();
  const items = useRunItems(runId);
  const { key: currentKey, accounts, switchTo } = useCurrentAccount();
  useEffect(() => {
    if (run && shouldSwitchForRun(runId, run.accountKey, currentKey)) void switchTo(run.accountKey as AccountKey);
  }, [run, runId, currentKey, switchTo]);

  const filters = useMemo(() => filtersFromParams(params), [params]);
  const sort = useMemo(() => sortFromParams(params), [params]);
  const page = Math.max(1, Number(params.get('page')) || 1);

  const update = useCallback(
    (f: Filters, s: Sort, p: number) => setParams(writeParams(params, f, s, p), { replace: true }),
    [params, setParams],
  );

  const all = useMemo(() => items ?? [], [items]);
  const runAccount = run ? accounts.find((a) => a.key === run.accountKey) : undefined;
  const site = siteOf(runAccount?.type ?? 'moxfield');

  // "Cards in decks": the run's account's decks and collection, loaded only while the filter is on.
  const accountKey = (run?.accountKey ?? null) as AccountKey | null;
  const { config: deckFilter, update: updateDeckFilter } = useSellingDeckFilter(accountKey);
  const deckKey = deckFilter?.enabled ? accountKey : null;
  const decks = useDecks(deckKey);
  const decksMeta = useDecksMeta(deckKey);
  const sync = useSyncState(deckKey);
  const collectionMeta = useCollectionMeta(deckKey);
  // Big tables are reloaded when a sync job ends, not on every deck it writes (as on the Comparator).
  const version = `${sync?.jobId ?? ''}:${sync?.status === 'running' ? 'running' : 'idle'}:${collectionMeta?.fetchedAt ?? 0}:${decksMeta?.lastSuccessAt ?? 0}`;
  const { deckCards, collection, loaded: deckDataLoaded } = useDeckData(deckKey, version);
  const boards = useMemo(() => boardCopies(deckCards), [deckCards]);
  // Only deck ids matter to the result (names are looked up at render time): a sync rewriting deck rows doesn't recompute it.
  const deckIdsKey = (decks ?? []).map((d) => d.id).join(',');
  const stableDecks = useMemo(() => decks ?? [], [deckIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const decksLoaded = decks !== undefined;
  const fresh = useMemo(
    () =>
      deckFilter?.enabled && decksLoaded && decksMeta?.lastSuccessAt && deckDataLoaded ? freeCopies(all, stableDecks, deckCards, collection, deckFilter) : null,
    [deckFilter, decksLoaded, decksMeta?.lastSuccessAt, deckDataLoaded, stableDecks, deckCards, collection, all],
  );
  // While new data loads, keep showing the previous result rather than blinking (never after turning it off).
  const previous = useRef<FreeCopies | null>(null);
  if (!deckFilter?.enabled) previous.current = null;
  else if (fresh) previous.current = fresh;
  const inDecks = fresh ?? previous.current;
  const shown = inDecks?.items ?? all;

  const counts = useMemo(
    () => ({
      all: shown.length,
      buylist: shown.filter((i) => categoryOf(i) === 'buylist').length,
      bulk: shown.filter((i) => categoryOf(i) === 'bulk').length,
      notBought: shown.filter((i) => categoryOf(i) === 'not_bought').length,
    }),
    [shown],
  );
  const view = useMemo(() => applySort(applyFilters(shown, filters), sort), [shown, filters, sort]);
  const lastPage = Math.max(1, Math.ceil(view.length / pageSize));
  const safePage = Math.min(page, lastPage);
  const records = view.slice((safePage - 1) * pageSize, safePage * pageSize);
  const viewTotals = useMemo(
    () => view.reduce((t, i) => ({ cash: t.cash + (i.buyCash ?? 0) * i.qty, credit: t.credit + (i.buyCredit ?? 0) * i.qty, copies: t.copies + i.qty }), { cash: 0, credit: 0, copies: 0 }),
    [view],
  );
  const qtyNote = useMemo(() => {
    if (!inDecks) return undefined;
    const names = new Map((decks ?? []).map((d) => [d.id, d.name]));
    return (i: Item): QtyNote | null => {
      const u = inDecks.usage.get(i.key);
      if (!u) return null;
      return {
        of: u.runQty,
        lines: [
          `${plural(u.inDecks, 'copy', 'copies')} of the run's ${u.runQty} left out: the included decks use this print`,
          ...u.decks.map((d) => `${names.get(d.deckId) ?? 'A deck'} (${site.boardLabel(d.board)}): ${d.qty}`),
        ],
      };
    };
  }, [inDecks, decks, site]);
  const columns = useMemo(() => buildColumns(hidden, qtyNote), [hidden, qtyNote]);
  // Live from items so runs created before a new total existed still show it. The run's progress
  // counts every card; the totals only those the "Cards in decks" filter keeps.
  const runTotals = useMemo(() => summarize(all, run?.totals.entries ?? 0), [all, run?.totals.entries]);
  const t = useMemo(() => (inDecks ? summarize(shown, run?.totals.entries ?? 0) : runTotals), [inDecks, shown, run?.totals.entries, runTotals]);
  const pctStats = useMemo(() => buySellStats(shown), [shown]);
  /** F2F buys and bulk together. */
  const total = {
    cash: t.buylistCash + t.bulkCash,
    credit: t.buylistCredit + t.bulkCredit,
    retail: t.buylistRetail + t.bulkRetail,
    cashWithRetail: t.buylistCashWithRetail + t.bulkCashWithRetail,
    creditWithRetail: t.buylistCreditWithRetail + t.bulkCreditWithRetail,
  };

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

  const reviewCount = t.notFound + t.loose + t.priceCheck + t.errors;
  const sortStatus: DataTableSortStatus<Item> = { columnAccessor: sort.key, direction: sort.dir };

  return (
    <Stack>
      {run.accountKey !== currentKey && (
        <Alert color="blue" variant="light" p="xs">
          <Group justify="space-between" gap="xs">
            <Text size="sm">
              This run checks {runAccount ? <b>{accountLabel(runAccount)}</b> : 'another account'}'s collection, but Tithies is showing another account.
            </Text>
            {runAccount && (
              <Button size="xs" variant="light" leftSection={<SiteIcon type={runAccount.type} size={14} />} onClick={() => void switchTo(runAccount.key)}>
                Switch to {accountLabel(runAccount)}
              </Button>
            )}
          </Group>
        </Alert>
      )}
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
            {dateTime(run.createdAt)} · {runAccount ? `${accountLabel(runAccount)} · ` : ''}
            {run.source.wholeCollection ? (
              <>
                <b>Whole {site.label} collection</b> (paper, non-proxy)
              </>
            ) : (
              <>
                {site.label} filters: <b>{run.source.summary}</b>
              </>
            )}{' '}
            · {runTotals.entries} rows → {runTotals.prints} prints · {run.requests} F2F requests
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

      {run.status === 'fetching_collection' && (
        <Paper withBorder p="sm" radius="md">
          <CollectionReadProgress run={run} size="lg" />
        </Paper>
      )}
      {run.status !== 'completed' && run.status !== 'fetching_collection' && (run.totals.prints > 0 || !run.source.wholeCollection) && (
        <Paper withBorder p="sm" radius="md">
          <Text size="sm" mb={6}>
            {PHASE_LABEL[run.phase]} — {runTotals.done}/{runTotals.prints} prints checked
            {runTotals.errors ? ` · ${runTotals.errors} errors` : ''}
          </Text>
          <JobProgress size="lg" done={runTotals.done} total={runTotals.prints} note={runStep(run.phase)} color={STATUS_COLOR[run.status]} active={run.status === 'running'} />
        </Paper>
      )}
      {run.error && (
        <Alert color="yellow" icon={<IconAlertTriangle />}>
          {run.error}
        </Alert>
      )}

      <Grid gap="sm">
        <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}>
          <Stat
            label="F2F buys"
            value={t.buylistPrints.toLocaleString('en-CA')}
            color="teal"
            icon={<IconCash color="var(--mantine-color-teal-5)" />}
            active={filters.category === 'buylist'}
            action={filters.category === 'buylist' ? 'Show all cards again' : 'Show only cards F2F buys'}
            onClick={() => update({ ...filters, category: filters.category === 'buylist' ? 'all' : 'buylist' }, sort, 1)}
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
            <Copies n={t.buylistCopies} />
            <CashCreditTable
              rows={[
                { label: 'You get', cash: money(t.buylistCash), credit: money(t.buylistCredit), strong: true },
                { label: '% of F2F', cash: ratio(t.buylistCashWithRetail, t.buylistRetail), credit: ratio(t.buylistCreditWithRetail, t.buylistRetail) },
              ]}
            />
          </Stat>
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}>
          <Stat
            label="Bulk"
            value={t.bulkPrints.toLocaleString('en-CA')}
            color="orange"
            icon={<IconBox color="var(--mantine-color-orange-5)" />}
            active={filters.category === 'bulk'}
            action={filters.category === 'bulk' ? 'Show all cards again' : 'Show only bulk cards'}
            onClick={() => update({ ...filters, category: filters.category === 'bulk' ? 'all' : 'bulk' }, sort, 1)}
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
            <Copies n={t.bulkCopies} />
            <CashCreditTable
              rows={[
                { label: 'You get', cash: money(t.bulkCash), credit: money(t.bulkCredit), strong: true },
                { label: '% of F2F', cash: ratio(t.bulkCashWithRetail, t.bulkRetail), credit: ratio(t.bulkCreditWithRetail, t.bulkRetail) },
              ]}
            />
          </Stat>
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}>
          <Stat
            label="Total: F2F buys + bulk"
            value={(t.buylistPrints + t.bulkPrints).toLocaleString('en-CA')}
            lines={[
              <Tooltip
                key="retail"
                multiline
                w={280}
                label={`Total of F2F's own NM prices for the cards F2F buys and your bulk cards (when F2F lists them). "% of F2F" = what you get ÷ that total.`}
              >
                <span>
                  F2F sells them for <b>{money(total.retail)}</b>
                </span>
              </Tooltip>,
              total.cash > 0 && `From F2F buys ${pct((t.buylistCash / total.cash) * 100)} · bulk ${pct((t.bulkCash / total.cash) * 100)} of what you get`,
            ].filter(Boolean)}
          >
            <Copies n={t.buylistCopies + t.bulkCopies} />
            <CashCreditTable
              rows={[
                { label: 'You get', cash: money(total.cash), credit: money(total.credit), strong: true },
                { label: '% of F2F', cash: ratio(total.cashWithRetail, total.retail), credit: ratio(total.creditWithRetail, total.retail) },
              ]}
            />
          </Stat>
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6, lg: 8 }}>
          <Stat
            label="Buy / sell % per card"
            lines={['Each print counts once; prints without an F2F price are left out. "% of F2F" above is the ratio of the totals.']}
          >
            <PctTable stats={pctStats} />
          </Stat>
        </Grid.Col>
        <Grid.Col span={{ base: 12, sm: 6, lg: 4 }}>
          <Stat
            label="Needs review"
            value={`${reviewCount}`}
            color={reviewCount ? 'red' : undefined}
            icon={<IconAlertTriangle color="var(--mantine-color-red-6)" />}
            active={filters.problems}
            action={filters.problems ? 'Show all cards again' : 'Show only cards that need review'}
            onClick={() => update({ ...filters, problems: !filters.problems, status: [] }, sort, 1)}
            lines={[`${t.notFound} not found · ${t.loose} loose · ${t.errors} errors`, ...(t.priceCheck ? [`${t.priceCheck} to price-check on F2F`] : [])]}
          />
        </Grid.Col>
      </Grid>

      <FiltersBar
        filters={filters}
        onChange={(f) => update(f, sort, 1)}
        items={shown}
        counts={counts}
        extraActive={deckFilter?.enabled ? 1 : 0}
        onReset={() => updateDeckFilter({ enabled: false })}
      >
        {deckFilter && (
          <DeckFilter
            accountKey={run.accountKey as AccountKey}
            site={site}
            config={deckFilter}
            update={updateDeckFilter}
            decks={decks}
            decksMeta={decksMeta}
            collection={collectionMeta}
            boards={boards}
            summary={inDecks?.summary ?? null}
          />
        )}
      </FiltersBar>

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

      <Paper ref={tableRef} withBorder radius="md">
        <DataTable<Item>
          idAccessor="key"
          records={records}
          columns={columns}
          fetching={items === undefined}
          minHeight={records.length ? undefined : 200}
          noRecordsText={all.length ? 'No cards match these filters' : run.status === 'fetching_collection' ? 'The cards show up here once the collection is read' : 'No cards'}
          striped
          highlightOnHover
          rowClassName={reviewRowClass}
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
          renderPagination={renderPagination}
        />
      </Paper>
    </Stack>
  );
}
