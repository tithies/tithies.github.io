import { ActionIcon, Alert, Button, Group, Loader, Paper, Radio, SegmentedControl, Select, Stack, Text, TextInput, Tooltip, useMatches } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconRefresh, IconX } from '@tabler/icons-react';
import { useMemo, type ReactNode } from 'react';
import { accountLabel, type AccountKey, type AccountRow } from '@/lib/accounts/types';
import type { DeckFolder, DeckSummary } from '@/lib/decks/types';
import type { SiteProvider } from '@/lib/sites/provider';
import type { BinderVisibility, SiteBinder } from '@/lib/sites/types';
import { SiteIcon } from '@/lib/ui/SiteIcon';
import type { BatchIssue } from '../batch';
import { lastSegment } from '../grouping';
import type { ExportMode, ReadProgress, TargetRead } from '../types';
import { PercentBar } from './ExportProgress';
import { GroupingEditor } from './GroupingEditor';
import type { TargetDraft } from './targets';
import type { CardFactsState } from './useCardFacts';

const VISIBILITY = [
  { value: 'private', label: 'Private' },
  { value: 'unlisted', label: 'Unlisted' },
  { value: 'public', label: 'Public' },
];

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
  r.kind === 'binder'
    ? "the binder's cards"
    : r.kind === 'collection'
      ? `${name}'s whole collection`
      : r.kind === 'totals'
        ? `the size of ${name}'s collection`
        : r.kind === 'decks'
          ? r.publicIds?.length
            ? "the deck's cards"
            : `${name}'s decks and folders`
          : `${name}'s binders`;

/** Folders by path, for a Select. */
const folderOptions = (folders: readonly DeckFolder[]) => [...folders].sort((a, b) => a.path.localeCompare(b.path)).map((f) => ({ value: f.id, label: f.path }));

/** Decks grouped by their folder, for a Select ("No folder" first). */
function deckOptions(decks: readonly DeckSummary[]) {
  const by = new Map<string, { value: string; label: string }[]>();
  for (const d of [...decks].sort((a, b) => a.name.localeCompare(b.name))) {
    const g = d.folderPath || 'No folder';
    const size = d.mainboardCount + d.sideboardCount + d.maybeboardCount;
    by.set(g, [...(by.get(g) ?? []), { value: d.id, label: `${d.name} (${size.toLocaleString('en-CA')} ${size === 1 ? 'card' : 'cards'})` }]);
  }
  return [...by.entries()].sort(([a], [b]) => (a === 'No folder' ? -1 : b === 'No folder' ? 1 : a.localeCompare(b))).map(([group, items]) => ({ group, items }));
}

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
  /** The account's decks and folders as last read (null: not read yet), and whether they are being read. */
  decks: DeckSummary[] | null;
  folders: DeckFolder[] | null;
  readingDecks: boolean;
  /** The cards' set, rarity and color identity (a deck folder target splits by them). */
  facts: CardFactsState;
  /** Most cards a deck holds. */
  maxDeckCards: number;
  /** Why the site wouldn't take a new folder `name` in `parent` (null: it would). */
  newFolderProblem?: (parent: string | null, name: string) => string | null;
  onChange: (patch: Partial<TargetDraft>) => void;
  onRemove: () => void;
}

/** A deck folder target: new or existing folder, the new decks' visibility, and how the cards are split. */
function FolderChoice({ p }: { p: TargetFormProps }) {
  const { draft: d, folders, decks, facts } = p;
  const folder = folders?.find((f) => f.id === d.folderId) ?? null;
  const parent = folders?.find((f) => f.id === d.parentFolderId) ?? null;
  const path = d.newFolder ? (parent ? `${parent.path}/${d.folderName.trim()}` : d.folderName.trim()) : (folder?.path ?? '');
  // A full path the site wouldn't take (a name's letters, its length, or the folder too deep): said under the name.
  const pathProblem = d.newFolder && d.folderName.trim() ? (p.newFolderProblem?.(parent?.path ?? null, d.folderName) ?? null) : null;
  // A folder with no room left for another one inside (its path at the site's limit) can't be picked.
  const parentOptions = folderOptions(folders ?? []).map((o) => ({ ...o, disabled: !!p.newFolderProblem?.(o.label, 'x') }));
  // The decks already in an existing folder, by name: a group of that name adds to it.
  const existing = useMemo(() => {
    const m = new Map<string, number>();
    if (!d.newFolder && folder) for (const x of decks ?? []) if (x.folderId === folder.id) m.set(x.name.trim().toLowerCase(), x.mainboardCount + x.sideboardCount + x.maybeboardCount);
    return m;
  }, [d.newFolder, folder, decks]);
  return (
    <Stack gap="xs">
      <Radio.Group value={d.newFolder ? 'new' : 'existing'} onChange={(v) => p.onChange({ newFolder: v === 'new' })}>
        <Group gap="lg">
          <Radio value="new" label="New folder" />
          <Radio value="existing" label="Existing folder" disabled={!folders?.length} />
        </Group>
      </Radio.Group>
      {d.newFolder ? (
        <Group grow align="flex-start">
          <TextInput
            label="Folder name"
            description="Letters, numbers, spaces and hyphens"
            value={d.folderName}
            onChange={(e) => p.onChange({ folderName: e.currentTarget.value })}
            maxLength={500}
            error={pathProblem ?? undefined}
          />
          <Select
            label="In the folder"
            description="Optional"
            placeholder={folders ? 'At the top' : 'Reading the folders…'}
            data={parentOptions}
            value={d.parentFolderId}
            onChange={(v) => p.onChange({ parentFolderId: v })}
            clearable
            searchable={(folders?.length ?? 0) > 8}
          />
        </Group>
      ) : (
        <Select
          label="Folder"
          description="A deck of the folder with a group's name gets that group's cards; the other groups get new decks."
          placeholder={folders ? (folders.length ? 'Pick a folder' : 'This account has no folder yet') : 'Reading the folders…'}
          data={folderOptions(folders ?? [])}
          value={d.folderId}
          onChange={(v) => p.onChange({ folderId: v })}
          disabled={!folders?.length || !!p.readingTarget}
          searchable={(folders?.length ?? 0) > 8}
        />
      )}
      <Select
        label="New decks' visibility"
        data={VISIBILITY}
        value={d.visibility}
        onChange={(v) => v && p.onChange({ visibility: v as BinderVisibility })}
        allowDeselect={false}
        w={200}
      />
      {facts.error ? (
        <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />} p="xs">
          <Group justify="space-between" gap="xs">
            <Text size="sm">{facts.error}</Text>
            <Button size="xs" variant="light" leftSection={<IconRefresh size={14} />} onClick={facts.retry}>
              Try again
            </Button>
          </Group>
        </Alert>
      ) : !facts.items ? (
        <Stack gap={4}>
          <Text size="sm">Reading each card's set, rarity and color identity from Scryfall…</Text>
          <PercentBar progress={facts.progress ?? { done: 0, total: 1 }} unit="page" />
        </Stack>
      ) : (
        <GroupingEditor
          items={facts.items}
          grouping={d.grouping}
          onChange={(grouping) => p.onChange({ grouping })}
          folderName={path || lastSegment(d.folderName) || 'Folder'}
          maxCards={p.maxDeckCards}
          existing={existing}
        />
      )}
    </Stack>
  );
}

/** A deck target: a new deck (name, visibility, folder), or an existing one (the cards are added to its mainboard). */
function DeckChoice({ p }: { p: TargetFormProps }) {
  const { draft: d, folders, decks } = p;
  return (
    <Stack gap="xs">
      <Radio.Group value={d.newDeck ? 'new' : 'existing'} onChange={(v) => p.onChange({ newDeck: v === 'new' })}>
        <Group gap="lg">
          <Radio value="new" label="New deck" />
          <Radio value="existing" label="Existing deck" disabled={!decks?.length || !!p.readingTarget} />
        </Group>
      </Radio.Group>
      {d.newDeck ? (
        <>
          <Group grow align="flex-start">
            <TextInput
              label="Deck name"
              value={d.deckName}
              onChange={(e) => p.onChange({ deckName: e.currentTarget.value })}
              maxLength={100}
              error={d.deckName.trim().length === 1 ? 'At least 2 characters' : undefined}
            />
            <Select label="Visibility" data={VISIBILITY} value={d.visibility} onChange={(v) => v && p.onChange({ visibility: v as BinderVisibility })} allowDeselect={false} />
          </Group>
          <Select
            label="In the folder"
            description="Optional"
            placeholder={folders ? 'No folder' : 'Reading the folders…'}
            data={folderOptions(folders ?? [])}
            value={d.deckFolderId}
            onChange={(v) => p.onChange({ deckFolderId: v })}
            clearable
            searchable={(folders?.length ?? 0) > 8}
          />
        </>
      ) : (
        <>
          <Select
            label="Deck"
            placeholder={decks ? (decks.length ? 'Pick a deck' : 'This account has no deck yet') : 'Reading the decks…'}
            data={deckOptions(decks ?? [])}
            value={d.deckId}
            onChange={(v) => p.onChange({ deckId: v, deckPublicId: decks?.find((x) => x.id === v)?.publicId ?? null })}
            disabled={!decks?.length || !!p.readingTarget}
            searchable
          />
        </>
      )}
      <Text size="xs" c="dimmed">
        The cards are added to the mainboard, each as its exact print and finish; an existing deck keeps its cards. A deck holds at most{' '}
        {p.maxDeckCards.toLocaleString('en-CA')} cards: a bigger export is refused (a deck folder can split it into several decks).
      </Text>
    </Stack>
  );
}

/** One target of the export: the account, then a binder (new or existing), the collection, a deck, or a deck folder. */
export function TargetForm(p: TargetFormProps) {
  const { site, draft: d, accounts, sourceAccountKey, binders } = p;
  const account = accounts.find((a) => a.key === d.accountKey) ?? null;
  const name = account ? accountLabel(account) : '';
  const same = !!d.accountKey && d.accountKey === sourceAccountKey && !p.sameNoted;
  const framed = p.count > 1;
  // Five kinds don't fit side by side on a phone.
  const orientation = useMatches<'vertical' | 'horizontal'>({ base: 'vertical', sm: 'horizontal' });
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
        onChange={(v) => v && v !== d.accountKey && p.onChange({ accountKey: v as AccountKey, binderId: null, deckId: null, deckPublicId: null, deckFolderId: null, folderId: null, parentFolderId: null })}
        allowDeselect={false}
        leftSection={<SiteIcon type={site.type} size={16} />}
        disabled={p.busy}
      />
      {same && (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />} p="xs">
          This is the account you're comparing. Its collection would change with the export: see the warning in the preview.
        </Alert>
      )}
      {(p.readingBinders || p.readingDecks) && (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Reading {name}'s {p.readingDecks ? 'decks and folders' : 'binders'} on {site.label}… (reads only)
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
        fullWidth
        orientation={orientation}
        value={d.kind}
        onChange={(v) => p.onChange({ kind: v as TargetDraft['kind'] })}
        disabled={!!p.readingTarget}
        data={[
          { value: 'newBinder', label: 'New binder', disabled: !site.capabilities.exportTo.binders },
          { value: 'binder', label: 'Existing binder', disabled: !site.capabilities.exportTo.binders },
          { value: 'collection', label: 'Collection', disabled: !site.capabilities.exportTo.collection },
          { value: 'deck', label: 'Deck', disabled: !site.capabilities.exportTo.decks },
          { value: 'folder', label: 'Deck folder', disabled: !site.capabilities.exportTo.decks },
        ]}
      />
      {d.kind === 'newBinder' && (
        <Group grow align="flex-start">
          <TextInput label="Binder name" value={d.binderName} onChange={(e) => p.onChange({ binderName: e.currentTarget.value })} maxLength={100} />
          <Select
            label="Visibility"
            data={VISIBILITY}
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
      {d.kind === 'deck' && <DeckChoice p={p} />}
      {d.kind === 'folder' && <FolderChoice p={p} />}
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
