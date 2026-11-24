import { Badge, Group, Tooltip } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ChangeOp, ChangeOpStatus } from '../types';

const STATUS: Record<ChangeOpStatus, { label: string; color: string }> = {
  queued: { label: 'Waiting', color: 'gray' },
  running: { label: 'Running', color: 'blue' },
  done: { label: 'Done', color: 'teal' },
  failed: { label: 'Failed', color: 'red' },
  cancelled: { label: 'Cancelled', color: 'gray' },
  interrupted: { label: 'Interrupted', color: 'orange' },
};

/** An action's status, plus how many of its changes have an unknown outcome. */
export function StatusBadge({ op }: { op: ChangeOp }) {
  const s = STATUS[op.status];
  return (
    <Group gap={4} wrap="nowrap">
      <Badge color={s.color} variant="light">
        {s.label}
      </Badge>
      {op.unknownCalls > 0 && (
        <Tooltip label="Some changes may or may not have been made: see the requests below" multiline w={240}>
          <Badge color="orange" variant="outline" leftSection={<IconAlertTriangle size={12} />}>
            {op.unknownCalls} unknown
          </Badge>
        </Tooltip>
      )}
    </Group>
  );
}

