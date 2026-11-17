import { ActionIcon, Affix, Badge, Button, Drawer, Group, Loader, NumberInput, Paper, ScrollArea, Stack, Table, Text, Tooltip } from '@mantine/core';
import { IconFileExport, IconListDetails, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { useActivity } from '@/lib/activity';
import { finishLabel } from '@/lib/format';
import { MAX_EXPORT_QTY, type ExportList } from '../list';

const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** "42 prints · 117 copies" */
export const exportSummary = (list: Pick<ExportList, 'prints' | 'copies'>) => `${plural(list.prints, 'print')} · ${plural(list.copies, 'copy', 'copies')}`;

function ExportTable({ exportList }: { exportList: ExportList }) {
  return (
    <Table verticalSpacing={4} striped highlightOnHover fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Card</Table.Th>
          <Table.Th>Print</Table.Th>
          <Table.Th w={110}>Copies</Table.Th>
          <Table.Th w={36} />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {exportList.items.map((i) => (
          <Table.Tr key={i.key}>
            <Table.Td>
              <Text size="sm">{i.name}</Text>
              {i.note && (
                <Text size="xs" c="dimmed">
                  {i.note}
                </Text>
              )}
            </Table.Td>
            <Table.Td>
              <Text size="xs" style={{ whiteSpace: 'nowrap' }}>
                {i.set.toUpperCase()} #{i.cn} · {finishLabel(i.finish)}
              </Text>
            </Table.Td>
            <Table.Td>
              <NumberInput
                size="xs"
                min={1}
                max={MAX_EXPORT_QTY}
                allowDecimal={false}
                value={i.qty}
                onChange={(v) => typeof v === 'number' && exportList.setQty(i.key, v)}
                w={90}
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

/** Opens the Change log, on the running export when there is one. */
function SeeExports() {
  const running = useActivity().find((a) => a.kind === 'export');
  const p = running?.progress;
  return (
    <Button
      component={Link}
      to={running?.to ?? '/changes'}
      size="xs"
      variant="light"
      leftSection={running ? <Loader size={12} /> : <IconListDetails size={14} />}
      style={{ whiteSpace: 'nowrap' }}
    >
      {running ? `Export running${p ? ` · ${n(p.done)}/${n(p.total)}` : ''}` : 'See exports'}
    </Button>
  );
}

/**
 * What a page will export: a bar at the bottom while it holds something or an export runs, a
 * drawer to review the list, and the page's export button (`onExport`).
 */
export function ExportBar({ exportList, onExport, siteLabel }: { exportList: ExportList; onExport: () => void; siteLabel: string }) {
  const [open, setOpen] = useState(false);
  const exportRunning = useActivity().some((a) => a.kind === 'export');
  const picked = exportList.prints > 0;
  return (
    <>
      {(picked || exportRunning) && (
        <Affix position={{ bottom: 20, right: 24 }} zIndex={150}>
          <Paper withBorder shadow="lg" radius="md" p="xs" pl="md">
            <Group gap="sm" wrap="nowrap">
              {picked && (
                <>
                  <IconFileExport size={18} />
                  <Text size="sm" fw={600} className="ti-num" style={{ whiteSpace: 'nowrap' }}>
                    To export: {exportSummary(exportList)}
                  </Text>
                  <Tooltip label="Clear the list">
                    <ActionIcon variant="subtle" color="red" onClick={() => exportList.clear()} aria-label="Clear the list of cards to export">
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                  <Button size="xs" variant="default" onClick={() => setOpen(true)}>
                    Review
                  </Button>
                </>
              )}
              <SeeExports />
              {picked && (
                <Button size="xs" leftSection={<IconUpload size={14} />} onClick={onExport}>
                  Export to {siteLabel}…
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
        size="lg"
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
          <ExportTable exportList={exportList} />
        </Stack>
      </Drawer>
    </>
  );
}
