import { Group, Progress, Text, type MantineColor } from '@mantine/core';
import type { ReactNode } from 'react';
import { overallPercent } from '@/lib/progress';

interface JobProgressProps {
  /** What the whole job has done, of `total` (requests, prints…). Unknown total (0): a bar without a percent. */
  done: number;
  total: number;
  /** The job is over: 100%. */
  over?: boolean;
  /** What runs: "step 2 of 3", "page 12 of 41"… */
  note?: ReactNode;
  /** lg: the percent inside the bar (a job's own window or page); sm, xs: after it (lists). */
  size?: 'lg' | 'sm' | 'xs';
  color?: MantineColor;
  /** Moving stripes, while it runs (not paused, failed…). */
  active?: boolean;
}

/**
 * A background job's progress, the same everywhere (exports, Selling checks, syncs): one bar for
 * the whole job, its percent (whole numbers, 99 at most until it is over) and what runs.
 */
export function JobProgress({ done, total, over = false, note, size = 'sm', color, active = true }: JobProgressProps) {
  const known = total > 0;
  const pct = known ? overallPercent({ done, total }, over) : 0;
  const text = [size !== 'lg' && known ? `${pct}%` : null, note].filter(Boolean);
  return (
    <Group gap="sm" wrap="nowrap">
      {size === 'lg' ? (
        <Progress.Root size="lg" style={{ flex: 1 }}>
          <Progress.Section value={known ? pct : 100} color={color} animated={active} striped={!known}>
            {known && <Progress.Label>{pct}%</Progress.Label>}
          </Progress.Section>
        </Progress.Root>
      ) : (
        <Progress value={known ? pct : 100} size={size} color={color} animated={active} striped={!known} style={{ flex: 1 }} />
      )}
      {text.length > 0 && (
        <Text size="xs" c="dimmed" className="ti-num" style={{ whiteSpace: 'nowrap' }}>
          {text.map((t, i) => (
            <span key={i}>
              {i > 0 && ' · '}
              {t}
            </span>
          ))}
        </Text>
      )}
    </Group>
  );
}
