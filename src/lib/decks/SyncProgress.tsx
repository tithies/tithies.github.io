import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconUserExclamation } from '@tabler/icons-react';
import type { SyncState } from '@/lib/decks/types';
import type { SiteProvider } from '@/lib/sites/provider';
import type { SiteIdentity } from '@/lib/sites/types';
import { duration, timeAgo } from '@/lib/format';
import { JobProgress } from '@/lib/ui/JobProgress';

/** Average time per deck request (≈ 0.2 s answer + 1–1.5 s polite gap), for the time-left estimate. */
const MS_PER_DECK = 1400;

function runningLabel(s: SyncState, label: string): string {
  switch (s.phase) {
    case 'connecting':
      return `Connecting to ${label}…`;
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

/** The last finished (or cancelled) sync in one line: when, decks read, requests. */
export function lastSyncText(state: SyncState, siteLabel: string): string {
  const d = state.decks;
  return [
    `${state.status === 'cancelled' ? 'Sync cancelled' : 'Last sync'}${state.finishedAt ? ` ${timeAgo(state.finishedAt)}` : ''}`,
    d && `${d.fetched} deck${d.fetched === 1 ? '' : 's'} read (${d.added} added, ${d.changed} changed, ${d.removed} removed)`,
    `${state.requests} ${siteLabel} request${state.requests === 1 ? '' : 's'}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Live state of the background sync (progress, rate-limit waits, last result or error). */
export function SyncProgress({
  state,
  site,
  onSwitch,
  lastLine = true,
}: {
  state: SyncState | null | undefined;
  site: Pick<SiteProvider, 'label'>;
  /** "Switch Tithies to …" after a sync stopped because the site is logged in as someone else. */
  onSwitch?: (who: SiteIdentity) => void;
  /** Show the line about the last finished sync (false: the page shows `lastSyncText` elsewhere; decks that failed are still shown). */
  lastLine?: boolean;
}) {
  if (!state) return null;

  if (state.status === 'running') {
    const decksPhase = state.phase === 'decks' && state.total > 0;
    // The whole sync (a sync from before it was kept: the decks' own count).
    const o = state.overall;
    return (
      <Stack gap={4}>
        <Group justify="space-between" gap="xs" wrap="nowrap">
          <Text size="sm" truncate>
            {runningLabel(state, site.label)}
            {decksPhase && state.current ? <Text span c="dimmed"> — {state.current}</Text> : null}
          </Text>
          {decksPhase && state.done < state.total && (
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
              ≈ {duration((state.total - state.done) * MS_PER_DECK)} left
            </Text>
          )}
        </Group>
        <JobProgress
          size="sm"
          done={o ? o.done : decksPhase ? state.done : 0}
          total={o ? o.total : decksPhase ? state.total : 0}
          note={o ? `step ${o.step} of ${o.steps}` : undefined}
        />
        {state.message && (
          <Text size="xs" c="yellow">
            {state.message}
          </Text>
        )}
      </Stack>
    );
  }

  if (state.status === 'error' || state.status === 'interrupted') {
    if (state.code === 'wrong_account') {
      const who = state.actual;
      return (
        <Alert color="yellow" variant="light" icon={<IconUserExclamation size={18} />} title="Logged in as another account" p="xs">
          <Text size="sm">{state.error}</Text>
          {who && onSwitch && (
            <Button size="xs" variant="light" color="yellow" mt={6} onClick={() => onSwitch(who)}>
              Switch Tithies to {who.userName}
            </Button>
          )}
          <Text size="xs" c="dimmed" mt={4}>
            Nothing was read as {who ? who.userName : 'the other account'}. Decks read before this are kept: the next sync only reads what's left.
          </Text>
        </Alert>
      );
    }
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
  const showLast = lastLine || state.status === 'cancelled';
  if (!showLast && !d?.failed.length) return null;
  return (
    <Stack gap={2}>
      {showLast && (
        <Text size="xs" c="dimmed">
          {lastSyncText(state, site.label)}
        </Text>
      )}
      {d && d.failed.length > 0 && (
        <Text size="xs" c="orange">
          {d.failed.length} deck{d.failed.length === 1 ? '' : 's'} couldn't be read ({d.failed.map((f) => f.name).slice(0, 3).join(', ')}
          {d.failed.length > 3 ? '…' : ''}); they are retried on the next sync.
        </Text>
      )}
    </Stack>
  );
}
