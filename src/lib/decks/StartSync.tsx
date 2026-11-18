/** Starting a sync from a page: the start's own errors (a sync of another account running, no tab…). */
import { Alert, Button, Group, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import { useState } from 'react';
import type { AccountKey } from '@/lib/accounts/types';
import type { SiteType } from '@/lib/sites/types';
import { cancelSync, startSync } from './hooks';
import type { StartSyncResult } from './job';

export interface StartSyncError {
  message: string;
  /** Another account's sync is running (it can be cancelled). */
  busy: boolean;
}

/** Runs a start (`run`), keeping whether it is under way and why it failed. */
export function useSyncStarter() {
  const [error, setError] = useState<StartSyncError | null>(null);
  const [starting, setStarting] = useState(false);
  const run = async (start: () => Promise<StartSyncResult>): Promise<StartSyncResult | null> => {
    setError(null);
    setStarting(true);
    try {
      const res = await start();
      if (!res.ok && res.code !== 'cancelled') setError({ message: res.error, busy: res.code === 'busy' });
      return res;
    } catch (e) {
      setError({ message: `Couldn't start the sync: ${e instanceof Error ? e.message : String(e)}`, busy: false });
      return null;
    } finally {
      setStarting(false);
    }
  };
  return { run, error, starting, clearError: () => setError(null) };
}

/**
 * Starts (or joins) the sync of an account. Without an account, syncs whoever is logged in on the
 * site: that account is added and becomes current (the page then shows it).
 */
export function useStartSync(type: SiteType, key: AccountKey | null) {
  const { run, ...rest } = useSyncStarter();
  const start = (collection: boolean, fullCollection = false) => run(() => startSync(type, key, collection, fullCollection));
  return { start, ...rest };
}

/** Why a sync couldn't start; when another account's sync is running, offer to cancel it. */
export function StartError({ error, type, onCancelled }: { error: StartSyncError; type: SiteType; onCancelled: () => void }) {
  return (
    <Alert color={error.busy ? 'yellow' : 'red'} icon={<IconAlertTriangle size={18} />}>
      <Group justify="space-between" gap="xs">
        <Text size="sm">{error.message}</Text>
        {error.busy && (
          <Button size="xs" variant="light" color="yellow" onClick={() => void cancelSync(type).then(onCancelled)}>
            Cancel the other sync
          </Button>
        )}
      </Group>
    </Alert>
  );
}
