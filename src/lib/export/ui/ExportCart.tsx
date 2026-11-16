import { ActionIcon, Affix, Badge, Button, Drawer, Group, NumberInput, Paper, ScrollArea, Stack, Table, Text, Tooltip } from '@mantine/core';
import { IconShoppingCart, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import { useState } from 'react';
import { finishLabel } from '@/lib/format';
import { MAX_CART_QTY, type ExportCart } from '../cart';

const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** "42 prints · 117 copies" */
export const cartSummary = (cart: Pick<ExportCart, 'prints' | 'copies'>) => `${plural(cart.prints, 'print')} · ${plural(cart.copies, 'copy', 'copies')}`;

function CartTable({ cart }: { cart: ExportCart }) {
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
        {cart.items.map((i) => (
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
              <NumberInput size="xs" min={1} max={MAX_CART_QTY} allowDecimal={false} value={i.qty} onChange={(v) => typeof v === 'number' && cart.setQty(i.key, v)} w={90} />
            </Table.Td>
            <Table.Td>
              <ActionIcon variant="subtle" color="gray" onClick={() => cart.remove([i.key])} aria-label={`Remove ${i.name}`}>
                <IconX size={14} />
              </ActionIcon>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/**
 * The cart of a page: a bar at the bottom while it holds something, a drawer to review it, and
 * the page's export button (`onExport`).
 */
export function ExportCartBar({ cart, onExport, siteLabel }: { cart: ExportCart; onExport: () => void; siteLabel: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {cart.prints > 0 && (
        <Affix position={{ bottom: 20, right: 24 }} zIndex={150}>
          <Paper withBorder shadow="lg" radius="md" p="xs" pl="md">
            <Group gap="sm" wrap="nowrap">
              <IconShoppingCart size={18} />
              <Text size="sm" fw={600} className="ti-num" style={{ whiteSpace: 'nowrap' }}>
                {cartSummary(cart)}
              </Text>
              <Button size="xs" variant="default" onClick={() => setOpen(true)}>
                Review
              </Button>
              <Button size="xs" leftSection={<IconUpload size={14} />} onClick={onExport}>
                Export to {siteLabel}…
              </Button>
            </Group>
          </Paper>
        </Affix>
      )}
      <Drawer
        opened={open && cart.prints > 0}
        onClose={() => setOpen(false)}
        position="right"
        size="lg"
        title={
          <Group gap="xs">
            <IconShoppingCart size={18} />
            <Text fw={600}>Export cart</Text>
            <Badge variant="light">{cartSummary(cart)}</Badge>
          </Group>
        }
        scrollAreaComponent={ScrollArea.Autosize}
      >
        <Stack>
          <Text size="sm" c="dimmed">
            What will be exported, print by print. Change a quantity, or remove a print. The cart only lives on this page: leaving the page empties it.
          </Text>
          <Group justify="space-between">
            <Tooltip label="Empty the cart">
              <Button variant="subtle" color="red" size="xs" leftSection={<IconTrash size={14} />} onClick={() => cart.clear()}>
                Clear cart
              </Button>
            </Tooltip>
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
          <CartTable cart={cart} />
        </Stack>
      </Drawer>
    </>
  );
}
