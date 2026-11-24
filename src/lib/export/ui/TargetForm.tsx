import { ActionIcon, Alert, Button, Group, Loader, Paper, Radio, SegmentedControl, Select, Stack, Text, TextInput, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconRefresh, IconX } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { accountLabel, type AccountKey, type AccountRow } from '@/lib/accounts/types';
import type { SiteProvider } from '@/lib/sites/provider';
import type { BinderVisibility, SiteBinder } from '@/lib/sites/types';
import { SiteIcon } from '@/lib/ui/SiteIcon';
import type { BatchIssue } from '../batch';
import type { ExportMode, ReadProgress, TargetRead } from '../types';
import { PercentBar } from './ExportProgress';
import type { TargetDraft } from './targets';

function ModeChoice({ mode, setMode, add, replace, disabled }: { mode: ExportMode; setMode: (m: ExportMode) => void; add: string; replace: string; disabled?: boolean }) {
  return (
    <Radio.Group value={mode} onChange={(v) => setMode(v as ExportMode)}>
      <Stack gap={6}>
        <Radio value="add" label={add} disabled={disabled} />
        <Radio value="replace" color="red" label={replace} disabled={disabled} />
      </Stack>
    </Radio.Group>
  );
}

/** "the binder's cards" / "the collection" */
const readLabel = (r: TargetRead, name: string) =>
  r.kind === 'binder' ? "the binder's cards" : r.kind === 'collection' ? `${name}'s whole collection` : r.kind === 'totals' ? `the size of ${name}'s collection` : `${name}'s binders`;

export interface TargetFormProps {
  site: SiteProvider;
  draft: TargetDraft;
  /** Its number in the list (1-based), and how many targets there are (several: framed, removable). */
  number: number;
  count: number;
  accounts: AccountRow[];
  sourceAccountKey: AccountKey | null;
  /** Another target before this one is already on the compared account (its note is shown there only). */
  sameNoted?: boolean;
  liveKeys: ReadonlySet<AccountKey>;
  /** The account's binders as last read (null: not read yet). */
  binders: SiteBinder[] | null;
  /** The account's binder list is being read. */
  readingBinders: boolean;
  /** The account's last read failed. */
  readError: { code: string; error: string } | null;
  onRetry: () => void;
  /** The preview read of this target, while it runs, and its pages. */
  readingTarget: TargetRead | null;
  progress: ReadProgress | null;
  issues: BatchIssue[];
  /** A read is running: the choices that would need another one wait. */
  busy: boolean;
  onChange: (patch: Partial<TargetDraft>) => void;
  onRemove: () => void;
}

/** One target of the export: the account, then a new binder, an existing binder or the collection (replace or add). */
export function TargetForm(p: TargetFormProps) {
  const { site, draft: d, accounts, sourceAccountKey, binders } = p;
  const account = accounts.find((a) => a.key === d.accountKey) ?? null;
  const name = account ? accountLabel(account) : '';
  const same = !!d.accountKey && d.accountKey === sourceAccountKey && !p.sameNoted;
  const framed = p.count > 1;
  const body: ReactNode = (
    <Stack>
      <Select
        label={`${site.label} account to change`}
        description={p.number === 1 ? `Tithies makes the changes as this account: it must be the one logged in on ${site.label} in this browser.` : undefined}
        data={accounts.map((a) => ({
          value: a.key,
          label: `${accountLabel(a)}${a.key === sourceAccountKey ? ' (the account compared here)' : ''}${p.liveKeys.has(a.key) ? ' · logged in' : ''}`,
        }))}
        value={d.accountKey}
        // Another account has other binders: the binder picked doesn't follow.
        onChange={(v) => v && v !== d.accountKey && p.onChange({ accountKey: v as AccountKey, binderId: null })}
        allowDeselect={false}
        leftSection={<SiteIcon type={site.type} size={16} />}
        disabled={p.busy}
      />
      {same && (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} p="xs">
          This is the account you're comparing. Its collection would change with the export: see the warning in the preview.
        </Alert>
      )}
      {p.readingBinders && (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Reading {name}'s binders on {site.label}… (reads only)
          </Text>
        </Group>
      )}
      {p.readError && !p.readingBinders && !p.readingTarget && (
        <Alert color={p.readError.code === 'busy' ? 'yellow' : 'red'} variant="light" icon={<IconAlertTriangle size={18} />}>
          <Group justify="space-between" gap="xs">
            <Text size="sm">{p.readError.error}</Text>
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={p.onRetry} disabled={p.busy}>
              Try again
            </Button>
          </Group>
        </Alert>
      )}

      <SegmentedControl
        value={d.kind}
        onChange={(v) => p.onChange({ kind: v as TargetDraft['kind'] })}
        disabled={!!p.readingTarget}
        data={[
          { value: 'newBinder', label: 'New binder' },
          { value: 'binder', label: 'Existing binder', disabled: !site.capabilities.exportTo.binders },
          { value: 'collection', label: 'Collection', disabled: !site.capabilities.exportTo.collection },
        ]}
      />
      {d.kind === 'newBinder' && (
        <Group grow align="flex-start">
          <TextInput label="Binder name" value={d.binderName} onChange={(e) => p.onChange({ binderName: e.currentTarget.value })} maxLength={100} />
          <Select
            label="Visibility"
            data={[
              { value: 'private', label: 'Private' },
              { value: 'unlisted', label: 'Unlisted' },
              { value: 'public', label: 'Public' },
            ]}
            value={d.visibility}
            onChange={(v) => v && p.onChange({ visibility: v as BinderVisibility })}
            allowDeselect={false}
          />
        </Group>
      )}
      {d.kind === 'binder' && (
        <Stack gap="xs">
          <Select
            label="Binder"
            placeholder={binders ? (binders.length ? 'Pick a binder' : 'This account has no binder yet') : 'Reading the binders…'}
            data={(binders ?? []).map((b) => ({ value: b.id, label: b.name }))}
            value={d.binderId}
            onChange={(v) => p.onChange({ binderId: v })}
            disabled={!binders?.length || !!p.readingTarget}
            searchable={(binders?.length ?? 0) > 8}
          />
          <ModeChoice
            mode={d.mode}
            setMode={(mode) => p.onChange({ mode })}
            add="Add the cards to the binder (its cards stay)"
            replace="Replace the binder's cards (they would be deleted from the collection)"
            disabled={!!p.readingTarget}
          />
        </Stack>
      )}
      {d.kind === 'collection' && (
        <ModeChoice
          mode={d.mode}
          setMode={(mode) => p.onChange({ mode })}
          add="Add the cards to the collection (not in a binder)"
          replace="Replace the whole collection (every card would be deleted, binders' cards included)"
          disabled={!!p.readingTarget}
        />
      )}
      {p.issues.map((i, k) => (
        <Alert
          key={k}
          color={i.level === 'error' ? 'red' : 'blue'}
          variant="light"
          icon={i.level === 'error' ? <IconAlertTriangle size={18} /> : <IconInfoCircle size={18} />}
          p="xs"
        >
          {i.text}
        </Alert>
      ))}
      {p.readingTarget && (
        <Stack gap={4}>
          <Text size="sm">Reading {readLabel(p.readingTarget, name)} for the preview… (reads only, nothing is changed)</Text>
          <PercentBar progress={p.progress ?? { done: 0, total: 1 }} unit="page" />
        </Stack>
      )}
    </Stack>
  );
  if (!framed) return body;
  return (
    <Paper withBorder p="sm" radius="md">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600} size="sm">
            Target {p.number}
          </Text>
          <Tooltip label="Remove this target">
            <ActionIcon variant="subtle" color="gray" onClick={p.onRemove} disabled={p.busy} aria-label={`Remove target ${p.number}`}>
              <IconX size={16} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {body}
      </Stack>
    </Paper>
  );
}
