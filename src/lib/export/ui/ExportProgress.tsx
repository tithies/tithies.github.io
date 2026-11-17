import { Alert, Anchor, Badge, Button, Group, Loader, Modal, Progress, Stack, Text, UnstyledButton } from '@mantine/core';
import { IconAlertTriangle, IconUpload } from '@tabler/icons-react';
import { Link } from 'react-router';
import { StatusBadge } from '@/lib/changes/ui/StatusBadge';
import { overallPercent } from '@/lib/changes/progress';
import type { ChangeOp, OverallProgress } from '@/lib/changes/types';
import { timeAgo } from '@/lib/format';
import type { SiteProvider } from '@/lib/sites/provider';
import { siteOf } from '@/lib/sites/registry';
import { cancelExport, useChangeOp } from '../client';
import type { ReadProgress } from '../types';
import { ExportOpDetails } from './ExportOpDetails';

const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const percent = (p: ReadProgress) => (p.total > 0 ? Math.min(100, Math.round((100 * p.done) / p.total)) : 0);

/** A bar with its percentage, and what is counted ("page 12 of 41"). */
export function PercentBar({ progress, unit }: { progress: ReadProgress; unit: 'page' | 'change' }) {
  const pct = percent(progress);
  return (
    <Group gap="sm" wrap="nowrap">
      <Progress.Root size="lg" style={{ flex: 1 }}>
        <Progress.Section value={pct} animated={pct < 100}>
          <Progress.Label>{pct}%</Progress.Label>
        </Progress.Section>
      </Progress.Root>
      <Text size="xs" c="dimmed" className="ti-num" style={{ whiteSpace: 'nowrap' }}>
        {unit === 'page' ? `page ${n(progress.done)} of ${n(progress.total)}` : `${n(progress.done)} of ${plural(progress.total, 'change')}`}
      </Text>
    </Group>
  );
}

/** The whole export in one bar (every step counted), and which step runs. */
function OverallBar({ overall }: { overall: OverallProgress }) {
  const pct = overallPercent(overall);
  return (
    <Group gap="sm" wrap="nowrap">
      <Progress.Root size="lg" style={{ flex: 1 }}>
        <Progress.Section value={pct} animated>
          <Progress.Label>{pct}%</Progress.Label>
        </Progress.Section>
      </Progress.Root>
      <Text size="xs" c="dimmed" className="ti-num" style={{ whiteSpace: 'nowrap' }}>
        step {overall.step} of {overall.steps}
      </Text>
    </Group>
  );
}

/** What the running step has done: "page 12 of 41", "3 of 10 changes". */
const stepCount = (p: NonNullable<ChangeOp['progress']>) =>
  p.unit === 'page' ? `page ${n(p.done)} of ${n(p.total)}` : `${n(p.done)} of ${plural(p.total, 'change')}`;

/** An export, live: its progress while it runs (with Cancel), then what it did and the check of the result. */
export function ExportProgress({ opId, site }: { opId: number; site: SiteProvider }) {
  const op = useChangeOp(opId);
  if (op === undefined) return <Loader size="sm" />;
  if (op === null) return <Text size="sm">This export isn't in the Change log any more.</Text>;
  const running = op.status === 'running';
  const p = op.progress;
  return (
    <Stack>
      <Group justify="space-between">
        <StatusBadge op={op} />
        <Anchor component={Link} to={`/changes?op=${opId}`} size="sm">
          Open the Change log
        </Anchor>
      </Group>
      <Text size="sm" fw={600}>
        {op.title}
      </Text>
      {running && (
        <Stack gap={6}>
          <Text size="sm">
            {op.phase ?? 'Working…'}
            {p && p.total > 0 && (
              <Text span size="xs" c="dimmed" className="ti-num">
                {' '}
                · {stepCount(p)}
              </Text>
            )}
          </Text>
          {op.overall ? (
            <OverallBar overall={op.overall} />
          ) : p && p.total > 0 ? (
            <PercentBar progress={p} unit={p.unit ?? 'change'} />
          ) : (
            <Progress value={100} animated striped />
          )}
          <Text size="xs" c="dimmed">
            The bar counts every step: reading, sending the changes, then checking every copy (how many pages the reads take is only known as they go).{' '}
            {plural(op.calls, 'change')} sent so far. You can close this window: the export goes on. Open it again with “Running” at the top of the page, or
            from the export bar of the Comparator.
          </Text>
          <Group>
            <Button size="xs" variant="default" onClick={() => void cancelExport(site.type)}>
              Cancel
            </Button>
            <Text size="xs" c="dimmed">
              Cancelling stops before the next change; what {site.label} already made stays.
            </Text>
          </Group>
        </Stack>
      )}
      {op.error && (
        <Alert color={op.status === 'cancelled' ? 'gray' : 'red'} variant="light" icon={<IconAlertTriangle size={18} />}>
          {op.error}
        </Alert>
      )}
      {!running && <ExportOpDetails op={op} />}
    </Stack>
  );
}

/** One export in its own window, to see it again after its dialog was closed. */
export function ExportProgressModal({ opId, onClose }: { opId: number | null; onClose: () => void }) {
  const op = useChangeOp(opId);
  const site = op ? siteOf(op.site) : null;
  return (
    <Modal
      opened={opId != null}
      onClose={onClose}
      size="xl"
      title={
        <Group gap="xs">
          <IconUpload size={18} />
          <Text fw={600}>{site ? `Export to ${site.label}` : 'Export'}</Text>
        </Group>
      }
    >
      <Stack>
        {opId != null && (site ? <ExportProgress opId={opId} site={site} /> : op === null ? <Text size="sm">This export isn't in the Change log any more.</Text> : <Loader size="sm" />)}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

/** The latest exports of a page (running first), to pick the one to open. */
export function RecentExportsModal({ opened, ops, onPick, onClose }: { opened: boolean; ops: ChangeOp[]; onPick: (opId: number) => void; onClose: () => void }) {
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <IconUpload size={18} />
          <Text fw={600}>Exports</Text>
          <Badge variant="light">{ops.length}</Badge>
        </Group>
      }
    >
      <Stack gap="sm">
        {ops.map((o) => {
          const p = o.progress;
          return (
            <UnstyledButton key={o.id} onClick={() => onPick(o.id!)} p="xs" className="ti-pick-row" style={{ borderRadius: 'var(--mantine-radius-sm)' }}>
              <Stack gap={4}>
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Text size="sm" fw={600} lineClamp={2}>
                    {o.title}
                  </Text>
                  <StatusBadge op={o} />
                </Group>
                <Text size="xs" c="dimmed">
                  Started {timeAgo(o.startedAt)}
                  {o.status === 'running' && o.phase ? ` · ${o.phase}` : ''}
                </Text>
                {o.status === 'running' &&
                  (o.overall ? (
                    <Progress value={overallPercent(o.overall)} size="xs" />
                  ) : p && p.total > 0 ? (
                    <Progress value={percent(p)} size="xs" />
                  ) : (
                    <Progress value={100} size="xs" animated striped />
                  ))}
              </Stack>
            </UnstyledButton>
          );
        })}
        <Text size="xs" c="dimmed">
          The {ops.length} latest exports made from this page. Every export is in the{' '}
          <Anchor component={Link} to="/changes" size="xs" onClick={onClose}>
            Change log
          </Anchor>
          .
        </Text>
      </Stack>
    </Modal>
  );
}
