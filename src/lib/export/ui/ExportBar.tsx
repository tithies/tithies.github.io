import { ActionIcon, Affix, Badge, Button, Drawer, Group, Loader, NumberInput, Paper, ScrollArea, Stack, Table, Text, Tooltip, useMatches } from '@mantine/core';
import { IconFileExport, IconListDetails, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { overallPercent } from '@/lib/changes/progress';
import type { ChangeOp } from '@/lib/changes/types';
import { finishLabel } from '@/lib/format';
import { MAX_EXPORT_QTY, type ExportList } from '../list';
import type { ExportItem } from '../types';

const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

const printLabel = (i: ExportItem) => `${i.set.toUpperCase()} #${i.cn} · ${finishLabel(i.finish)}`;

/** "42 prints · 117 copies" */
export const exportSummary = (list: Pick<ExportList, 'prints' | 'copies'>) => `${plural(list.prints, 'print')} · ${plural(list.copies, 'copy', 'copies')}`;

/** The list, print by print. Narrow (a phone): the print goes under the card's name, so the table fits. */
function ExportTable({ exportList, narrow }: { exportList: ExportList; narrow: boolean }) {
  return (
    <Table verticalSpacing={4} striped highlightOnHover fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Card</Table.Th>
          {!narrow && <Table.Th>Print</Table.Th>}
          <Table.Th w={narrow ? 80 : 110}>Copies</Table.Th>
          <Table.Th w={36} />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {exportList.items.map((i) => (
          <Table.Tr key={i.key}>
            <Table.Td>
              <Text size="sm">{i.name}</Text>
              {narrow && <Text size="xs">{printLabel(i)}</Text>}
              {i.note && (
                <Text size="xs" c="dimmed">
                  {i.note}
                </Text>
              )}
            </Table.Td>
            {!narrow && (
              <Table.Td>
                <Text size="xs" style={{ whiteSpace: 'nowrap' }}>
                  {printLabel(i)}
                </Text>
              </Table.Td>
            )}
            <Table.Td>
              <NumberInput
                size="xs"
                min={1}
                max={MAX_EXPORT_QTY}
                allowDecimal={false}
                value={i.qty}
                onChange={(v) => typeof v === 'number' && exportList.setQty(i.key, v)}
                w={narrow ? 70 : 90}
                aria-label={`Copies of ${i.name} to export`}
              />
            </Table.Td>
            <Table.Td>
              <ActionIcon variant="subtle" color="gray" onClick={() => exportList.remove([i.key])} aria-label={`Remove ${i.name} from the export`}>
                <IconX size={14} />
              </ActionIcon>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** The bar's button for the page's exports: the running one (with its progress), or "Exports". */
function SeeExports({ running, narrow, onClick }: { running?: ChangeOp; narrow: boolean; onClick: () => void }) {
  const p = running?.progress;
  const count = running?.overall ? `${overallPercent(running.overall)}%` : p && p.total > 0 ? `${n(p.done)}/${n(p.total)}` : '';
  const label = running ? (narrow ? count || 'Running' : `Export running${count ? ` · ${count}` : ''}`) : narrow ? 'Exports' : 'See exports';
  return (
    <Button size="xs" variant="light" leftSection={running ? <Loader size={12} /> : <IconListDetails size={14} />} onClick={onClick} className="ti-num" style={{ whiteSpace: 'nowrap' }}>
      {label}
    </Button>
  );
}

export interface ExportBarProps {
  exportList: ExportList;
  /** Opens the export dialog. */
  onExport: () => void;
  siteLabel: string;
  /** The latest exports made from this page (running first): the bar's "See exports" button shows when there are some. */
  exports: ChangeOp[];
  onSeeExports: () => void;
}

/**
 * What a page will export: a bar at the bottom while it holds something or one of its exports
 * runs, a drawer to review the list, the page's export button (`onExport`), and a button to see
 * its exports again (`onSeeExports`). On a phone it spans the width and wraps.
 */
export function ExportBar({ exportList, onExport, siteLabel, exports, onSeeExports }: ExportBarProps) {
  const [open, setOpen] = useState(false);
  const narrow = useMatches({ base: true, sm: false });
  const running = exports.find((o) => o.status === 'running');
  const picked = exportList.prints > 0;
  return (
    <>
      {(picked || running) && (
        <Affix position={narrow ? { bottom: 12, left: 12, right: 12 } : { bottom: 20, right: 24 }} zIndex={150}>
          <Paper withBorder shadow="lg" radius="md" p="xs" pl={narrow ? 'sm' : 'md'}>
            <Group gap={narrow ? 'xs' : 'sm'} wrap={narrow ? 'wrap' : 'nowrap'} justify="flex-end">
              {picked && (
                <Group gap={6} wrap="nowrap" mr="auto">
                  <IconFileExport size={18} style={{ flexShrink: 0 }} />
                  <Text size="sm" fw={600} className="ti-num" style={{ whiteSpace: 'nowrap' }}>
                    {narrow ? exportSummary(exportList) : `To export: ${exportSummary(exportList)}`}
                  </Text>
                  <Tooltip label="Clear the list">
                    <ActionIcon variant="subtle" color="red" onClick={() => exportList.clear()} aria-label="Clear the list of cards to export">
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              )}
              {picked && (
                <Button size="xs" variant="default" onClick={() => setOpen(true)}>
                  Review
                </Button>
              )}
              {exports.length > 0 && <SeeExports running={running} narrow={narrow} onClick={onSeeExports} />}
              {picked && (
                <Button size="xs" leftSection={<IconUpload size={14} />} onClick={onExport} style={{ whiteSpace: 'nowrap' }}>
                  {narrow ? 'Export…' : `Export to ${siteLabel}…`}
                </Button>
              )}
            </Group>
          </Paper>
        </Affix>
      )}
      <Drawer
        opened={open && exportList.prints > 0}
        onClose={() => setOpen(false)}
        position="right"
        size={narrow ? '100%' : 'lg'}
        title={
          <Group gap="xs">
            <IconFileExport size={18} />
            <Text fw={600}>To export</Text>
            <Badge variant="light">{exportSummary(exportList)}</Badge>
          </Group>
        }
        scrollAreaComponent={ScrollArea.Autosize}
      >
        <Stack>
          <Text size="sm" c="dimmed">
            The cards that will be exported, print by print. Change a quantity, or remove a print. This list only lives on this page: leaving the page clears it.
          </Text>
          <Group justify="space-between">
            <Button variant="subtle" color="red" size="xs" leftSection={<IconTrash size={14} />} onClick={() => exportList.clear()}>
              Clear the list
            </Button>
            <Button
              size="xs"
              leftSection={<IconUpload size={14} />}
              onClick={() => {
                setOpen(false);
                onExport();
              }}
            >
              Export to {siteLabel}…
            </Button>
          </Group>
          <ExportTable exportList={exportList} narrow={narrow} />
        </Stack>
      </Drawer>
    </>
  );
}
