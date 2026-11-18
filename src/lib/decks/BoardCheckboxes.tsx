/** The "Deck boards counted" checkboxes, shared by the pages that compare decks with the collection. */
import { Checkbox, Group, Stack, Text } from '@mantine/core';
import type { SiteProvider } from '@/lib/sites/provider';
import type { DeckCardsRow } from './types';

/** Boards always offered, even before any deck uses them. */
export const BASE_BOARDS = ['commanders', 'mainboard', 'sideboard', 'maybeboard'];

/** Copies per board across every cached deck (to list only boards that exist). */
export function boardCopies(deckCards: readonly DeckCardsRow[]): Map<string, number> {
  const m = new Map<string, number>(BASE_BOARDS.map((b) => [b, 0]));
  for (const row of deckCards) for (const c of row.cards) m.set(c.board, (m.get(c.board) ?? 0) + c.qty);
  return m;
}

export function BoardCheckboxes({
  boards,
  ignoredBoards,
  onChange,
  site,
  label = 'Deck boards counted',
}: {
  /** Copies per board (`boardCopies`). */
  boards: Map<string, number>;
  ignoredBoards: readonly string[];
  onChange(ignoredBoards: string[]): void;
  site: Pick<SiteProvider, 'boardLabel' | 'boardOrder'>;
  label?: string;
}) {
  const ignored = new Set(ignoredBoards);
  const keys = [...boards.keys()].filter((b) => BASE_BOARDS.includes(b) || (boards.get(b) ?? 0) > 0).sort((a, b) => site.boardOrder(a) - site.boardOrder(b));
  const toggle = (b: string, count: boolean) => onChange(count ? ignoredBoards.filter((x) => x !== b) : [...ignored, b]);
  return (
    <Stack gap={6}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {label}
      </Text>
      <Group gap="md">
        {keys.map((b) => (
          <Checkbox
            key={b}
            size="sm"
            label={
              <>
                {site.boardLabel(b)}{' '}
                <Text span size="xs" c="dimmed" className="ti-num">
                  {boards.get(b) ?? 0}
                </Text>
              </>
            }
            checked={!ignored.has(b)}
            onChange={(e) => toggle(b, e.currentTarget.checked)}
          />
        ))}
      </Group>
    </Stack>
  );
}
