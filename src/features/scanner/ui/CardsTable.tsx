import { Badge, Group, Stack, Table, Text, Tooltip } from '@mantine/core';
import { CardThumb } from '@/lib/ui/CardThumb';
import { scryfallImage } from '@/lib/f2f/links';
import { ALL_METHODS } from '../models';
import { confidence, type ScannedPhoto } from '../pipeline';
import { sameName, type LabelCard } from '../labels';
import { BitmapCanvas } from './BitmapCanvas';

const CONF_COLOR = { sure: 'green', review: 'orange', unknown: 'red' } as const;

export interface CardsTableProps {
  photo: ScannedPhoto;
  method: string;
  labels: LabelCard[] | undefined;
  selected: number | null;
  onSelect: (n: number | null) => void;
  /** Card height below which naming was unreliable in the measurements so far (warning). */
  minHeightPx: number;
}

/**
 * One row per detected card: its flattened crop, size and source, the chosen method's top 5
 * (✓ when the photo's labels have that name), and every method's best answer.
 */
export function CardsTable({ photo, method, labels, selected, onSelect, minHeightPx }: CardsTableProps) {
  const inLabels = (name: string) => (labels ? labels.some((l) => sameName(l.name, name)) : undefined);
  return (
    <Table striped highlightOnHover verticalSpacing={4} fz="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>#</Table.Th>
          <Table.Th>Crop</Table.Th>
          <Table.Th>Shape</Table.Th>
          <Table.Th>Top 5 ({ALL_METHODS.find((m) => m.id === method)?.label})</Table.Th>
          <Table.Th>Best per method</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {photo.cards.map((c) => {
          const r = c.byMethod[method];
          const conf = confidence(r, method, photo.recognizer);
          return (
            <Table.Tr key={c.n} bg={selected === c.n ? 'var(--mantine-color-blue-light)' : undefined} style={{ cursor: 'pointer' }} onClick={() => onSelect(selected === c.n ? null : c.n)}>
              <Table.Td>
                <Badge color={CONF_COLOR[conf]} variant="filled" size="sm">
                  {c.n}
                </Badge>
              </Table.Td>
              <Table.Td>
                <BitmapCanvas bitmap={c.crop} width={56} />
              </Table.Td>
              <Table.Td>
                <Stack gap={0}>
                  <Text size="xs" c={c.heightPx < minHeightPx ? 'red' : undefined}>
                    {Math.round(c.heightPx)} px tall
                  </Text>
                  <Text size="xs" c="dimmed">
                    {c.source}
                    {r?.turned ? ' · upside down' : ''}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {Math.round(c.ms)} ms
                  </Text>
                </Stack>
              </Table.Td>
              <Table.Td>
                <Group gap={6} wrap="nowrap" align="flex-start">
                  {(r?.candidates ?? []).map((m, i) => {
                    const hit = inLabels(m.name);
                    return (
                      <Stack key={m.scryfallId} gap={0} w={92}>
                        <CardThumb alt={m.name} small={scryfallImage(m.scryfallId, 'small', m.back ? 'back' : 'front')} large={scryfallImage(m.scryfallId, 'normal', m.back ? 'back' : 'front')} />
                        <Text size="xs" fw={i === 0 ? 700 : 400} lineClamp={2} c={hit === true ? 'green' : hit === false && i === 0 ? 'red' : undefined}>
                          {hit === true ? '✓ ' : ''}
                          {m.name}
                        </Text>
                        <Text size="xs" c="dimmed">
                          {m.set.toUpperCase()} #{m.cn} · {m.score.toFixed(3)}
                        </Text>
                      </Stack>
                    );
                  })}
                </Group>
                {r && (
                  <Text size="xs" c="dimmed">
                    margin {r.margin.toFixed(3)}
                  </Text>
                )}
              </Table.Td>
              <Table.Td>
                <Stack gap={0}>
                  {ALL_METHODS.map((m) => {
                    const top = c.byMethod[m.id]?.candidates[0];
                    const hit = top ? inLabels(top.name) : undefined;
                    return (
                      <Tooltip key={m.id} label={m.label} withinPortal>
                        <Text size="xs" c={hit === true ? 'green' : hit === false ? 'red' : undefined} fw={m.id === method ? 700 : 400}>
                          {top ? `${top.name} · ${top.score.toFixed(3)}` : '—'}
                        </Text>
                      </Tooltip>
                    );
                  })}
                </Stack>
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
