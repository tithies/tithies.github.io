import { Alert, Anchor, Badge, Button, Group, Paper, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconDownload } from '@tabler/icons-react';
import type { ChangeOp } from '@/lib/changes/types';
import { finishLabel } from '@/lib/format';
import { siteOf } from '@/lib/sites/registry';
import { MOX_CONDITION_NAMES, MOX_LANGUAGE_NAMES, toMoxCsv } from '@/lib/sites/moxfield/csv';
import { downloadText } from '@/lib/ui/download';
import { Stat } from '@/lib/ui/Stat';
import type { ExportDetails, RemovedEntry, VerifyDiff } from '../types';

const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const print = (d: { set: string; cn: string; finish: VerifyDiff['finish'] }) => `${d.set.toUpperCase()} #${d.cn} ${finishLabel(d.finish)}`;

/** The removed entries as a Moxfield CSV, to import them back by hand (condition and language kept). */
export function removedAsCsv(removed: readonly RemovedEntry[]): string {
  return toMoxCsv(
    removed.map((r) => ({
      qty: r.qty,
      name: r.name,
      set: r.set,
      cn: r.cn,
      finish: r.finish,
      condition: MOX_CONDITION_NAMES[r.condition] ?? 'Near Mint',
      language: MOX_LANGUAGE_NAMES[r.lang] ?? 'English',
      isProxy: r.isProxy,
      isAlter: r.isAlter,
    })),
  );
}

function DiffTable({ title, rows, color }: { title: string; rows: VerifyDiff[]; color: string }) {
  if (!rows.length) return null;
  return (
    <Stack gap={4}>
      <Text size="sm" fw={600} c={color}>
        {title} ({rows.length})
      </Text>
      <Table withRowBorders={false} verticalSpacing={2} fz="xs">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Card</Table.Th>
            <Table.Th>Print</Table.Th>
            <Table.Th ta="right">Expected</Table.Th>
            <Table.Th ta="right">Found</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.slice(0, 200).map((d) => (
            <Table.Tr key={`${d.key}|${d.outside ? 'o' : 'i'}`}>
              <Table.Td>
                {d.name}
                {d.outside ? (
                  <Text span size="xs" c="dimmed">
                    {' '}
                    (outside the binder)
                  </Text>
                ) : null}
              </Table.Td>
              <Table.Td>{print(d)}</Table.Td>
              <Table.Td ta="right" className="ti-num">
                {d.expected}
              </Table.Td>
              <Table.Td ta="right" className="ti-num">
                {d.found}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {rows.length > 200 && (
        <Text size="xs" c="dimmed">
          …and {rows.length - 200} more (in the JSON download)
        </Text>
      )}
    </Stack>
  );
}

/** What an export did: target, counts, the before/after check, and the cards it removed. */
export function ExportOpDetails({ op }: { op: ChangeOp }) {
  const d = op.details as ExportDetails;
  if (!d?.target) return null;
  const site = siteOf(op.site);
  const v = d.verify;
  const date = new Date(op.startedAt).toISOString().slice(0, 10);
  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Stat
          label="Target"
          lines={[
            d.binder ? (
              <Anchor key="b" href={site.binderUrl(d.binder.publicId)} target="_blank" size="xs">
                Open the binder “{d.binder.name}” on {site.label}
              </Anchor>
            ) : (
              <Anchor key="c" href={site.collectionUrl} target="_blank" size="xs">
                Open the collection on {site.label}
              </Anchor>
            ),
          ]}
        >
          <Text size="sm" fw={600}>
            {d.targetLabel}
          </Text>
        </Stat>
        <Stat label="Added" value={plural(d.add.copies, 'copy', 'copies')} lines={[plural(d.add.prints, 'print'), 'Near Mint, English']} />
        <Stat
          label="Deleted first"
          value={d.removed.length ? plural(d.removed.reduce((s, r) => s + r.qty, 0), 'copy', 'copies') : 'Nothing'}
          color={d.removed.length ? 'red' : undefined}
          lines={[d.wholeCollection ? 'The whole collection' : d.removed.length ? plural(d.removed.length, 'entry', 'entries') : 'Nothing was deleted']}
        />
      </SimpleGrid>

      {d.imported && (d.imported.errors.length > 0 || d.imported.failed > 0) && (
        <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} p="xs" title={`${site.label} reported problems with the import`}>
          <Stack gap={2}>
            <Text size="sm">
              {site.label} says it imported {plural(d.imported.count, 'copy', 'copies')}
              {d.imported.failed ? `; ${plural(d.imported.failed, 'import')} failed` : ''}.
            </Text>
            {d.imported.errors.slice(0, 20).map((e, i) => (
              <Text key={i} size="xs" ff="monospace">
                {e}
              </Text>
            ))}
            {d.imported.errors.length > 20 && (
              <Text size="xs" c="dimmed">
                …and {d.imported.errors.length - 20} more (in the JSON download)
              </Text>
            )}
          </Stack>
        </Alert>
      )}
      {v ? (
        v.ok ? (
          <Alert color="teal" variant="light" icon={<IconCircleCheck size={18} />} p="xs">
            Checked after the export: all {plural(v.expectedCopies, 'copy', 'copies')} are there, and nothing else changed.
          </Alert>
        ) : (
          <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />} p="xs" title="The check after the export found differences">
            <Stack gap="xs">
              <Text size="sm">
                {n(v.foundCopies)} of {plural(v.expectedCopies, 'copy', 'copies')} are there. A card {site.label} imported as another print shows up both as short and as
                extra.
              </Text>
              <DiffTable title="Fewer copies than expected" rows={v.short} color="orange" />
              <DiffTable title="More copies than expected" rows={v.extra} color="orange" />
              <DiffTable title="Other prints that changed" rows={v.otherChanged} color="red" />
            </Stack>
          </Alert>
        )
      ) : op.status === 'running' ? null : (
        <Text size="sm" c="dimmed">
          Not checked: the collection couldn't be read again after the export.
        </Text>
      )}

      {d.removed.length > 0 && (
        <Paper withBorder p="xs" radius="sm">
          <Group justify="space-between">
            <Text size="sm">
              The {plural(d.removed.length, 'entry', 'entries')} deleted are kept here: import this file on {site.label} to put them back (condition and language
              kept; choose the binder when importing).
            </Text>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconDownload size={14} />}
              onClick={() => downloadText(`tithies-removed-${op.id}-${date}.csv`, removedAsCsv(d.removed), 'text/csv;charset=utf-8')}
            >
              Removed cards (CSV)
            </Button>
          </Group>
        </Paper>
      )}
      <Group gap={6}>
        <Badge variant="default">{plural(d.items.length, 'print')} in the cart</Badge>
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconDownload size={12} />}
          onClick={() => downloadText(`tithies-export-${op.id}-${date}.csv`, toMoxCsv(d.items), 'text/csv;charset=utf-8')}
        >
          Cart as CSV
        </Button>
      </Group>
    </Stack>
  );
}
