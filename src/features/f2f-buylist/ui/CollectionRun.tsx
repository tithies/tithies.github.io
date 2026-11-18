/** Selling checks of an account's whole collection, started from the dashboard (the collection is read in the background first). */
import { Alert, Button, Group, Stack, Text } from '@mantine/core';
import { IconAlertTriangle, IconCards } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { useSyncState } from '@/lib/decks/hooks';
import { sendMessage } from '@/lib/messaging';
import { siteOf } from '@/lib/sites/registry';
import type { SiteIdentity } from '@/lib/sites/types';
import { JobProgress } from '@/lib/ui/JobProgress';
import { useInitialSync } from '@/lib/ui/InitialSync';
import { parseAccountKey, type AccountKey } from '@/lib/accounts/types';
import type { Run } from '../types';

interface StartError {
  message: string;
  /** The site is logged in as someone else: offer to switch Tithies to them. */
  actual?: SiteIdentity | null;
}

/** "Check whole collection": reads the current account's collection (whoever is logged in, with no account yet), then checks it on F2F. */
export function CheckCollectionButton({ waiting, size = 'xs' }: { waiting: boolean; size?: 'xs' | 'sm' }) {
  const { key, account } = useCurrentAccount();
  const site = siteOf(account?.type ?? 'moxfield');
  const navigate = useNavigate();
  const { switchToIdentity } = useInitialSync();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<StartError | null>(null);

  const start = async () => {
    setError(null);
    setStarting(true);
    try {
      const res = await sendMessage('startCollectionRun', { type: site.type, accountKey: key });
      if (res.ok) navigate(`/f2f/runs/${res.runId}`);
      else setError({ message: res.error, actual: res.code === 'wrong_account' ? res.actual : undefined });
    } catch (e) {
      setError({ message: `Couldn't start the check: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setStarting(false);
    }
  };

  return (
    <Stack gap="xs" align="flex-end">
      <Button
        size={size}
        leftSection={<IconCards size={14} />}
        loading={starting}
        disabled={waiting}
        title={waiting ? 'A check of the whole collection is already reading it' : `Reads your whole ${site.label} collection, then checks every paper, non-proxy card on F2F`}
        onClick={() => void start()}
      >
        Check whole collection
      </Button>
      {error && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} p="xs" maw={520}>
          <Text size="sm">{error.message}</Text>
          {error.actual && (
            <Button size="xs" variant="light" color="yellow" mt={6} onClick={() => switchToIdentity(site.type, error.actual!)}>
              Switch Tithies to {error.actual.userName}
            </Button>
          )}
        </Alert>
      )}
    </Stack>
  );
}

/** What a whole-collection run's read is doing ("Reading your collection, page 3 of 41"), while it waits for it. */
export function CollectionReadProgress({ run, size = 'sm' }: { run: Run; size?: 'sm' | 'lg' }) {
  const state = useSyncState(run.accountKey as AccountKey);
  const site = siteOf(parseAccountKey(run.accountKey)?.type ?? 'moxfield');
  const mine = state && state.jobId === run.collectionJobId && state.status === 'running' ? state : null;
  const o = mine?.overall;
  const label = !mine
    ? `Waiting for the ${site.label} collection…`
    : mine.phase === 'collection'
      ? mine.total > 1
        ? `Reading your ${site.label} collection (page ${mine.done} of ${mine.total})`
        : `Reading your ${site.label} collection…`
      : mine.phase === 'connecting'
        ? `Connecting to ${site.label}…`
        : 'Syncing decks first (a Compare joined the read)…';
  return (
    <Stack gap={4}>
      {size === 'lg' && (
        <Group justify="space-between" gap="xs">
          <Text size="sm">Step 1 of 2 · {label}</Text>
          <Text size="xs" c="dimmed">
            Then every paper, non-proxy card is checked on F2F
          </Text>
        </Group>
      )}
      <JobProgress size={size} done={o?.done ?? 0} total={o?.total ?? 0} note={size === 'lg' ? undefined : label} color="blue" />
      {mine?.message && (
        <Text size="xs" c="yellow">
          {mine.message}
        </Text>
      )}
    </Stack>
  );
}
