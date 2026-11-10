import { Alert, Anchor, Badge, Button, Group, Paper, Progress, Stack, Text, Title } from '@mantine/core';
import { IconInfoCircle } from '@tabler/icons-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DataTable } from 'mantine-datatable';
import { Link, useNavigate } from 'react-router';
import { db } from '@/lib/db';
import { f2fLinks } from '@/lib/f2f/links';
import type { Run } from '../types';
import { RunActions } from './RunActions';
import { dateTime, money, PHASE_LABEL, STATUS_COLOR, STATUS_LABEL } from './format';

export function RunsPage() {
  const runs = useLiveQuery(() => db.runs.orderBy('createdAt').reverse().toArray(), []);
  const navigate = useNavigate();

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>F2F buylist runs</Title>
        <Group gap="xs">
          <Button component="a" href={f2fLinks.sellHome} target="_blank" variant="light" size="xs">
            F2F sell page
          </Button>
          <Button component="a" href={f2fLinks.sellBulk} target="_blank" variant="light" color="orange" size="xs">
            F2F bulk prices
          </Button>
          <Button component="a" href={f2fLinks.shopHome} target="_blank" variant="default" size="xs">
            F2F shop
          </Button>
        </Group>
      </Group>

      {runs && runs.length === 0 && (
        <Alert icon={<IconInfoCircle />} title="No runs yet">
          Open{' '}
          <Anchor href="https://moxfield.com/collection" target="_blank">
            your Moxfield collection
          </Anchor>
          , apply any filters, then click <b>Check F2F buylist</b> in the Tithies panel (bottom-right).
        </Alert>
      )}

      <Paper withBorder radius="md">
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
                <Text size="sm" lineClamp={2} title={r.source.url}>
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
              title: 'Cash (buylist + bulk)',
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
                const value = r.totals.prints ? (r.totals.done / r.totals.prints) * 100 : 0;
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
                    {r.status !== 'completed' && (
                      <Progress value={value} size="sm" animated={r.status === 'running'} color={STATUS_COLOR[r.status]} />
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
    </Stack>
  );
}
