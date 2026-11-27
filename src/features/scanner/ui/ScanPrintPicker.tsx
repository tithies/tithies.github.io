import { Badge, Button, Group, Image, Modal, SimpleGrid, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core';
import { useMemo, useState } from 'react';
import { scryfallImage } from '@/lib/f2f/links';
import type { IndexPrint } from '../index-file';
import { sameName } from '../labels';
import type { CardMatch } from '../pipeline';
import { chosenPrint, sameArtPrints } from '../scan-export';
import type { StoredCard } from '../scan-session';
import { PrintPicker } from './PrintPicker';

const keyOf = (p: { scryfallId: string; back?: boolean }) => `${p.scryfallId}${p.back ? '~back' : ''}`;
/** Other prints shown before "Show all". */
const FIRST = 24;

function Thumb({ p, current, onPick }: { p: CardMatch; current: boolean; onPick: () => void }) {
  return (
    <Tooltip label={`${p.setName} · #${p.cn}${p.lang && p.lang !== 'en' ? ` · ${p.lang.toUpperCase()}` : ''}`} withinPortal>
      <UnstyledButton onClick={onPick} style={{ borderRadius: 6, outline: current ? '3px solid var(--mantine-color-blue-5)' : undefined }}>
        <Stack gap={2} align="center">
          <Image src={scryfallImage(p.scryfallId, 'small', p.back ? 'back' : 'front')} w={110} radius={5} alt={p.name} loading="lazy" />
          <Text size="xs" fw={current ? 700 : 400}>
            {p.set.toUpperCase()} #{p.cn}
          </Text>
        </Stack>
      </UnstyledButton>
    </Tooltip>
  );
}

/**
 * The print of one scanned card: the prints with its artwork first (those the check decides between), then every
 * other print of that card, then any other card of the index by name.
 */
export function ScanPrintPicker({ card, prints, onPick, onClose }: { card: StoredCard; prints: readonly IndexPrint[]; onPick: (p: CardMatch) => void; onClose: () => void }) {
  const current = chosenPrint(card);
  const [all, setAll] = useState(false);
  const { sameArt, others } = useMemo(() => {
    const hits = card.result.more ?? card.result.candidates;
    const sameArt = sameArtPrints(card).map((i) => hits[i]);
    const seen = new Set(sameArt.map(keyOf));
    const name = current?.name ?? card.result.candidates[0]?.name ?? '';
    const others = prints
      .filter((p) => sameName(name, p.name) && !seen.has(keyOf(p)))
      .sort((a, b) => a.setName.localeCompare(b.setName) || a.cn.localeCompare(b.cn, undefined, { numeric: true }))
      .map((p): CardMatch => ({ ...p, score: 0 }));
    return { sameArt, others };
  }, [card, prints, current?.name]);
  const isCurrent = (p: CardMatch) => !!current && keyOf(p) === keyOf(current);
  const pick = (p: CardMatch) => {
    onPick(p);
    onClose();
  };
  const shown = all ? others : others.slice(0, FIRST);

  return (
    <Modal opened onClose={onClose} title={`The print of ${current?.name ?? 'this card'}`} size="xl">
      <Stack>
        {sameArt.length > 1 && (
          <Stack gap="xs">
            <Group gap="xs">
              <Text fw={600} size="sm">
                Same artwork
              </Text>
              <Badge size="xs" variant="light">
                {sameArt.length} prints
              </Badge>
            </Group>
            <Text size="xs" c="dimmed">
              They differ only by the set symbol, the collector line at the bottom left, and stamps (promo, The List).
            </Text>
            <SimpleGrid cols={{ base: 3, sm: 5, md: 6 }}>
              {sameArt.map((p) => (
                <Thumb key={keyOf(p)} p={p} current={isCurrent(p)} onPick={() => pick(p)} />
              ))}
            </SimpleGrid>
          </Stack>
        )}
        {others.length > 0 && (
          <Stack gap="xs">
            <Text fw={600} size="sm">
              {sameArt.length > 1 ? 'Other prints of this card' : 'Prints of this card'} ({others.length})
            </Text>
            <SimpleGrid cols={{ base: 3, sm: 5, md: 6 }}>
              {shown.map((p) => (
                <Thumb key={keyOf(p)} p={p} current={isCurrent(p)} onPick={() => pick(p)} />
              ))}
            </SimpleGrid>
            {!all && others.length > FIRST && (
              <Button size="xs" variant="subtle" onClick={() => setAll(true)} style={{ alignSelf: 'flex-start' }}>
                Show all {others.length}
              </Button>
            )}
          </Stack>
        )}
        <Stack gap="xs">
          <Text fw={600} size="sm">
            Another card
          </Text>
          <PrintPicker prints={prints} placeholder="Search a card by name…" nothingFound="No such card" w={360} onPick={(p) => pick({ ...p, score: 0 })} />
        </Stack>
      </Stack>
    </Modal>
  );
}
