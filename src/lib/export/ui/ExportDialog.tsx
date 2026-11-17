import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Group,
  List,
  Loader,
  Modal,
  Progress,
  Radio,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Stepper,
  Table,
  Tabs,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAlertTriangle, IconEye, IconInfoCircle, IconRefresh, IconUpload } from '@tabler/icons-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { accountLabel, type AccountKey, type AccountRow } from '@/lib/accounts/types';
import { StatusBadge } from '@/lib/changes/ui/StatusBadge';
import { finishLabel } from '@/lib/format';
import type { SiteProvider } from '@/lib/sites/provider';
import type { BinderVisibility } from '@/lib/sites/types';
import { useSiteSessions } from '@/lib/sites/useSiteSessions';
import { SiteIcon } from '@/lib/ui/SiteIcon';
import { Stat } from '@/lib/ui/Stat';
import { FULL_READ_EVERY_MS } from '@/lib/decks/collection';
import { useCollectionMeta } from '@/lib/decks/hooks';
import { cancelExport, readExportTarget, startExport, useChangeOp, useReadProgress } from '../client';
import { exporterOf } from '../exporters';
import type { ReadTargetResult } from '../job';
import { planExport, previewRead, stateCovers } from '../plan';
import type { ExportItem, ExportMode, ExportPlan, ExportTarget, ReadProgress, TargetRead, TargetState } from '../types';
import { ExportOpDetails } from './ExportOpDetails';

const n = (v: number) => v.toLocaleString('en-CA');
const plural = (v: number, one: string, many = `${one}s`) => `${n(v)} ${v === 1 ? one : many}`;
const today = () => new Date().toISOString().slice(0, 10);
const percent = (p: ReadProgress) => (p.total > 0 ? Math.min(100, Math.round((100 * p.done) / p.total)) : 0);

type Kind = ExportTarget['kind'];

export interface ExportDialogProps {
  opened: boolean;
  onClose: () => void;
  site: SiteProvider;
  items: ExportItem[];
  /** The account the cards come from (its page): another account is offered first. */
  sourceAccountKey: AccountKey | null;
  /** For the change log: "Comparator of alice". */
  source: string;
  /**
   * Called once the export has started: the cards are handed over to it, so the page clears its
   * list (to try again after a failure, pick the cards again; the Change log keeps what was sent).
   */
  onStarted?: () => void;
}

/** About how long the requests take at the site's pace. */
function estimate(site: SiteProvider, requests: number): string {
  const s = Math.round((requests * (site.pacing.intervalMs + site.pacing.jitterMs / 2)) / 1000);
  return s < 60 ? `about ${Math.max(5, s)} seconds` : `about ${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? '' : 's'}`;
}

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

/** "the binder's cards" / "the collection" */
const readLabel = (r: TargetRead, name: string) =>
  r.kind === 'binder' ? "the binder's cards" : r.kind === 'collection' ? `${name}'s whole collection` : r.kind === 'totals' ? `the size of ${name}'s collection` : `${name}'s binders`;

function ModeChoice({ mode, setMode, add, replace }: { mode: ExportMode; setMode: (m: ExportMode) => void; add: string; replace: string }) {
  return (
    <Radio.Group value={mode} onChange={(v) => setMode(v as ExportMode)}>
      <Stack gap={6}>
        <Radio value="add" label={add} />
        <Radio value="replace" color="red" label={replace} />
      </Stack>
    </Radio.Group>
  );
}

function PreviewStep({ site, plan, name }: { site: SiteProvider; plan: ExportPlan; name: string }) {
  const removeCount = plan.remove.entries.length;
  return (
    <Stack>
      <Alert color="blue" variant="light" icon={<IconEye size={18} />} p="xs">
        <b>Preview only.</b> Nothing has been changed on {site.label} yet, and nothing will be until you confirm on the next step.
      </Alert>
      {plan.blocked && (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />}>
          {plan.blocked}
        </Alert>
      )}
      {plan.warnings.map((w, i) => (
        <Alert
          key={i}
          color={w.level === 'danger' ? 'red' : w.level === 'warning' ? 'yellow' : 'blue'}
          variant="light"
          icon={w.level === 'info' ? <IconInfoCircle size={18} /> : <IconAlertTriangle size={18} />}
          p="xs"
        >
          {w.text}
        </Alert>
      ))}
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <Stat
          label="Would be deleted"
          value={removeCount ? plural(plan.remove.copies, 'copy', 'copies') : 'Nothing'}
          color={removeCount ? 'red' : undefined}
          lines={[removeCount ? plural(removeCount, 'entry', 'entries') : 'Nothing would be deleted']}
        />
        <Stat label="Would be added" value={plural(plan.add.copies, 'copy', 'copies')} color="teal" lines={[plural(plan.add.prints, 'print')]} />
        <Stat label={`In ${plan.targetLabel}`} value={`${n(plan.before)} → ${n(plan.after)}`} lines={['Copies now → after the export']} />
      </SimpleGrid>
      <Stack gap={4}>
        <Text size="sm" fw={600}>
          If you confirm, Tithies will, in order:
        </Text>
        <List type="ordered" size="sm" spacing={2}>
          {plan.steps.map((s, i) => (
            <List.Item key={i}>{s}</List.Item>
          ))}
        </List>
        <Text size="xs" c="dimmed">
          That would be {plural(plan.writes, 'change')} sent to {name} on {site.label} and about {plural(plan.reads, 'read')}, {estimate(site, plan.writes + plan.reads)}.
          Every change it sends will be kept in the Change log, exactly as sent.
        </Text>
      </Stack>
      <Tabs defaultValue={removeCount ? 'removed' : 'added'} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="added">To add ({n(plan.items.length)})</Tabs.Tab>
          <Tabs.Tab value="removed" disabled={!removeCount} color="red">
            To delete ({n(removeCount)})
          </Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="added" pt="xs">
          <ScrollArea.Autosize mah={260}>
            <Table fz="xs" verticalSpacing={2} striped>
              <Table.Tbody>
                {plan.items.map((i) => (
                  <Table.Tr key={i.key}>
                    <Table.Td className="ti-num" w={50}>
                      ×{i.qty}
                    </Table.Td>
                    <Table.Td>{i.name}</Table.Td>
                    <Table.Td>
                      {i.set.toUpperCase()} #{i.cn} · {finishLabel(i.finish)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        </Tabs.Panel>
        <Tabs.Panel value="removed" pt="xs">
          <ScrollArea.Autosize mah={260}>
            <Table fz="xs" verticalSpacing={2} striped>
              <Table.Tbody>
                {plan.remove.entries.slice(0, 2000).map((e) => (
                  <Table.Tr key={e.entryId}>
                    <Table.Td className="ti-num" w={50}>
                      ×{e.qty}
                    </Table.Td>
                    <Table.Td>{e.name}</Table.Td>
                    <Table.Td>
                      {e.set.toUpperCase()} #{e.cn} · {finishLabel(e.finish)}
                    </Table.Td>
                    <Table.Td c="dimmed">
                      {e.lang.toUpperCase()} · {e.condition}
                      {e.isProxy ? ' · proxy' : ''}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {removeCount > 2000 && (
              <Text size="xs" c="dimmed">
                …and {n(removeCount - 2000)} more.
              </Text>
            )}
          </ScrollArea.Autosize>
          <Text size="xs" c="dimmed" mt={4}>
            If the export runs, the Change log will keep every deleted entry, with a CSV to import them back on {site.label}.
          </Text>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function ProgressStep({ opId, site, onCancel }: { opId: number; site: SiteProvider; onCancel: () => void }) {
  const op = useChangeOp(opId);
  if (!op) return <Loader size="sm" />;
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
          <Text size="sm">{op.phase ?? 'Working…'}</Text>
          {p && p.total > 0 ? <PercentBar progress={p} unit={p.unit ?? 'change'} /> : <Progress value={100} animated striped />}
          <Text size="xs" c="dimmed">
            {plural(op.calls, 'change')} sent so far. You can close this window: the export goes on. Find it again with “Running” at the top of the page, or in the Change log.
          </Text>
          <Group>
            <Button size="xs" variant="default" onClick={onCancel}>
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

/**
 * Exports cards to an account of a site, in four steps: the target (an account, then a new or
 * existing binder, or the collection; replace or add), a preview of every change read live
 * from the target, a confirmation, then the progress and the check of the result. Each step
 * reads only what it needs (the binder list, then the binder's cards or the collection).
 */
export function ExportDialog({ opened, onClose, site, items, sourceAccountKey, source, onStarted }: ExportDialogProps) {
  const { accounts: all } = useCurrentAccount();
  const { liveKeys } = useSiteSessions();
  const accounts = useMemo(() => all.filter((a) => a.type === site.type), [all, site.type]);
  const exporter = exporterOf(site.type);
  const [step, setStep] = useState(0);
  const [accountKey, setAccountKey] = useState<AccountKey | null>(null);
  const [read, setRead] = useState<ReadTargetResult | null>(null);
  const [reading, setReading] = useState<TargetRead | null>(null);
  const [kind, setKind] = useState<Kind>('newBinder');
  const [binderName, setBinderName] = useState(`Tithies export ${today()}`);
  const [visibility, setVisibility] = useState<BinderVisibility>('private');
  const [binderId, setBinderId] = useState<string | null>(null);
  const [mode, setMode] = useState<ExportMode>('add');
  const [understood, setUnderstood] = useState(false);
  const [sameUnderstood, setSameUnderstood] = useState(false);
  const [typed, setTyped] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [opId, setOpId] = useState<number | null>(null);
  /** What the started export sent: the page's list is cleared once it starts. */
  const [sent, setSent] = useState<{ prints: number; copies: number } | null>(null);
  const progress = useReadProgress(reading ? accountKey : null);
  const savedMeta = useCollectionMeta(accountKey);
  const savedCollection = !!savedMeta?.fullReadAt && Date.now() - savedMeta.fullReadAt < FULL_READ_EVERY_MS;

  // Opening: start over at the target step (choices kept); another account than the compared one first.
  useEffect(() => {
    if (!opened) return;
    setStep(0);
    setOpId(null);
    setSent(null);
    setStartError(null);
    setUnderstood(false);
    setSameUnderstood(false);
    setTyped('');
    setAccountKey((k) => (k && accounts.some((a) => a.key === k) ? k : ((accounts.find((a) => a.key !== sourceAccountKey) ?? accounts[0])?.key ?? null)));
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Reads `what` from the account; resolves with the new state (null when the read failed). */
  const doRead = async (key: AccountKey | null, what: TargetRead): Promise<TargetState | null> => {
    if (!key) return null;
    setReading(what);
    try {
      const res = await readExportTarget(site.type, key, what).catch((e): ReadTargetResult => ({ ok: false, code: 'error', error: e instanceof Error ? e.message : String(e) }));
      setRead(res);
      return res.ok ? res.state : null;
    } finally {
      setReading(null);
    }
  };
  // The account's binder list (one request), to pick a binder.
  useEffect(() => {
    setRead(null);
    if (opened && accountKey) void doRead(accountKey, { kind: 'binders' });
  }, [opened, accountKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const state: TargetState | null = read?.ok ? read.state : null;
  const account: AccountRow | null = accounts.find((a) => a.key === accountKey) ?? null;
  const name = account ? accountLabel(account) : '';
  const binders = state?.binders ?? [];
  const target: ExportTarget | null = !accountKey
    ? null
    : kind === 'newBinder'
      ? { accountKey, kind, name: binderName, visibility }
      : kind === 'binder'
        ? binderId
          ? { accountKey, kind, binderId, mode }
          : null
        : { accountKey, kind, mode };
  const plan = useMemo(
    () =>
      target && state && exporter && stateCovers(state, previewRead(target))
        ? planExport(target, items, state, { sourceAccountKey, targetName: name, limits: exporter.limits, savedCollection })
        : null,
    [JSON.stringify(target), state, items, sourceAccountKey, name, exporter, savedCollection], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /** "Preview the changes": reads what this target needs (if not read yet), then shows the preview. */
  const preview = async () => {
    if (!target || !state) return;
    const need = previewRead(target);
    if (!stateCovers(state, need) && !(await doRead(accountKey, need))) return;
    setStep(1);
  };

  const destructive = !!plan && plan.remove.entries.length > 0;
  const same = !!accountKey && accountKey === sourceAccountKey;
  const confirmWord = plan?.remove.wholeCollection ? (account?.userName ?? '') : (plan?.binder?.name ?? '');
  const canExport = !!plan && !plan.blocked && understood && (!same || sameUnderstood) && (!destructive || typed.trim() === confirmWord.trim());

  const go = async () => {
    if (!plan || !target) return;
    setStarting(true);
    setStartError(null);
    try {
      const res = await startExport(site.type, { target, items: plan.items, digest: plan.digest, sourceAccountKey, source });
      if (!res.ok) setStartError(res.error);
      else {
        setSent({ prints: items.length, copies: items.reduce((s, i) => s + i.qty, 0) });
        setOpId(res.opId);
        setStep(3);
        onStarted?.();
      }
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const readingTarget = reading && reading.kind !== 'binders' ? reading : null;
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="xl"
      title={
        <Group gap="xs">
          <IconUpload size={18} />
          <Text fw={600}>Export to {site.label}</Text>
          <Badge variant="light">
            {plural(sent?.prints ?? items.length, 'print')} · {plural(sent?.copies ?? items.reduce((s, i) => s + i.qty, 0), 'copy', 'copies')}
          </Badge>
        </Group>
      }
    >
      <Stepper active={step} size="sm" allowNextStepsSelect={false} onStepClick={(s) => step < 3 && s < step && setStep(s)}>
        <Stepper.Step label="Target" description="Where the cards go">
          <Stack mt="md">
            {!accounts.length ? (
              <Alert color="yellow">No {site.label} account in Tithies yet: sync one first.</Alert>
            ) : (
              <>
                <Select
                  label={`${site.label} account to change`}
                  description={`Tithies makes the changes as this account: it must be the one logged in on ${site.label} in this browser.`}
                  data={accounts.map((a) => ({
                    value: a.key,
                    label: `${accountLabel(a)}${a.key === sourceAccountKey ? ' (the account compared here)' : ''}${liveKeys.has(a.key) ? ' · logged in' : ''}`,
                  }))}
                  value={accountKey}
                  onChange={(v) => v && setAccountKey(v as AccountKey)}
                  allowDeselect={false}
                  leftSection={<SiteIcon type={site.type} size={16} />}
                  disabled={!!reading}
                />
                {same && (
                  <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} p="xs">
                    This is the account you're comparing. Its collection would change with the export: see the warning in the preview.
                  </Alert>
                )}
                {reading?.kind === 'binders' && (
                  <Group gap="xs">
                    <Loader size="xs" />
                    <Text size="sm" c="dimmed">
                      Reading {name}'s binders on {site.label}… (reads only)
                    </Text>
                  </Group>
                )}
                {read && !read.ok && !reading && (
                  <Alert color={read.code === 'busy' ? 'yellow' : 'red'} variant="light" icon={<IconAlertTriangle size={18} />}>
                    <Group justify="space-between" gap="xs">
                      <Text size="sm">{read.error}</Text>
                      <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={() => void doRead(accountKey, { kind: 'binders' })}>
                        Try again
                      </Button>
                    </Group>
                  </Alert>
                )}

                <SegmentedControl
                  value={kind}
                  onChange={(v) => setKind(v as Kind)}
                  disabled={!!readingTarget}
                  data={[
                    { value: 'newBinder', label: 'New binder' },
                    { value: 'binder', label: 'Existing binder', disabled: !site.capabilities.exportTo.binders },
                    { value: 'collection', label: 'Collection', disabled: !site.capabilities.exportTo.collection },
                  ]}
                />
                {kind === 'newBinder' && (
                  <Group grow align="flex-start">
                    <TextInput label="Binder name" value={binderName} onChange={(e) => setBinderName(e.currentTarget.value)} maxLength={100} />
                    <Select
                      label="Visibility"
                      data={[
                        { value: 'private', label: 'Private' },
                        { value: 'unlisted', label: 'Unlisted' },
                        { value: 'public', label: 'Public' },
                      ]}
                      value={visibility}
                      onChange={(v) => v && setVisibility(v as BinderVisibility)}
                      allowDeselect={false}
                    />
                  </Group>
                )}
                {kind === 'binder' && (
                  <Stack gap="xs">
                    <Select
                      label="Binder"
                      placeholder={state ? (binders.length ? 'Pick a binder' : 'This account has no binder yet') : 'Reading the binders…'}
                      data={binders.map((b) => ({ value: b.id, label: b.name }))}
                      value={binderId}
                      onChange={setBinderId}
                      disabled={!binders.length || !!readingTarget}
                      searchable={binders.length > 8}
                    />
                    <ModeChoice
                      mode={mode}
                      setMode={setMode}
                      add="Add the cards to the binder (its cards stay)"
                      replace="Replace the binder's cards (they would be deleted from the collection)"
                    />
                  </Stack>
                )}
                {kind === 'collection' && (
                  <ModeChoice
                    mode={mode}
                    setMode={setMode}
                    add="Add the cards to the collection (not in a binder)"
                    replace="Replace the whole collection (every card would be deleted, binders' cards included)"
                  />
                )}
                {readingTarget && (
                  <Stack gap={4}>
                    <Text size="sm">Reading {readLabel(readingTarget, name)} for the preview… (reads only, nothing is changed)</Text>
                    <PercentBar progress={progress ?? { done: 0, total: 1 }} unit="page" />
                  </Stack>
                )}
                <Text size="xs" c="dimmed">
                  Cards will be added Near Mint, English, with their exact set, collector number and finish (Moxfield's CSV import). Nothing is changed until you
                  confirm, two steps from here.
                </Text>
              </>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button disabled={!target || !state || (!!reading && !readingTarget)} loading={!!readingTarget} onClick={() => void preview()}>
                Preview the changes
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Preview" description="What would change">
          <Stack mt="md">
            {plan && <PreviewStep site={site} plan={plan} name={name} />}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button disabled={!plan || !!plan.blocked} onClick={() => setStep(2)}>
                Continue
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Confirm" description="Last check">
          <Stack mt="md">
            {plan && (
              <>
                <Alert color={destructive ? 'red' : 'blue'} variant="light" icon={<IconAlertTriangle size={18} />} title="Nothing has been changed yet">
                  <Text size="sm">
                    When you click the button below, Tithies will change <b>{name}</b> on {site.label}:{' '}
                    {destructive ? `it will delete ${plural(plan.remove.copies, 'copy', 'copies')}, then add ` : 'it will add '}
                    {plural(plan.add.copies, 'copy', 'copies')} to {plan.targetLabel}. {site.label} has no undo; the Change log will keep what is deleted, as a CSV
                    to import back.
                  </Text>
                </Alert>
                <Checkbox
                  checked={understood}
                  onChange={(e) => setUnderstood(e.currentTarget.checked)}
                  label={`I understand that this will change ${name}'s ${plan.target.kind === 'collection' ? 'collection' : 'binders and collection'} on ${site.label}`}
                />
                {same && (
                  <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} title={`${name} is the account you're comparing`}>
                    <Stack gap="xs">
                      <Text size="sm">
                        On {site.label}, the cards of a binder are cards of the collection. Exporting to this account would therefore change the very collection this
                        page compares with your decks:
                      </Text>
                      <List size="sm" spacing={2}>
                        <List.Item>cards “Missing from collection” you export would become owned: they wouldn't be missing any more;</List.Item>
                        <List.Item>cards “Not in any deck” you export would be added once more: the collection would then have them twice;</List.Item>
                        <List.Item>the next “Compare” would show the collection as it is after the export.</List.Item>
                      </List>
                      <Checkbox checked={sameUnderstood} onChange={(e) => setSameUnderstood(e.currentTarget.checked)} label="I want to change the collection I'm comparing" />
                    </Stack>
                  </Alert>
                )}
                {destructive && (
                  <TextInput
                    label={plan.remove.wholeCollection ? `Type the username ${confirmWord} to delete the whole collection` : `Type the binder name “${confirmWord}” to replace its cards`}
                    value={typed}
                    onChange={(e) => setTyped(e.currentTarget.value)}
                    error={typed && typed.trim() !== confirmWord.trim() ? "That's not it" : undefined}
                  />
                )}
                {startError && (
                  <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />}>
                    {startError}
                  </Alert>
                )}
              </>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button color={destructive ? 'red' : 'blue'} disabled={!canExport} loading={starting} leftSection={<IconUpload size={16} />} onClick={() => void go()}>
                {destructive ? 'Delete and export' : 'Export now'}
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Completed>
          <Stack mt="md">
            {opId != null && <ProgressStep opId={opId} site={site} onCancel={() => void cancelExport(site.type)} />}
            <Group justify="flex-end">
              <Button variant="default" onClick={onClose}>
                Close
              </Button>
            </Group>
          </Stack>
        </Stepper.Completed>
      </Stepper>
    </Modal>
  );
}
