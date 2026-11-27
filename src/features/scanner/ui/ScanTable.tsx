import { ActionIcon, Badge, Button, Group, Image, Select, Stack, Table, Text, Tooltip } from '@mantine/core';
import { IconArrowBackUp, IconTrash } from '@tabler/icons-react';
import { LANGUAGE_LABELS } from '@/lib/cards/languages';
import type { Finish } from '@/lib/cards/types';
import { scryfallImage } from '@/lib/f2f/links';
import { finishLabel } from '@/lib/format';
import { CardThumb } from '@/lib/ui/CardThumb';
import { cardFinish, cardLang, cardStatus, chosenPrint, finishesOf, listed, sameArtPrints, type CardStatus } from '../scan-export';
import { needsCheck } from '../scan-queue';
import type { StoredCard, StoredPhoto } from '../scan-session';

export const STATUS_COLOR: Record<CardStatus, string> = { sure: 'green', review: 'orange', unknown: 'red', user: 'blue' };
export const STATUS_LABEL: Record<CardStatus, string> = { sure: 'Sure', review: 'To review', unknown: 'Not recognized', user: 'Corrected by you' };

const LANGUAGES = Object.entries(LANGUAGE_LABELS).map(([value, label]) => ({ value, label }));

/** How the card's print was found, and the text behind it. */
function printHow(c: StoredCard, checking: 'now' | 'waiting' | 'off'): { text: string; color?: string; detail?: string } {
  if (c.edit?.print) return { text: 'Picked by you', color: 'blue' };
  const p = c.check?.print;
  const read = p?.read?.text ? `Read: “${p.read.text.slice(-60)}”` : undefined;
  if (p) {
    switch (p.how) {
      case 'only print':
        return { text: 'Only print with this artwork' };
      case 'read':
        return { text: 'Read on the card', detail: read };
      case 'read + checked':
        return { text: 'Read, then compared', detail: read };
      case 'checked':
      case 'checked: kept':
        return { text: 'Compared with the prints', detail: p.margin !== undefined ? `Lead ${p.margin.toFixed(3)}` : undefined };
      case 'unsure':
        return { text: 'Unsure: pick the print', color: 'orange', detail: read };
      default:
        return { text: 'Best match', detail: read };
    }
  }
  if (sameArtPrints(c).length < 2) return { text: 'Only print with this artwork' };
  if (!needsCheck(c)) return { text: 'Best match' };
  return checking === 'now' ? { text: 'Checking…', color: 'dimmed' } : checking === 'waiting' ? { text: 'Waiting for its check', color: 'dimmed' } : { text: 'Not checked', color: 'orange' };
}

function langHow(c: StoredCard): string | undefined {
  if (c.edit?.lang) return 'Set by you';
  const l = c.check?.language;
  if (!l) return undefined;
  if (l.how === 'nothing read') return 'Nothing readable: English by default';
  if (l.how.startsWith('words')) return 'From the card’s words';
  if (l.how.startsWith('script')) return 'From the card’s script';
  if (l.how.startsWith('code')) return 'From the bottom line’s language code';
  if (l.how === 'name') return 'From the card’s name';
  return l.how;
}

export interface ScanTableProps {
  photo: StoredPhoto;
  /** Object URL of a Blob (made once per Blob). */
  urlOf: (b: Blob) => string;
  selected: number | null;
  onSelect: (n: number | null) => void;
  onEdit: (n: number, change: (c: StoredCard) => StoredCard) => void;
  onPickPrint: (n: number) => void;
  /** The check: running on this photo's cards now, waiting for its turn, or off. */
  checking: 'now' | 'waiting' | 'off';
}

/** One row per card of a photo: its cut-out, the card it's taken for, how its print and language were found, its finish. */
export function ScanTable({ photo, urlOf, selected, onSelect, onEdit, onPickPrint, checking }: ScanTableProps) {
  if (!photo.cards.length) return <Text size="sm">{photo.status === 'named' ? 'No card found in this photo: add one with “Add a missed card”.' : null}</Text>;
  return (
    <Table striped highlightOnHover verticalSpacing={4} fz="sm">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>#</Table.Th>
          <Table.Th>Photo</Table.Th>
          <Table.Th>Card</Table.Th>
          <Table.Th>Print</Table.Th>
          <Table.Th>Language</Table.Th>
          <Table.Th>Finish</Table.Th>
          <Table.Th />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {photo.cards.map((c) => {
          const print = chosenPrint(c);
          const status = cardStatus(c);
          const on = listed(c);
          const how = printHow(c, checking);
          const finishes = finishesOf(print);
          const lh = langHow(c);
          const pic = print ? scryfallImage(print.scryfallId, 'small', print.back ? 'back' : 'front') : null;
          return (
            <Table.Tr key={c.n} onClick={() => onSelect(selected === c.n ? null : c.n)} bg={selected === c.n ? 'var(--mantine-color-blue-light)' : undefined} style={{ cursor: 'pointer', opacity: on ? 1 : 0.45 }}>
              <Table.Td>
                <Tooltip label={on ? STATUS_LABEL[status] : 'Not a card: left out'}>
                  <Badge color={on ? STATUS_COLOR[status] : 'gray'} variant="filled" size="lg" circle>
                    {c.n}
                  </Badge>
                </Tooltip>
              </Table.Td>
              <Table.Td>
                <Image src={urlOf(c.crop)} w={48} radius={3} alt={`Card ${c.n}`} />
              </Table.Td>
              <Table.Td>
                <Group gap="xs" wrap="nowrap">
                  <CardThumb alt={print?.name ?? ''} small={pic} large={print ? scryfallImage(print.scryfallId, 'normal', print.back ? 'back' : 'front') : null} />
                  <Stack gap={0}>
                    <Text size="sm" fw={600} td={on ? undefined : 'line-through'}>
                      {print?.name ?? 'Not recognized'}
                    </Text>
                    {print && (
                      <Text size="xs" c="dimmed">
                        {print.setName} · {print.set.toUpperCase()} #{print.cn}
                      </Text>
                    )}
                    {c.sentAt && (
                      <Badge size="xs" color="teal" variant="light">
                        Sent
                      </Badge>
                    )}
                  </Stack>
                </Group>
              </Table.Td>
              <Table.Td onClick={(e) => e.stopPropagation()}>
                <Stack gap={2} align="flex-start">
                  <Tooltip label={how.detail} disabled={!how.detail} multiline w={320}>
                    <Text size="xs" c={how.color}>
                      {how.text}
                    </Text>
                  </Tooltip>
                  <Button size="compact-xs" variant="light" onClick={() => onPickPrint(c.n)} disabled={!on}>
                    {sameArtPrints(c).length > 1 ? `Pick print (${sameArtPrints(c).length} with this art)` : 'Pick print'}
                  </Button>
                </Stack>
              </Table.Td>
              <Table.Td onClick={(e) => e.stopPropagation()}>
                <Tooltip label={lh} disabled={!lh}>
                  <Select
                    size="xs"
                    w={150}
                    data={LANGUAGES}
                    value={cardLang(c)}
                    allowDeselect={false}
                    searchable
                    disabled={!on}
                    onChange={(v) => v && onEdit(c.n, (x) => ({ ...x, edit: { ...x.edit, lang: v } }))}
                    comboboxProps={{ withinPortal: true }}
                  />
                </Tooltip>
              </Table.Td>
              <Table.Td onClick={(e) => e.stopPropagation()}>
                <Select
                  size="xs"
                  w={110}
                  data={finishes.map((f) => ({ value: f, label: finishLabel(f) }))}
                  value={cardFinish(c)}
                  allowDeselect={false}
                  disabled={!on || finishes.length < 2}
                  onChange={(v) => v && onEdit(c.n, (x) => ({ ...x, edit: { ...x.edit, finish: v as Finish } }))}
                  comboboxProps={{ withinPortal: true }}
                />
              </Table.Td>
              <Table.Td onClick={(e) => e.stopPropagation()}>
                <Tooltip label={on ? 'Not a card: leave it out' : 'Put it back in the list'}>
                  <ActionIcon variant="subtle" color={on ? 'red' : 'gray'} onClick={() => onEdit(c.n, (x) => ({ ...x, edit: { ...x.edit, removed: on ? true : undefined } }))} aria-label={on ? 'Not a card' : 'Put back'}>
                    {on ? <IconTrash size={16} /> : <IconArrowBackUp size={16} />}
                  </ActionIcon>
                </Tooltip>
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
