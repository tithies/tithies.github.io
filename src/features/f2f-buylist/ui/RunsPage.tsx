import { Anchor, Badge, Button, Group, List, Paper, Stack, Text, Title } from '@mantine/core';
import { DataTable } from 'mantine-datatable';
import { GettingStarted } from '@/lib/ui/GettingStarted';
import { JobProgress } from '@/lib/ui/JobProgress';
import { useStickyTableHeader } from '@/lib/ui/useStickyTableHeader';
import { Link, useNavigate } from 'react-router';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { useRuns } from '@/lib/accounts/hooks';
import { f2fLinks } from '@/lib/f2f/links';
import type { Run } from '../types';
import { RunActions } from './RunActions';
import { CheckCollectionButton, CollectionReadProgress } from './CollectionRun';
import { dateTime, money, PHASE_LABEL, STATUS_COLOR, STATUS_LABEL } from './format';

export function RunsPage() {
  const tableRef = useStickyTableHeader();
  const { key } = useCurrentAccount();
  // Only the current account's runs.
  const runs = useRuns(key);
  const navigate = useNavigate();
  const reading = (runs ?? []).some((r) => r.status === 'fetching_collection');

  return (
    <Stack>
      <Group justify="space-between" align="flex-start">
        <Title order={2}>Selling runs</Title>
        <Group gap="xs" align="flex-start">
          <Button component="a" href={f2fLinks.sellHome} target="_blank" variant="light" size="xs">
            F2F sell page
          </Button>
          <Button component="a" href={f2fLinks.sellBulk} target="_blank" variant="light" color="orange" size="xs">
            F2F bulk prices
          </Button>
          <Button component="a" href={f2fLinks.shopHome} target="_blank" variant="default" size="xs">
            F2F shop
          </Button>
          <CheckCollectionButton waiting={reading} />
        </Group>
      </Group>

      {!key || (runs && runs.length === 0) ? (
        <GettingStarted title="Check what F2F pays for your cards">
          <List type="ordered" size="sm" spacing={6}>
            <List.Item>
              Open{' '}
              <Anchor href="https://moxfield.com/collection" target="_blank" size="sm">
                your Moxfield collection
              </Anchor>{' '}
              while logged in, and apply any filters you want (set, rarity, search…).
            </List.Item>
            <List.Item>
              In the Tithies panel, in the bottom-right corner of that page, click <b>Check selling prices on F2F</b>.
            </List.Item>
            <List.Item>
              The check shows up here and keeps running in the background. Open it to see what F2F pays for each card, in cash and store credit.
            </List.Item>
          </List>
          <Text size="sm">
            Or check your <b>whole collection</b> from here with <b>Check whole collection</b> (top right): Tithies reads it from Moxfield in the
            background (only what changed since its last read, when it can), then checks every paper, non-proxy card.
          </Text>
          <Text size="sm" c="dimmed">
            Non-proxy cards are checked, at NM prices, each in the language Moxfield says it is: F2F lists most prints in English only, and a card it
            doesn't list in its language counts as not bought. The panel can be minimised to the Tithies medallion; it stays that way until you open it
            again.
          </Text>
        </GettingStarted>
      ) : (
        <Paper ref={tableRef} withBorder radius="md">
          <DataTable<Run>
            minHeight={runs?.length ? undefined : 150}
            fetching={runs === undefined}
            records={runs ?? []}
            highlightOnHover
            noRecordsText="No runs"
            onRowClick={({ record }) => navigate(`/f2f/runs/${record.id}`)}
            columns={[
              {
                accessor: 'createdAt',
                title: 'Date',
                render: (r) => (
                  <Anchor component={Link} to={`/f2f/runs/${r.id}`} onClick={(e) => e.stopPropagation()}>
                    {dateTime(r.createdAt)}
                  </Anchor>
                ),
              },
              {
                accessor: 'source',
                title: 'Moxfield filters',
                render: (r) => (
                  <Text size="sm" lineClamp={2} title={r.source.wholeCollection ? 'Every paper, non-proxy card, read from the dashboard' : r.source.url}>
                    {r.source.summary}
                  </Text>
                ),
              },
              {
                accessor: 'prints',
                title: 'Prints / copies',
                textAlign: 'right',
                render: (r) => (
                  <Text size="sm" className="ti-num">
                    {r.totals.prints} / {r.totals.copies}
                  </Text>
                ),
              },
              {
                accessor: 'buylist',
                title: 'F2F buys',
                textAlign: 'right',
                render: (r) => (
                  <Text size="sm" className="ti-num" c="teal">
                    {r.totals.buylistPrints}
                  </Text>
                ),
              },
              {
                accessor: 'bulk',
                title: 'Bulk',
                textAlign: 'right',
                render: (r) => (
                  <Text size="sm" className="ti-num" c="orange">
                    {r.totals.bulkPrints}
                  </Text>
                ),
              },
              {
                accessor: 'cash',
                title: 'Cash (card prices + bulk)',
                textAlign: 'right',
                render: (r) => (
                  <Text size="sm" className="ti-num">
                    {money(r.totals.buylistCash + r.totals.bulkCash)}
                  </Text>
                ),
              },
              {
                accessor: 'credit',
                title: 'Credit',
                textAlign: 'right',
                render: (r) => (
                  <Text size="sm" className="ti-num">
                    {money(r.totals.buylistCredit + r.totals.bulkCredit)}
                  </Text>
                ),
              },
              {
                accessor: 'status',
                title: 'Status',
                width: 210,
                render: (r) => {
                  return (
                    <Stack gap={4}>
                      <Group gap={6}>
                        <Badge color={STATUS_COLOR[r.status]} variant="light">
                          {STATUS_LABEL[r.status]}
                        </Badge>
                        {r.status === 'running' && (
                          <Text size="xs" c="dimmed">
                            {PHASE_LABEL[r.phase]}
                          </Text>
                        )}
                        {r.totals.errors > 0 && (
                          <Badge color="red" variant="outline" size="sm">
                            {r.totals.errors} errors
                          </Badge>
                        )}
                      </Group>
                      {r.status === 'fetching_collection' ? (
                        <CollectionReadProgress run={r} />
                      ) : (
                        r.status !== 'completed' && (
                          <JobProgress size="sm" done={r.totals.done} total={r.totals.prints} color={STATUS_COLOR[r.status]} active={r.status === 'running'} />
                        )
                      )}
                    </Stack>
                  );
                },
              },
              {
                accessor: 'actions',
                title: '',
                textAlign: 'right',
                render: (r) => (
                  <div onClick={(e) => e.stopPropagation()}>
                    <RunActions run={r} compact />
                  </div>
                ),
              },
            ]}
          />
        </Paper>
      )}
    </Stack>
  );
}
