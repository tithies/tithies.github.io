import { ActionIcon, Badge, Button, Checkbox, Group, Popover, Stack, Table, Text, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { IconRotate2, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { CardThumb } from '@/lib/ui/CardThumb';
import { scryfallImage } from '@/lib/f2f/links';
import type { CardMatchView, LabelCard } from '../labels';
import type { PrintInfo } from '../reference';
import { BitmapCanvas } from './BitmapCanvas';
import { PrintPicker } from './PrintPicker';

export interface LabelsTableProps {
  cards: readonly LabelCard[];
  matches: ReadonlyMap<string, CardMatchView> | undefined;
  /** Badge colour of each card (same as its outline). */
  colorOf: (c: LabelCard) => string;
  prints: readonly PrintInfo[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<LabelCard>) => void;
  onDelete: (id: string) => void;
  onTurn: (id: string) => void;
  /** Place the corners of a card that has none. */
  onOutline: (id: string) => void;
}

const thumb = (c: Pick<LabelCard, 'scryfallId' | 'back'>, size: 'small' | 'normal') => (c.scryfallId ? scryfallImage(c.scryfallId, size, c.back ? 'back' : 'front') : null);

/** The print as label fields (chosen by a person: checked, and kept when the corners move). */
export const printPatch = (p: Pick<PrintInfo, 'name' | 'set' | 'cn' | 'scryfallId' | 'back'>): Partial<LabelCard> => ({
  name: p.name,
  set: p.set,
  cn: p.cn,
  scryfallId: p.scryfallId,
  back: p.back || undefined,
  manual: true,
  checked: true,
});

function OtherCard({ card, onApply }: { card: LabelCard; onApply: (patch: Partial<LabelCard>) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(card.name === '?' ? '' : card.name);
  const [set, setSet] = useState(card.set ?? '');
  const [cn, setCn] = useState(card.cn ?? '');
  return (
    <Popover opened={open} onChange={setOpen} withinPortal position="bottom-start">
      <Popover.Target>
        <Button size="compact-xs" variant="subtle" onClick={() => setOpen((o) => !o)}>
          Not in my collection…
        </Button>
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap={4} w={240}>
          <TextInput size="xs" label="Card name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
          <Group gap={4} grow>
            <TextInput size="xs" label="Set code" placeholder="optional" value={set} onChange={(e) => setSet(e.currentTarget.value)} />
            <TextInput size="xs" label="Number" placeholder="optional" value={cn} onChange={(e) => setCn(e.currentTarget.value)} />
          </Group>
          <Button
            size="xs"
            disabled={!name.trim()}
            onClick={() => {
              onApply({ name: name.trim(), set: set.trim().toLowerCase() || undefined, cn: cn.trim() || undefined, scryfallId: undefined, back: undefined, manual: true, checked: true });
              setOpen(false);
            }}
          >
            Use it
          </Button>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );
}

/**
 * The labels of one photo: per card, what the scanner cut out, the print chosen, the scanner's
 * top 5 to pick from (or any of your prints, or a card you don't own), and its checkboxes.
 */
export function LabelsTable({ cards, matches, colorOf, prints, selected, onSelect, onChange, onDelete, onTurn, onOutline }: LabelsTableProps) {
  return (
    <Table striped highlightOnHover verticalSpacing={4} fz="xs">
      <Table.Thead>
        <Table.Tr>
          <Table.Th>#</Table.Th>
          <Table.Th>Cut out</Table.Th>
          <Table.Th>Label</Table.Th>
          <Table.Th>Scanner's top 5 (click to choose)</Table.Th>
          <Table.Th>Other print</Table.Th>
          <Table.Th>Checked</Table.Th>
          <Table.Th>Mostly hidden</Table.Th>
          <Table.Th />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {cards.map((c, i) => {
          const m = c.id ? matches?.get(c.id) : undefined;
          const id = c.id!;
          return (
            <Table.Tr key={id} bg={selected === id ? 'var(--mantine-color-blue-light)' : undefined} style={{ cursor: 'pointer' }} onClick={() => onSelect(selected === id ? null : id)}>
              <Table.Td>
                <Badge color={colorOf(c)} variant="filled" size="sm">
                  {i + 1}
                </Badge>
              </Table.Td>
              <Table.Td>
                {m?.crop ? (
                  <BitmapCanvas bitmap={m.crop} width={56} />
                ) : c.quad ? (
                  <Text size="xs" c="dimmed">
                    …
                  </Text>
                ) : (
                  <Button
                    size="compact-xs"
                    color="orange"
                    onClick={(e) => {
                      e.stopPropagation();
                      onOutline(id);
                    }}
                  >
                    Outline it
                  </Button>
                )}
              </Table.Td>
              <Table.Td>
                <Group gap={6} wrap="nowrap">
                  <CardThumb alt={c.name} small={thumb(c, 'small')} large={thumb(c, 'normal')} />
                  <Stack gap={0}>
                    <Text size="xs" fw={600}>
                      {c.name}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {c.set ? `${c.set.toUpperCase()} #${c.cn ?? '?'}` : 'no print'}
                      {c.back ? ' · back' : ''}
                      {m?.heightPx ? ` · ${Math.round(m.heightPx)} px` : ''}
                    </Text>
                    {!c.quad && !c.hidden && (
                      <Text size="xs" c="orange">
                        needs an outline
                      </Text>
                    )}
                  </Stack>
                </Group>
              </Table.Td>
              <Table.Td>
                <Group gap={4} wrap="nowrap">
                  {(m?.result?.candidates ?? []).map((p) => {
                    const chosen = p.scryfallId === c.scryfallId && !!p.back === !!c.back;
                    return (
                      <Tooltip key={`${p.scryfallId}${p.back ? '~b' : ''}`} label={`${p.name} · ${p.set.toUpperCase()} #${p.cn}${p.back ? ' · back' : ''} · ${p.score.toFixed(3)}`} withinPortal>
                        <UnstyledButton
                          onClick={(e) => {
                            e.stopPropagation();
                            onChange(id, printPatch(p));
                          }}
                          style={{ outline: chosen ? '2px solid var(--mantine-color-blue-5)' : undefined, borderRadius: 3 }}
                        >
                          <img src={thumb(p, 'small') ?? ''} alt={p.name} width={36} height={50} style={{ display: 'block', borderRadius: 3, objectFit: 'cover' }} loading="lazy" />
                        </UnstyledButton>
                      </Tooltip>
                    );
                  })}
                </Group>
                {m?.result && (
                  <Text size="xs" c="dimmed">
                    best {m.result.candidates[0]?.score.toFixed(3) ?? '—'} · margin {m.result.margin.toFixed(3)}
                  </Text>
                )}
              </Table.Td>
              <Table.Td onClick={(e) => e.stopPropagation()}>
                <Stack gap={2}>
                  <PrintPicker prints={prints} onPick={(p) => onChange(id, printPatch(p))} />
                  <OtherCard card={c} onApply={(patch) => onChange(id, patch)} />
                </Stack>
              </Table.Td>
              <Table.Td onClick={(e) => e.stopPropagation()}>
                <Checkbox size="xs" checked={!!c.checked} onChange={(e) => onChange(id, { checked: e.currentTarget.checked })} />
              </Table.Td>
              <Table.Td onClick={(e) => e.stopPropagation()}>
                <Checkbox size="xs" checked={!!c.hidden} onChange={(e) => onChange(id, { hidden: e.currentTarget.checked || undefined })} />
              </Table.Td>
              <Table.Td onClick={(e) => e.stopPropagation()}>
                <Group gap={2} wrap="nowrap">
                  {c.quad && (
                    <Tooltip label="Turn 180° (the card's top-left is the filled corner)" withinPortal>
                      <ActionIcon size="sm" variant="subtle" onClick={() => onTurn(id)} aria-label="Turn 180°">
                        <IconRotate2 size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  <Tooltip label="Delete (Del)" withinPortal>
                    <ActionIcon size="sm" variant="subtle" color="red" onClick={() => onDelete(id)} aria-label="Delete">
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}
