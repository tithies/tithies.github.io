import { ActionIcon, Button, Group, Popover, Stack, Text, Tooltip } from '@mantine/core';
import { IconDownload, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { db } from '@/lib/db';
import { sendMessage, type RunAction } from '@/lib/messaging';
import { deleteRun } from '../runner';
import type { Run } from '../types';
import { downloadCsv } from './csv';

interface Props {
  run: Run;
  compact?: boolean;
  /** Rows currently shown (filtered + sorted) for "export view". */
  viewItems?: () => Promise<import('../types').Item[]> | import('../types').Item[];
}

export function RunActions({ run, compact, viewItems }: Props) {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const act = (action: RunAction) => void sendMessage('controlRun', { runId: run.id!, action });
  const active = run.status === 'running' || run.status === 'queued';
  const resumable = run.status === 'paused' || run.status === 'failed' || run.status === 'cancelled';
  const exportAll = async () => downloadCsv(run, await db.items.where('runId').equals(run.id!).toArray());

  const actions = [
    active && { key: 'pause', label: 'Pause', icon: IconPlayerPause, color: 'yellow', onClick: () => act('pause') },
    resumable && { key: 'resume', label: 'Resume', icon: IconPlayerPlay, color: 'blue', onClick: () => act('resume') },
    active && { key: 'cancel', label: 'Cancel', icon: IconPlayerStop, color: 'gray', onClick: () => act('cancel') },
    run.totals.errors > 0 && !active && { key: 'retry', label: `Retry ${run.totals.errors} errors`, icon: IconRefresh, color: 'red', onClick: () => act('retryErrors') },
    { key: 'csv', label: 'Export CSV (all)', icon: IconDownload, color: 'gray', onClick: exportAll },
    viewItems && {
      key: 'csv-view',
      label: 'Export CSV (filtered view)',
      icon: IconDownload,
      color: 'gray',
      onClick: async () => downloadCsv(run, await viewItems(), '-filtered'),
    },
  ].filter(Boolean) as { key: string; label: string; icon: typeof IconTrash; color: string; onClick: () => void }[];

  const del = (
    <Popover opened={confirm} onChange={setConfirm} withArrow position="bottom-end">
      <Popover.Target>
        {compact ? (
          <Tooltip label="Delete run">
            <ActionIcon variant="subtle" color="red" onClick={() => setConfirm((o) => !o)} aria-label="Delete run">
              <IconTrash size={16} />
            </ActionIcon>
          </Tooltip>
        ) : (
          <Button variant="light" color="red" size="xs" leftSection={<IconTrash size={14} />} onClick={() => setConfirm((o) => !o)}>
            Delete
          </Button>
        )}
      </Popover.Target>
      <Popover.Dropdown>
        <Stack gap="xs">
          <Text size="sm">Delete this run and all its results?</Text>
          <Group justify="flex-end" gap="xs">
            <Button size="xs" variant="default" onClick={() => setConfirm(false)}>
              Keep
            </Button>
            <Button
              size="xs"
              color="red"
              onClick={async () => {
                if (active) await sendMessage('controlRun', { runId: run.id!, action: 'cancel' });
                await deleteRun(run.id!);
                setConfirm(false);
                navigate('/f2f/runs');
              }}
            >
              Delete
            </Button>
          </Group>
        </Stack>
      </Popover.Dropdown>
    </Popover>
  );

  if (compact) {
    return (
      <Group gap={2} justify="flex-end" wrap="nowrap">
        {actions.map((a) => (
          <Tooltip key={a.key} label={a.label}>
            <ActionIcon variant="subtle" color={a.color} onClick={a.onClick} aria-label={a.label}>
              <a.icon size={16} />
            </ActionIcon>
          </Tooltip>
        ))}
        {del}
      </Group>
    );
  }
  return (
    <Group gap="xs">
      {actions.map((a) => (
        <Button key={a.key} size="xs" variant="light" color={a.color} leftSection={<a.icon size={14} />} onClick={a.onClick}>
          {a.label}
        </Button>
      ))}
      {del}
    </Group>
  );
}
