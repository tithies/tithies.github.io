import { Alert, Anchor, Badge, Button, Group, Paper, SimpleGrid, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconDownload } from '@tabler/icons-react';
import type { ChangeOp } from '@/lib/changes/types';
import { finishLabel } from '@/lib/format';
import { siteOf } from '@/lib/sites/registry';
import { MOX_CONDITION_NAMES, MOX_LANGUAGE_NAMES, toMoxCsv } from '@/lib/sites/moxfield/csv';
import { isEnglish, langBadge, langLabel } from '@/lib/cards/languages';
import { downloadText } from '@/lib/ui/download';
import { Stat } from '@/lib/ui/Stat';
import { isDeckTarget, type ExportDetails, type RemovedEntry, type VerifyDiff } from '../types';

const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const print = (d: { set: string; cn: string; finish: VerifyDiff['finish']; lang?: string; printLang?: string }) =>
  `${d.set.toUpperCase()} #${d.cn} ${finishLabel(d.finish)}${isEnglish(d.lang) ? '' : ` · ${langBadge(d.lang)}`}${
    d.printLang && d.printLang !== (d.lang || 'en') ? ` (${langLabel(d.printLang)} print)` : ''
  }`;

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
  const decks = rows.some((d) => d.deck);
  return (
    <Stack gap={4}>
      <Text size="sm" fw={600} c={color}>
        {title} ({rows.length})
      </Text>
      <Table withRowBorders={false} verticalSpacing={2} fz="xs">
        <Table.Thead>
          <Table.Tr>
            {decks && <Table.Th>Deck</Table.Th>}
            <Table.Th>Card</Table.Th>
            <Table.Th>Print</Table.Th>
            <Table.Th ta="right">Expected</Table.Th>
            <Table.Th ta="right">Found</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.slice(0, 200).map((d) => (
            <Table.Tr key={`${d.deck ?? ''}|${d.key}|${d.outside ? 'o' : 'i'}`}>
              {decks && <Table.Td>{d.deck}</Table.Td>}
              <Table.Td>
                {d.name}
                {d.outside ? (
                  <Text span size="xs" c="dimmed">
                    {' '}
                    ({d.board ? `in the ${d.board}` : 'outside the binder'})
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
  // Waiting for its turn: nothing read nor made yet.
  if (!d?.target || op.status === 'queued') return null;
  const site = siteOf(op.site);
  const v = d.verify;
  const date = new Date(op.startedAt).toISOString().slice(0, 10);
  const toDecks = isDeckTarget(d.target);
  const decks = d.decks ?? [];
  const targetLinks = toDecks
    ? [
        ...(d.folder
          ? [
              <Anchor key="f" href={site.deckFolderUrl(d.folder.id)} target="_blank" size="xs">
                Open the folder “{d.folder.path}” on {site.label}
              </Anchor>,
            ]
          : []),
        ...decks.slice(0, d.folder ? 3 : 5).map((x) => (
          <Anchor key={x.publicId} href={site.deckUrl(x.publicId)} target="_blank" size="xs">
            Open the deck “{x.name}”{x.created ? ' (new)' : ''}
          </Anchor>
        )),
        ...(decks.length > (d.folder ? 3 : 5) ? [`…and ${n(decks.length - (d.folder ? 3 : 5))} more decks`] : []),
        ...(decks.length ? ['Tithies shows them after the next deck sync'] : []),
      ]
    : [
        d.binder ? (
          <Anchor key="b" href={site.binderUrl(d.binder.publicId)} target="_blank" size="xs">
            Open the binder “{d.binder.name}” on {site.label}
          </Anchor>
        ) : (
          <Anchor key="c" href={site.collectionUrl} target="_blank" size="xs">
            Open the collection on {site.label}
          </Anchor>
        ),
      ];
  return (
    <Stack gap="sm">
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Stat label="Target" lines={targetLinks}>
          <Text size="sm" fw={600}>
            {d.targetLabel}
          </Text>
        </Stat>
        <Stat
          label="Added"
          value={plural(d.add.copies, 'copy', 'copies')}
          lines={[plural(d.add.prints, 'print'), toDecks ? (decks.length > 1 ? `In the mainboard of ${plural(decks.length, 'deck')}` : 'In the mainboard') : 'Near Mint, each in its language']}
        />
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
            {v.scope === 'binder'
              ? `Checked after the export: all ${plural(v.expectedCopies, 'copy', 'copies')} are in the binder, and nothing else in it changed.`
              : v.scope === 'decks'
                ? `Checked after the export: all ${plural(v.expectedCopies, 'copy', 'copies')} are in the mainboard${decks.length > 1 ? ` of the ${n(decks.length)} decks` : ''}, and nothing else in ${decks.length > 1 ? 'them' : 'it'} changed.`
                : `Checked after the export: all ${plural(v.expectedCopies, 'copy', 'copies')} are in the collection, and nothing else in it changed.`}
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
      ) : op.status === 'running' || op.calls === 0 ? null : (
        <Text size="sm" c="dimmed">
          Not checked: the {toDecks ? 'decks' : 'collection'} couldn't be read again after the export.
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
        <Badge variant="default">{plural(d.items.length, 'print')} exported</Badge>
        <Button
          size="compact-xs"
          variant="subtle"
          leftSection={<IconDownload size={12} />}
          onClick={() => downloadText(`tithies-export-${op.id}-${date}.csv`, toMoxCsv(d.items), 'text/csv;charset=utf-8')}
        >
          Exported cards (CSV)
        </Button>
      </Group>
    </Stack>
  );
}
