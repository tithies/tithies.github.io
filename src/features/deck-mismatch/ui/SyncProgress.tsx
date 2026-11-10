import { Alert, Group, Progress, Stack, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { MoxSyncState } from '@/lib/decks/types';
import { duration, timeAgo } from '@/lib/format';

/** Average time per deck request (≈ 0.2 s answer + 1–1.5 s polite gap), for the time-left estimate. */
const MS_PER_DECK = 1400;

function runningLabel(s: MoxSyncState): string {
  switch (s.phase) {
    case 'connecting':
      return 'Connecting to Moxfield…';
    case 'deckList':
      return 'Reading your deck list…';
    case 'decks':
      return s.total ? `Reading decks ${s.done}/${s.total}` : 'Decks are up to date';
    case 'collection':
      return s.total > 1 ? `Reading your collection (page ${s.done}/${s.total})…` : 'Reading your collection…';
    default:
      return 'Finishing…';
  }
}

/** Live state of the background Moxfield sync (progress, rate-limit waits, last result or error). */
export function SyncProgress({ state }: { state: MoxSyncState | null | undefined }) {
  if (!state) return null;

  if (state.status === 'running') {
    const decksPhase = state.phase === 'decks' && state.total > 0;
    const pct = decksPhase ? (state.done / state.total) * 100 : 100;
    return (
      <Stack gap={4}>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text size="sm" truncate>
            {runningLabel(state)}
            {decksPhase && state.current ? <Text span c="dimmed"> — {state.current}</Text> : null}
          </Text>
          {decksPhase && state.done < state.total && (
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              ≈ {duration((state.total - state.done) * MS_PER_DECK)} left
            </Text>
          )}
        </Group>
        <Progress value={pct} animated={!decksPhase || state.done < state.total} striped={!decksPhase} size="sm" />
        {state.message && (
          <Text size="xs" c="yellow">
            {state.message}
          </Text>
        )}
      </Stack>
    );
  }

  if (state.status === 'error' || state.status === 'interrupted') {
    return (
      <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} title={state.status === 'interrupted' ? 'Sync interrupted' : 'Sync failed'} p="xs">
        <Text size="sm">{state.error}</Text>
        <Text size="xs" c="dimmed">
          Decks read before this are kept: the next sync only reads what's left.
        </Text>
      </Alert>
    );
  }

  const d = state.decks;
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed">
        {state.status === 'cancelled' ? 'Sync cancelled' : 'Last sync'} {state.finishedAt ? timeAgo(state.finishedAt) : ''}
        {d ? ` · ${d.fetched} deck${d.fetched === 1 ? '' : 's'} read (${d.added} added, ${d.changed} changed, ${d.removed} removed)` : ''} · {state.requests} Moxfield request
        {state.requests === 1 ? '' : 's'}
      </Text>
      {d && d.failed.length > 0 && (
        <Text size="xs" c="orange">
          {d.failed.length} deck{d.failed.length === 1 ? '' : 's'} couldn't be read ({d.failed.map((f) => f.name).slice(0, 3).join(', ')}
          {d.failed.length > 3 ? '…' : ''}); they are retried on the next sync.
        </Text>
      )}
    </Stack>
  );
}
