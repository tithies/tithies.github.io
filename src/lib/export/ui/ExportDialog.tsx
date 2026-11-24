import { Alert, Badge, Button, Group, Modal, Stack, Stepper, Text } from '@mantine/core';
import { IconPlus, IconUpload } from '@tabler/icons-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { accountData } from '@/lib/accounts/data';
import { accountLabel, type AccountKey } from '@/lib/accounts/types';
import type { SiteProvider } from '@/lib/sites/provider';
import { useSiteSessions } from '@/lib/sites/useSiteSessions';
import { FULL_READ_EVERY_MS } from '@/lib/decks/collection';
import { batchIssues, MAX_EXPORT_TARGETS, runOrder } from '../batch';
import { cancelExportRead, readExportTarget, startExport, useReadProgress } from '../client';
import { exporterOf } from '../exporters';
import type { ReadTargetResult } from '../job';
import { planExport, previewRead } from '../plan';
import type { ExportItem, ExportPlan, ExportTarget, TargetRead, TargetState } from '../types';
import { ConfirmStep, typedAll, type ConfirmTarget } from './ConfirmStep';
import { ExportBatchProgress, ExportProgress } from './ExportProgress';
import { plural, PreviewStep, PreviewTabs, targetTitle, type PreviewTarget } from './PreviewStep';
import { draftTarget, latestBinders, newDraft, pickState, type TargetDraft } from './targets';
import { TargetForm } from './TargetForm';

const today = () => new Date().toISOString().slice(0, 10);

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
   * Called once the exports have started: the cards are handed over to them, so the page clears
   * its list (to try again after a failure, pick the cards again; the Change log keeps what was sent).
   */
  onStarted?: () => void;
}

type States = Partial<Record<AccountKey, TargetState[]>>;
type ReadError = { code: string; error: string };

/** Accounts whose saved collection is recent: reading it again is usually one page (its changes). Joined by commas. */
function useSavedCollections(keys: readonly AccountKey[]): string {
  return (
    useLiveQuery(async () => {
      const fresh: AccountKey[] = [];
      for (const k of keys) {
        const meta = await accountData(k).meta.get('collection');
        if (meta?.fullReadAt && Date.now() - meta.fullReadAt < FULL_READ_EVERY_MS) fresh.push(k);
      }
      return fresh.join(',');
    }, [keys.join(',')]) ?? ''
  );
}

/**
 * Exports cards to accounts of a site, in four steps: the targets (each an account, then a new or
 * existing binder, or the collection; replace or add), a preview of every change read live from
 * each target, a confirmation, then the progress and the check of the results. Several targets
 * are several exports, made one after another, each as if made by hand after the one before.
 * Each step reads only what it needs (the binder list, then the binder's cards or the collection).
 */
export function ExportDialog({ opened, onClose, site, items, sourceAccountKey, source, onStarted }: ExportDialogProps) {
  const { accounts: all } = useCurrentAccount();
  const { liveKeys } = useSiteSessions();
  const accounts = useMemo(() => all.filter((a) => a.type === site.type), [all, site.type]);
  const exporter = exporterOf(site.type);
  const [step, setStep] = useState(0);
  const nextId = useRef(1);
  const [drafts, setDrafts] = useState<TargetDraft[]>([]);
  // What was read of each account since the dialog opened (newest last), and its last failed read.
  const [states, setStatesNow] = useState<States>({});
  const statesRef = useRef<States>({});
  const setStates = (next: States) => {
    statesRef.current = next;
    setStatesNow(next);
  };
  const [errors, setErrors] = useState<Partial<Record<AccountKey, ReadError>>>({});
  /** The read running (one at a time), and the target it is for (null: an account's binder list). */
  const [reading, setReading] = useState<{ accountKey: AccountKey; read: TargetRead; draftId: number | null } | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const askedBinders = useRef(new Set<AccountKey>());
  const openedRef = useRef(opened);
  const [understood, setUnderstood] = useState(false);
  const [sameUnderstood, setSameUnderstood] = useState(false);
  const [typed, setTyped] = useState<Record<number, string>>({});
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [opIds, setOpIds] = useState<number[] | null>(null);
  /** What the started exports sent: the page's list is cleared once they start. */
  const [sent, setSent] = useState<{ prints: number; copies: number; targets: number } | null>(null);
  const progress = useReadProgress(reading?.accountKey ?? null);
  const defaultKey = (accounts.find((a) => a.key !== sourceAccountKey) ?? accounts[0])?.key ?? null;

  // Opening: start over at the target step (targets kept, reads made again); another account than the compared one first.
  useEffect(() => {
    openedRef.current = opened;
    if (!opened) return;
    setStep(0);
    setOpIds(null);
    setSent(null);
    setStartError(null);
    setUnderstood(false);
    setSameUnderstood(false);
    setTyped({});
    setStates({});
    setErrors({});
    askedBinders.current = new Set();
    setDrafts((ds) => {
      const kept = ds.filter((d) => d.accountKey && accounts.some((a) => a.key === d.accountKey));
      return kept.length ? kept : [newDraft(nextId.current++, defaultKey, [], today())];
    });
  }, [opened]); // eslint-disable-line react-hooks/exhaustive-deps
  // Accounts known after the dialog opened: the targets without one get the first.
  useEffect(() => {
    if (opened && defaultKey) setDrafts((ds) => (ds.some((d) => !d.accountKey) ? ds.map((d) => (d.accountKey ? d : { ...d, accountKey: defaultKey })) : ds));
  }, [opened, defaultKey]);

  /** Reads `what` from the account, after the reads asked before; resolves with the new state (null when the read failed). */
  const doRead = (key: AccountKey, what: TargetRead, draftId: number | null): Promise<TargetState | null> => {
    const run = async (): Promise<TargetState | null> => {
      if (!openedRef.current) return null;
      setReading({ accountKey: key, read: what, draftId });
      try {
        const res = await readExportTarget(site.type, key, what).catch((e): ReadTargetResult => ({ ok: false, code: 'error', error: e instanceof Error ? e.message : String(e) }));
        if (!res.ok) {
          if (res.code !== 'cancelled') setErrors((e) => ({ ...e, [key]: { code: res.code, error: res.error } }));
          return null;
        }
        setStates({ ...statesRef.current, [key]: [...(statesRef.current[key] ?? []), res.state] });
        setErrors((e) => {
          const { [key]: _, ...rest } = e;
          return rest;
        });
        return res.state;
      } finally {
        setReading(null);
      }
    };
    const p = chain.current.then(run, run);
    chain.current = p.catch(() => {});
    return p;
  };

  // Each target's account: its binder list (one request), to pick a binder.
  const draftAccounts = useMemo(() => [...new Set(drafts.map((d) => d.accountKey).filter((k): k is AccountKey => !!k))], [drafts]);
  useEffect(() => {
    if (!opened) return;
    for (const key of draftAccounts) {
      if (askedBinders.current.has(key)) continue;
      askedBinders.current.add(key);
      void doRead(key, { kind: 'binders' }, null);
    }
  }, [opened, draftAccounts.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const saved = useSavedCollections(draftAccounts);
  const nameOf = (key: AccountKey | null) => {
    const a = accounts.find((x) => x.key === key);
    return a ? accountLabel(a) : '';
  };
  const targets = drafts.map(draftTarget);
  const targetsKey = JSON.stringify(targets);
  const plans: (ExportPlan | null)[] = useMemo(() => {
    const fresh = new Set(saved.split(','));
    return targets.map((t) => {
      const state = t && exporter ? pickState(states[t.accountKey], previewRead(t)) : null;
      if (!t || !state || !exporter) return null;
      return planExport(t, items, state, { sourceAccountKey, targetName: nameOf(t.accountKey), limits: exporter.limits, savedCollection: fresh.has(t.accountKey) });
    });
  }, [targetsKey, states, items, sourceAccountKey, accounts, exporter, saved]); // eslint-disable-line react-hooks/exhaustive-deps
  // The rules between targets (the same destination twice…), on the targets complete so far.
  const issues = useMemo(() => {
    const at = targets.map((t, i) => (t ? i : -1)).filter((i) => i >= 0);
    return batchIssues(at.map((i) => targets[i]!)).map((x) => ({ ...x, index: at[x.index] ?? x.index }));
  }, [targetsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const complete = drafts.length > 0 && targets.every(Boolean);
  const order = complete ? runOrder(targets as ExportTarget[]) : drafts.map((_, i) => i);
  const allPlanned = complete && plans.every((p) => p && !p.blocked);

  /** "Preview the changes": reads what each target needs (if not read yet), then shows the preview. */
  const preview = async () => {
    for (const [i, t] of targets.entries()) {
      if (!t) return;
      const need = previewRead(t);
      if (!pickState(statesRef.current[t.accountKey], need) && !(await doRead(t.accountKey, need, drafts[i].id))) return;
    }
    setStep(1);
  };

  const close = () => {
    // A preview read nobody waits for any more (it can be hundreds of pages).
    if (reading) void cancelExportRead(site.type).catch(() => {});
    onClose();
  };

  const update = (id: number, patch: Partial<TargetDraft>) => setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  const addTarget = () => setDrafts((ds) => [...ds, newDraft(nextId.current++, ds[ds.length - 1]?.accountKey ?? defaultKey, ds, today())]);
  const removeTarget = (id: number) => setDrafts((ds) => ds.filter((d) => d.id !== id));

  const previewTargets: PreviewTarget[] = drafts.flatMap((d, i) => {
    const plan = plans[i];
    if (!plan) return [];
    // The export made just before this one on the same account (in the order they run).
    const pos = order.indexOf(i);
    const before = order.slice(0, pos).filter((j) => targets[j]?.accountKey === d.accountKey && plans[j]);
    const prev = before.length ? before[before.length - 1] : -1;
    const after = prev >= 0 ? `${targetTitle({ plan: plans[prev]!, name: nameOf(d.accountKey) }, 1)} (target ${prev + 1})` : undefined;
    return [{ number: i + 1, plan, name: nameOf(d.accountKey), after }];
  });
  const confirmTargets: ConfirmTarget[] = order.flatMap((i) => {
    const plan = plans[i];
    const d = drafts[i];
    const a = accounts.find((x) => x.key === d?.accountKey);
    return plan && d && a ? [{ id: d.id, number: i + 1, plan, name: accountLabel(a), userName: a.userName }] : [];
  });
  const sameAccount = accounts.find((a) => a.key === sourceAccountKey && drafts.some((d) => d.accountKey === a.key));
  const destructive = confirmTargets.some((t) => t.plan.remove.entries.length > 0);
  const canExport = allPlanned && understood && (!sameAccount || sameUnderstood) && typedAll(confirmTargets, typed);
  const several = drafts.length > 1;

  const go = async () => {
    if (!allPlanned) return;
    setStarting(true);
    setStartError(null);
    try {
      // A read still running would make the start busy.
      await chain.current;
      const ordered = order.map((i) => ({ i, plan: plans[i]! }));
      const res = await startExport(site.type, {
        items: ordered[0].plan.items,
        sourceAccountKey,
        source,
        exports: ordered.map(({ plan }) => ({ target: plan.target, digest: plan.digest, estimate: plan.requests, label: plan.targetLabel })),
      });
      if (!res.ok) setStartError(res.index != null && ordered.length > 1 && ordered[res.index] ? `Target ${ordered[res.index].i + 1}: ${res.error}` : res.error);
      else {
        setSent({ prints: items.length, copies: items.reduce((s, i) => s + i.qty, 0), targets: ordered.length });
        setOpIds(res.opIds);
        setStep(3);
        onStarted?.();
      }
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const readingDraft = reading?.draftId ?? null;
  const targetCount = sent?.targets ?? drafts.length;
  return (
    <Modal
      opened={opened}
      onClose={close}
      size="xl"
      title={
        <Group gap="xs">
          <IconUpload size={18} />
          <Text fw={600}>Export to {site.label}</Text>
          <Badge variant="light">
            {plural(sent?.prints ?? items.length, 'print')} · {plural(sent?.copies ?? items.reduce((s, i) => s + i.qty, 0), 'copy', 'copies')}
          </Badge>
          {targetCount > 1 && <Badge variant="outline">{plural(targetCount, 'target')}</Badge>}
        </Group>
      }
    >
      <Stepper active={step} size="sm" allowNextStepsSelect={false} onStepClick={(s) => step < 3 && s < step && setStep(s)}>
        <Stepper.Step label={several ? 'Targets' : 'Target'} description="Where the cards go">
          <Stack mt="md">
            {!accounts.length ? (
              <Alert color="yellow">No {site.label} account in Tithies yet: sync one first.</Alert>
            ) : (
              <>
                {drafts.map((d, i) => (
                  <TargetForm
                    key={d.id}
                    site={site}
                    draft={d}
                    number={i + 1}
                    count={drafts.length}
                    accounts={accounts}
                    sourceAccountKey={sourceAccountKey}
                    sameNoted={drafts.slice(0, i).some((x) => x.accountKey === sourceAccountKey)}
                    liveKeys={liveKeys}
                    binders={d.accountKey ? latestBinders(states[d.accountKey]) : null}
                    readingBinders={!!reading && reading.draftId == null && reading.accountKey === d.accountKey}
                    readError={(d.accountKey && errors[d.accountKey]) || null}
                    onRetry={() => d.accountKey && void doRead(d.accountKey, { kind: 'binders' }, null)}
                    readingTarget={readingDraft === d.id ? reading!.read : null}
                    progress={readingDraft === d.id ? progress : null}
                    issues={issues.filter((x) => x.index === i)}
                    busy={!!reading}
                    onChange={(patch) => update(d.id, patch)}
                    onRemove={() => removeTarget(d.id)}
                  />
                ))}
                <Group>
                  <Button variant="light" size="xs" leftSection={<IconPlus size={14} />} onClick={addTarget} disabled={drafts.length >= MAX_EXPORT_TARGETS || readingDraft != null}>
                    Add a target
                  </Button>
                  <Text size="xs" c="dimmed">
                    The same cards go to every target: each target is its own export, made one after another.
                  </Text>
                </Group>
                <Text size="xs" c="dimmed">
                  Cards will be added Near Mint, each in its language, with their exact set, collector number and finish (Moxfield's CSV import). Nothing is
                  changed until you confirm, two steps from here.
                </Text>
              </>
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={close}>
                Cancel
              </Button>
              <Button
                disabled={!complete || issues.some((x) => x.level === 'error') || draftAccounts.some((k) => !states[k]?.length) || (!!reading && readingDraft == null)}
                loading={readingDraft != null}
                onClick={() => void preview()}
              >
                Preview the changes
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Preview" description="What would change">
          <Stack mt="md">
            {previewTargets.length === 1 && !several ? (
              <PreviewStep site={site} plan={previewTargets[0].plan} name={previewTargets[0].name} />
            ) : (
              previewTargets.length > 0 && <PreviewTabs site={site} targets={previewTargets} />
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button disabled={!allPlanned} onClick={() => setStep(2)}>
                Continue
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Step label="Confirm" description="Last check">
          <Stack mt="md">
            {allPlanned && (
              <ConfirmStep
                site={site}
                targets={confirmTargets}
                sameName={sameAccount ? accountLabel(sameAccount) : null}
                understood={understood}
                setUnderstood={setUnderstood}
                sameUnderstood={sameUnderstood}
                setSameUnderstood={setSameUnderstood}
                typed={typed}
                setTyped={(id, v) => setTyped((t) => ({ ...t, [id]: v }))}
                startError={startError}
              />
            )}
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setStep(1)}>
                Back
              </Button>
              <Button color={destructive ? 'red' : 'blue'} disabled={!canExport} loading={starting} leftSection={<IconUpload size={16} />} onClick={() => void go()}>
                {several ? `${destructive ? 'Delete and start' : 'Start'} the ${drafts.length} exports` : destructive ? 'Delete and export' : 'Export now'}
              </Button>
            </Group>
          </Stack>
        </Stepper.Step>
        <Stepper.Completed>
          <Stack mt="md">
            {opIds && (opIds.length === 1 ? <ExportProgress opId={opIds[0]} site={site} /> : <ExportBatchProgress opIds={opIds} site={site} />)}
            <Group justify="flex-end">
              <Button variant="default" onClick={close}>
                Close
              </Button>
            </Group>
          </Stack>
        </Stepper.Completed>
      </Stepper>
    </Modal>
  );
}
