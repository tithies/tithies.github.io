import { Accordion, Alert, Anchor, Badge, Button, Group, Loader, Modal, Stack, Text, UnstyledButton } from '@mantine/core';
import { useEffect, useState } from 'react';
import { IconAlertTriangle, IconUpload } from '@tabler/icons-react';
import { Link } from 'react-router';
import { StatusBadge } from '@/lib/changes/ui/StatusBadge';
import type { ChangeOp } from '@/lib/changes/types';
import { timeAgo } from '@/lib/format';
import type { SiteProvider } from '@/lib/sites/provider';
import { siteOf } from '@/lib/sites/registry';
import { JobProgress } from '@/lib/ui/JobProgress';
import { cancelExport, useChangeOp, useChangeOps } from '../client';
import type { ReadProgress } from '../types';
import { ExportOpDetails } from './ExportOpDetails';

const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;

/** A read's progress (the preview's), as every job shows it: its percent, and the pages read. */
export function PercentBar({ progress, unit }: { progress: ReadProgress; unit: 'page' | 'change' }) {
  const note = unit === 'page' ? `page ${n(progress.done)} of ${n(progress.total)}` : `${n(progress.done)} of ${plural(progress.total, 'change')}`;
  return <JobProgress size="lg" done={progress.done} total={progress.total} note={note} />;
}

/** What the running step has done: "page 12 of 41", "3 of 10 changes". */
const stepCount = (p: NonNullable<ChangeOp['progress']>) =>
  p.unit === 'page' ? `page ${n(p.done)} of ${n(p.total)}` : `${n(p.done)} of ${plural(p.total, 'change')}`;

/**
 * An export, live: waiting for its turn (with Cancel), its progress while it runs (with Cancel),
 * then what it did and the check of the result. `inList`: shown under its title and status
 * (ExportBatchProgress), so without them.
 */
export function ExportProgress({ opId, site, inList }: { opId: number; site: SiteProvider; inList?: boolean }) {
  const op = useChangeOp(opId);
  if (op === undefined) return <Loader size="sm" />;
  if (op === null) return <Text size="sm">This export isn't in the Change log any more.</Text>;
  const running = op.status === 'running';
  const waiting = op.status === 'queued';
  const p = op.progress;
  const link = (
    <Anchor component={Link} to={`/changes?op=${opId}`} size="sm">
      Open the Change log
    </Anchor>
  );
  return (
    <Stack>
      {inList ? (
        <Group justify="flex-end">{link}</Group>
      ) : (
        <>
          <Group justify="space-between">
            <StatusBadge op={op} />
            {link}
          </Group>
          <Text size="sm" fw={600}>
            {op.title}
          </Text>
        </>
      )}
      {waiting && (
        <Group justify="space-between" wrap="nowrap" align="flex-start">
          <Text size="sm" c="dimmed">
            Waiting: it starts when the export before it has finished. Nothing has been changed for it on {site.label} yet. You can close this window: the exports go
            on.
          </Text>
          <Button size="xs" variant="default" onClick={() => void cancelExport(site.type, [opId])} style={{ flexShrink: 0 }}>
            Cancel this one
          </Button>
        </Group>
      )}
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
            <JobProgress size="lg" done={op.overall.done} total={op.overall.total} note={`step ${op.overall.step} of ${op.overall.steps}`} />
          ) : (
            // Exports from before the overall progress: the step's own.
            <JobProgress size="lg" done={p?.done ?? 0} total={p?.total ?? 0} />
          )}
          <Text size="xs" c="dimmed">
            The bar counts every step: reading, sending the changes, then checking every copy (how many pages the reads take is only known as they go).{' '}
            {plural(op.calls, 'change')} sent so far. You can close this window: the export goes on. Open it again with “Running” at the top of the page, or
            from the export bar of the Comparator.
          </Text>
          <Group>
            <Button size="xs" variant="default" onClick={() => void cancelExport(site.type, [opId])}>
              Cancel
            </Button>
            <Text size="xs" c="dimmed">
              Cancelling stops before the next change; what {site.label} already made stays. Exports waiting after this one still run.
            </Text>
          </Group>
        </Stack>
      )}
      {op.error && (
        <Alert color={op.status === 'cancelled' ? 'gray' : 'red'} variant="light" icon={<IconAlertTriangle size={18} />}>
          {op.error}
        </Alert>
      )}
      {!running && !waiting && <ExportOpDetails op={op} />}
    </Stack>
  );
}

/** Exports started together, live, in the order they run: each with its status, the running one open; Cancel all. */
export function ExportBatchProgress({ opIds, site }: { opIds: number[]; site: SiteProvider }) {
  const ops = useChangeOps(opIds);
  const [open, setOpen] = useState<string[]>([]);
  const runningId = ops?.find((o) => o.status === 'running')?.id;
  // The running export opens as its turn comes (the others stay as the user left them).
  useEffect(() => {
    if (runningId != null) setOpen((v) => (v.includes(String(runningId)) ? v : [...v, String(runningId)]));
  }, [runningId]);
  if (!ops) return <Loader size="sm" />;
  const active = ops.filter((o) => o.status === 'running' || o.status === 'queued');
  const count = (status: ChangeOp['status']) => ops.filter((o) => o.status === status).length;
  const parts = [
    [count('done'), 'done'],
    [count('running'), 'running'],
    [count('queued'), 'waiting'],
    [count('failed') + count('interrupted'), 'failed'],
    [count('cancelled'), 'cancelled'],
  ].filter(([c]) => c) as [number, string][];
  return (
    <Stack>
      <Group justify="space-between">
        <Text size="sm">
          {plural(ops.length, 'export')}, one after another: {parts.map(([c, what]) => `${n(c)} ${what}`).join(', ')}.
        </Text>
        {active.length > 0 && (
          <Button size="xs" variant="default" onClick={() => void cancelExport(site.type, active.map((o) => o.id!))}>
            Cancel all
          </Button>
        )}
      </Group>
      <Accordion multiple value={open} onChange={setOpen} variant="separated">
        {ops.map((o, i) => (
          <Accordion.Item key={o.id} value={String(o.id)}>
            <Accordion.Control>
              <Group justify="space-between" wrap="nowrap" pr="xs">
                <Text size="sm" fw={600} lineClamp={2}>
                  {i + 1}. {o.title}
                </Text>
                <StatusBadge op={o} />
              </Group>
              {o.status === 'running' && <JobProgress size="xs" done={(o.overall ?? o.progress)?.done ?? 0} total={(o.overall ?? o.progress)?.total ?? 0} />}
            </Accordion.Control>
            <Accordion.Panel>
              <ExportProgress opId={o.id!} site={site} inList />
            </Accordion.Panel>
          </Accordion.Item>
        ))}
      </Accordion>
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
                  {o.status === 'queued' ? 'Waiting for the export before it' : `Started ${timeAgo(o.startedAt)}`}
                  {o.status === 'running' && o.phase ? ` · ${o.phase}` : ''}
                </Text>
                {o.status === 'running' && <JobProgress size="xs" done={(o.overall ?? p)?.done ?? 0} total={(o.overall ?? p)?.total ?? 0} />}
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
