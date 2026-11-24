/**
 * The decks to compare with the collection, shared by the Comparator and the Selling runs' "Cards in decks" filter:
 * new decks, the sync bar (Sync decks and collection, the Options popover with the boards counted, when both were
 * last read) and the folder tree.
 */
import { Anchor, Badge, Button, Group, Popover, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconAdjustmentsHorizontal, IconInfoCircle, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import { useMemo, type ReactNode } from 'react';
import { accountData } from '@/lib/accounts/data';
import type { AccountKey } from '@/lib/accounts/types';
import { timeAgo } from '@/lib/format';
import type { SiteProvider } from '@/lib/sites/provider';
import { useInitialSync } from '@/lib/ui/InitialSync';
import { BoardCheckboxes, boardsShown } from './BoardCheckboxes';
import { DeckTreePicker } from './DeckTreePicker';
import { cancelSync, useFolderUrl, useSyncState } from './hooks';
import { StartError, useStartSync } from './StartSync';
import { lastSyncText, SyncProgress } from './SyncProgress';
import { markDecksSeen } from './sync';
import type { CollectionMeta, DeckRow, DecksMeta } from './types';

/** The deck options a page keeps (both pages store them under these names). */
export interface DeckChoices {
  ignoredBoards: string[];
  excludedDeckIds: string[];
}

/** The Options button: a popover with the deck boards counted. */
function OptionsPopover({
  boards,
  ignoredBoards,
  onChange,
  site,
}: {
  boards: Map<string, number>;
  ignoredBoards: readonly string[];
  onChange(ignoredBoards: string[]): void;
  site: SiteProvider;
}) {
  const off = boardsShown(boards).filter((b) => ignoredBoards.includes(b)).length;
  return (
    <Popover position="bottom-start" shadow="md" withArrow>
      <Popover.Target>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconAdjustmentsHorizontal size={14} />}
          rightSection={off ? <Badge size="xs" variant="light">{off} off</Badge> : null}
        >
          Options
        </Button>
      </Popover.Target>
      <Popover.Dropdown maw="min(480px, calc(100vw - 24px))">
        <BoardCheckboxes boards={boards} ignoredBoards={ignoredBoards} onChange={onChange} site={site} />
      </Popover.Dropdown>
    </Popover>
  );
}

/** How the last collection read went, for the sync line's tooltip. */
function lastReadText(collection: CollectionMeta | null | undefined): string | null {
  const r = collection?.lastRead;
  if (r?.mode === 'changes') {
    const entries = `${r.changed.toLocaleString('en-CA')} ${r.changed === 1 ? 'entry' : 'entries'}`;
    const requests = r.pages === 1 ? '1 request' : `${r.pages} requests`;
    return `Last collection read: only what changed (${entries} in ${requests}); every page read ${collection?.fullReadAt ? timeAgo(collection.fullReadAt) : 'never'}.`;
  }
  if (r?.mode === 'full') return `Last collection read: every page${r.why ? ` (${r.why})` : ''}.`;
  return null;
}

/** Sync decks and collection, the Options popover, and when both were last read (details in a tooltip). */
function SyncBar({
  accountKey,
  site,
  decksSyncedAt,
  collection,
  boards,
  ignoredBoards,
  onBoardsChange,
  note,
}: {
  accountKey: AccountKey;
  site: SiteProvider;
  decksSyncedAt?: number;
  collection: CollectionMeta | null | undefined;
  boards: Map<string, number>;
  ignoredBoards: readonly string[];
  onBoardsChange(ignoredBoards: string[]): void;
  note?: string;
}) {
  const sync = useSyncState(accountKey);
  const { start, error, starting, clearError } = useStartSync(site.type, accountKey);
  const { switchToIdentity } = useInitialSync();
  const running = sync?.status === 'running' || starting;
  const lastSync = sync?.status === 'done' ? lastSyncText(sync, site.label) : null;
  const lastRead = lastReadText(collection);

  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="wrap">
        {/* During a decks-only sync this joins it: the collection is read right after the decks. */}
        <Button
          size="xs"
          leftSection={<IconRefresh size={14} />}
          loading={starting || (sync?.status === 'running' && sync.withCollection)}
          onClick={() => void start(true)}
        >
          Sync decks and collection
        </Button>
        {running && (
          <Button size="xs" variant="subtle" color="gray" leftSection={<IconPlayerStop size={14} />} onClick={() => void cancelSync(site.type)}>
            Cancel
          </Button>
        )}
        <OptionsPopover boards={boards} ignoredBoards={ignoredBoards} onChange={onBoardsChange} site={site} />
        <Text size="xs" c="dimmed">
          Decks synced {decksSyncedAt ? timeAgo(decksSyncedAt) : 'never'} · collection read {collection ? timeAgo(collection.fetchedAt) : 'never'}{' '}
          <Tooltip
            label={
              <Stack gap={4}>
                {lastSync && <span>{lastSync}.</span>}
                {lastRead && <span>{lastRead}</span>}
                <span>
                  A sync reads only new or changed decks, then what changed in your collection (every page once a week, or after a deletion). Options and
                  deck choices apply instantly.
                </span>
                {note && <span>{note}</span>}
              </Stack>
            }
            multiline
            w={320}
          >
            <IconInfoCircle size={14} style={{ verticalAlign: 'text-bottom', cursor: 'help' }} aria-label="About the last sync" />
          </Tooltip>
          {collection && (
            <>
              {' · '}
              <Tooltip
                label={`A sync usually reads only what changed in your collection since the last read (${site.label} lists entries by last change), and every page when its totals don't match. This reads every page now.`}
                multiline
                w={300}
              >
                <Anchor component="button" type="button" size="xs" disabled={running} onClick={() => void start(true, true)}>
                  Read every page
                </Anchor>
              </Tooltip>
            </>
          )}
        </Text>
      </Group>
      <SyncProgress state={sync} site={site} onSwitch={(who) => switchToIdentity(site.type, who)} lastLine={false} />
      {error && <StartError error={error} type={site.type} onCancelled={clearError} />}
    </Stack>
  );
}

export function DecksPanel({
  accountKey,
  site,
  decks,
  decksMeta,
  collection,
  boards,
  choices,
  onChange,
  title = <Title order={4}>Decks</Title>,
  maxHeight,
  note,
}: {
  accountKey: AccountKey;
  site: SiteProvider;
  decks: DeckRow[];
  decksMeta: DecksMeta | undefined;
  collection: CollectionMeta | null | undefined;
  /** Copies per board (`boardCopies`). */
  boards: Map<string, number>;
  choices: DeckChoices;
  onChange(patch: Partial<DeckChoices>): void;
  title?: ReactNode;
  /** The tree's height before it scrolls. */
  maxHeight?: number;
  /** One more line for the sync line's tooltip. */
  note?: string;
}) {
  const folderUrl = useFolderUrl(decks, decksMeta?.folders, site);
  const excluded = useMemo(() => new Set(choices.excludedDeckIds), [choices.excludedDeckIds]);
  const deckIds = useMemo(() => new Set(decks.map((d) => d.id)), [decks]);
  const newDecks = decks.filter((d) => d.isNew).length;

  return (
    <Stack gap="xs">
      <Group justify="space-between">
        {title}
        {newDecks > 0 && (
          <Group gap={6}>
            <Text size="xs" c="green">
              {newDecks} new deck{newDecks === 1 ? '' : 's'} (included)
            </Text>
            <Anchor size="xs" component="button" type="button" onClick={() => void markDecksSeen(accountData(accountKey))}>
              Mark as seen
            </Anchor>
          </Group>
        )}
      </Group>
      <SyncBar
        accountKey={accountKey}
        site={site}
        decksSyncedAt={decksMeta?.lastSuccessAt}
        collection={collection}
        boards={boards}
        ignoredBoards={choices.ignoredBoards}
        onBoardsChange={(ignoredBoards) => onChange({ ignoredBoards })}
        note={note}
      />
      <DeckTreePicker
        decks={decks}
        excluded={excluded}
        onChange={(next) => onChange({ excludedDeckIds: [...next].filter((id) => deckIds.has(id)) })}
        siteLabel={site.label}
        folderUrl={folderUrl}
        maxHeight={maxHeight}
      />
    </Stack>
  );
}
