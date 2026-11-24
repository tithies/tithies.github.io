import { Alert, Badge, Button, Code, Collapse, Group, Paper, Select, SegmentedControl, Stack, Text, Title, Tooltip, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconChevronDown, IconChevronRight, IconDownload } from '@tabler/icons-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { DataTable } from 'mantine-datatable';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { accountLabel, type AccountKey } from '@/lib/accounts/types';
import { listOps, opCalls } from '@/lib/changes/log';
import type { ChangeCall, ChangeOp } from '@/lib/changes/types';
import { StatusBadge } from '@/lib/changes/ui/StatusBadge';
import { ExportOpDetails } from '@/lib/export/ui/ExportOpDetails';
import { dateTime, duration, timeAgo } from '@/lib/format';
import { downloadText } from '@/lib/ui/download';
import { SiteIcon } from '@/lib/ui/SiteIcon';
import { renderPagination } from '@/lib/ui/pagination';

const OUTCOME: Record<ChangeCall['outcome'], { label: string; color: string; tip: string }> = {
  sent: { label: 'Sending', color: 'blue', tip: 'Sent, no answer yet' },
  ok: { label: 'Made', color: 'teal', tip: 'The site made this change' },
  failed: { label: 'Refused', color: 'gray', tip: 'The site refused it, or it was never sent: nothing changed' },
  unknown: { label: 'Unknown', color: 'orange', tip: "Tithies doesn't know whether the site made it (timeout, lost tab, server error): check on the site" },
};

function Block({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const lines = text.split('\n').length;
  return (
    <Stack gap={4}>
      <UnstyledButton onClick={() => setOpen((o) => !o)}>
        <Group gap={4}>
          {open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
          <Text size="xs" fw={600}>
            {label}
          </Text>
          <Text size="xs" c="dimmed">
            {lines > 1 ? `${lines} lines` : `${text.length} characters`}
          </Text>
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Code block mah={360} style={{ overflow: 'auto', whiteSpace: 'pre' }}>
          {text}
        </Code>
      </Collapse>
    </Stack>
  );
}

function CallRow({ call }: { call: ChangeCall }) {
  const o = OUTCOME[call.outcome];
  return (
    <Paper withBorder p="xs" radius="sm">
      <Stack gap={6}>
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Text size="xs" c="dimmed" className="ti-num" w={24}>
            #{call.seq}
          </Text>
          <Badge variant="default" radius="sm">
            {call.method}
          </Badge>
          <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all', flex: 1 }}>
            {call.url}
          </Text>
          <Tooltip label={o.tip} multiline w={260}>
            <Badge color={o.color} variant="light">
              {o.label}
            </Badge>
          </Tooltip>
        </Group>
        <Text size="xs" c="dimmed" className="ti-num">
          {dateTime(call.at)}
          {call.status ? ` · HTTP ${call.status}` : ''}
          {call.durationMs != null ? ` · ${call.durationMs < 1000 ? `${call.durationMs} ms` : duration(call.durationMs)}` : ''}
          {call.as ? ` · as ${call.as.userName}` : ''}
          {call.error ? ` · ${call.error}` : ''}
        </Text>
        <Block label="Request body" text={call.body} />
        <Block label="Answer" text={call.response ?? ''} />
      </Stack>
    </Paper>
  );
}

function OpDetails({ op }: { op: ChangeOp }) {
  const calls = useLiveQuery(() => opCalls(op.id!), [op.id, op.calls, op.heartbeatAt]);
  const download = () =>
    downloadText(`tithies-change-${op.id}-${new Date(op.startedAt).toISOString().slice(0, 10)}.json`, JSON.stringify({ ...op, requests: calls ?? [] }, null, 2), 'application/json');
  return (
    <Stack gap="sm" p="sm">
      {op.error && (
        <Alert color={op.status === 'cancelled' ? 'gray' : 'red'} variant="light" icon={<IconAlertTriangle size={18} />} p="xs">
          {op.error}
        </Alert>
      )}
      {op.kind === 'export' ? <ExportOpDetails op={op} /> : <Block label="Details" text={JSON.stringify(op.details, null, 2)} />}
      <Group justify="space-between">
        <Text size="sm" fw={600}>
          Requests sent ({calls?.length ?? '…'})
        </Text>
        <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} onClick={download} disabled={!calls}>
          Download JSON
        </Button>
      </Group>
      {calls?.length === 0 && (
        <Text size="sm" c="dimmed">
          Nothing was sent.
        </Text>
      )}
      {calls?.map((c) => <CallRow key={c.seq} call={c} />)}
    </Stack>
  );
}

/** Every change Tithies made to a site, by action; each action's requests exactly as sent. */
export function ChangeLogPage() {
  const ops = useLiveQuery(listOps, []);
  const { accounts } = useCurrentAccount();
  const [account, setAccount] = useState<string | null>(null);
  const [only, setOnly] = useState<'all' | 'problems'>('all');
  // `?op=<id>` (from the export dialog, the export bar or "Running"): that action opens expanded.
  const [params] = useSearchParams();
  const [expanded, setExpanded] = useState<number[]>(() => {
    const id = Number(params.get('op'));
    return Number.isInteger(id) && id > 0 ? [id] : [];
  });
  const [page, setPage] = useState(1);
  const byKey = useMemo(() => new Map(accounts.map((a) => [a.key, a])), [accounts]);
  const shown = (ops ?? []).filter(
    (o) => (!account || o.accountKey === account) && (only === 'all' || o.status === 'failed' || o.status === 'interrupted' || o.unknownCalls > 0),
  );
  const PAGE = 25;
  const records = shown.slice((page - 1) * PAGE, page * PAGE);
  const accountName = (key: AccountKey, fallback: string) => {
    const a = byKey.get(key);
    return a ? accountLabel(a) : fallback;
  };

  return (
    <Stack>
      <Stack gap={4}>
        <Title order={2}>Change log</Title>
        <Text size="sm" c="dimmed">
          Everything Tithies changed on your sites, newest first: each action, and every request it sent, exactly as sent (sessions and tokens are never
          logged). Kept in this browser; clear it in Settings → Stored data.
        </Text>
      </Stack>
      <Group gap="sm">
        <Select
          placeholder="Every account"
          data={accounts.map((a) => ({ value: a.key, label: accountLabel(a) }))}
          value={account}
          onChange={(v) => {
            setAccount(v);
            setPage(1);
          }}
          clearable
          w={240}
        />
        <SegmentedControl
          value={only}
          onChange={(v) => {
            setOnly(v as 'all' | 'problems');
            setPage(1);
          }}
          data={[
            { value: 'all', label: 'All' },
            { value: 'problems', label: 'Failed, interrupted or unknown' },
          ]}
        />
      </Group>
      <Paper withBorder radius="md">
        <DataTable<ChangeOp>
          idAccessor="id"
          records={records}
          fetching={ops === undefined}
          minHeight={records.length ? undefined : 180}
          noRecordsText={ops?.length ? 'No action matches' : 'Tithies has not changed anything on your sites yet'}
          highlightOnHover
          verticalSpacing="xs"
          totalRecords={shown.length}
          recordsPerPage={PAGE}
          page={page}
          onPageChange={setPage}
          renderPagination={renderPagination}
          rowExpansion={{
            allowMultiple: true,
            expanded: { recordIds: expanded, onRecordIdsChange: (ids: unknown[]) => setExpanded(ids as number[]) },
            content: ({ record }) => <OpDetails op={record} />,
          }}
          columns={[
            {
              accessor: 'expand',
              title: '',
              width: 30,
              render: (o) => (expanded.includes(o.id!) ? <IconChevronDown size={16} /> : <IconChevronRight size={16} />),
            },
            {
              accessor: 'startedAt',
              title: 'When',
              width: 170,
              render: (o) => (
                <Tooltip label={dateTime(o.startedAt)}>
                  <Text size="sm">{timeAgo(o.startedAt)}</Text>
                </Tooltip>
              ),
            },
            {
              accessor: 'accountKey',
              title: 'Account',
              width: 200,
              render: (o) => (
                <Group gap={6} wrap="nowrap">
                  <SiteIcon type={o.site} size={16} />
                  <Text size="sm" truncate>
                    {accountName(o.accountKey, o.userName)}
                  </Text>
                </Group>
              ),
            },
            {
              accessor: 'title',
              title: 'Action',
              render: (o) => (
                <Stack gap={0}>
                  <Text size="sm" fw={500}>
                    {o.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {o.source}
                    {(o.status === 'running' || o.status === 'queued') && o.phase ? ` · ${o.phase}` : ''}
                  </Text>
                </Stack>
              ),
            },
            { accessor: 'status', title: 'Status', width: 190, render: (o) => <StatusBadge op={o} /> },
            { accessor: 'calls', title: 'Requests', width: 90, textAlign: 'right', render: (o) => <Text size="sm" className="ti-num">{o.calls}</Text> },
          ]}
        />
      </Paper>
    </Stack>
  );
}
