/** The run page's "Cards in decks" filter: decks, boards and proxies, and the deck sync it needs. */
import { Anchor, Button, Divider, Group, SimpleGrid, Stack, Switch, Text } from '@mantine/core';
import { IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import { accountData } from '@/lib/accounts/data';
import type { AccountKey } from '@/lib/accounts/types';
import { BoardCheckboxes } from '@/lib/decks/BoardCheckboxes';
import { DeckTreePicker } from '@/lib/decks/DeckTreePicker';
import { cancelSync, useFolderUrl, useSyncState } from '@/lib/decks/hooks';
import { StartError, useStartSync } from '@/lib/decks/StartSync';
import { SyncProgress } from '@/lib/decks/SyncProgress';
import { markDecksSeen } from '@/lib/decks/sync';
import type { CollectionMeta, DeckRow, DecksMeta } from '@/lib/decks/types';
import { timeAgo } from '@/lib/format';
import type { SiteProvider } from '@/lib/sites/provider';
import { useInitialSync } from '@/lib/ui/InitialSync';
import type { SellingDeckFilter } from '../deck-filter';
import type { FreeCopiesSummary } from '../in-decks';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;

/** Syncs the account's decks, then what changed in its collection (the counts the filter needs). */
function SyncDecks({ accountKey, site, label }: { accountKey: AccountKey; site: SiteProvider; label: string }) {
  const sync = useSyncState(accountKey);
  const { start, error, starting, clearError } = useStartSync(site.type, accountKey);
  const { switchToIdentity } = useInitialSync();
  const running = sync?.status === 'running' || starting;
  return (
    <Stack gap="xs">
      <SyncProgress state={sync} site={site} onSwitch={(who) => switchToIdentity(site.type, who)} />
      {error && <StartError error={error} type={site.type} onCancelled={clearError} />}
      <Group gap="xs">
        <Button size="xs" leftSection={<IconRefresh size={14} />} loading={running} onClick={() => void start(true)}>
          {label}
        </Button>
        {running && (
          <Button size="xs" variant="subtle" color="gray" leftSection={<IconPlayerStop size={14} />} onClick={() => void cancelSync(site.type)}>
            Cancel
          </Button>
        )}
      </Group>
    </Stack>
  );
}

function SummaryLine({ summary, collection }: { summary: FreeCopiesSummary; collection: CollectionMeta | null | undefined }) {
  const { hiddenPrints, reducedPrints, hiddenCopies, decksWithoutCards } = summary;
  return (
    <Stack gap={2}>
      <Text size="sm">
        {hiddenCopies === 0
          ? 'No copy of this run is used by the included decks.'
          : `${plural(hiddenCopies, 'copy', 'copies')} in decks: ${plural(hiddenPrints, 'print')} left out, ${plural(reducedPrints, 'print')} with fewer copies (“of N” in the Qty column).`}
      </Text>
      {decksWithoutCards > 0 && (
        <Text size="xs" c="yellow">
          {plural(decksWithoutCards, 'included deck')} {decksWithoutCards === 1 ? "hasn't" : "haven't"} been read yet (sync unfinished or failed): their cards are not
          counted.
        </Text>
      )}
      {!collection && (
        <Text size="xs" c="dimmed">
          Your collection was never read: copies are counted from this run only, so a deck's copy is taken as one of the run's.
        </Text>
      )}
    </Stack>
  );
}

export function DeckFilter({
  accountKey,
  site,
  config,
  update,
  decks,
  decksMeta,
  collection,
  boards,
  summary,
}: {
  accountKey: AccountKey;
  site: SiteProvider;
  config: SellingDeckFilter;
  update: (patch: Partial<SellingDeckFilter>) => void;
  decks: DeckRow[] | undefined;
  decksMeta: DecksMeta | undefined;
  collection: CollectionMeta | null | undefined;
  /** Copies per board (`boardCopies`). */
  boards: Map<string, number>;
  /** null while the decks load. */
  summary: FreeCopiesSummary | null;
}) {
  const folderUrl = useFolderUrl(decks, decksMeta?.folders, site);
  const synced = Boolean(decksMeta?.lastSuccessAt);
  const newDecks = (decks ?? []).filter((d) => d.isNew);
  const deckIds = new Set((decks ?? []).map((d) => d.id));

  return (
    <Stack gap="sm" mt="sm">
      <Divider label="Cards in decks" labelPosition="left" />
      <Switch
        label="Hide copies used in decks"
        description="Keeps the copies no included deck uses: a print whose copies are all in decks is left out, others keep their free copies (and the totals above count only those). Compared by exact print like the Comparator, against your whole collection. Deck proxies don't count: they use no copy of your collection."
        checked={config.enabled}
        onChange={(e) => update({ enabled: e.currentTarget.checked })}
      />
      {config.enabled &&
        (decksMeta === undefined ? (
          <Text size="sm" c="dimmed">
            Loading decks…
          </Text>
        ) : !synced ? (
          <Stack gap="xs">
            <Text size="sm">
              Tithies hasn't read your {site.label} decks yet. Sync them once, with your collection (about 6 minutes for ~270 decks); later syncs only read what
              changed.
            </Text>
            <SyncDecks accountKey={accountKey} site={site} label="Sync decks and collection" />
          </Stack>
        ) : (
          <>
            {summary ? (
              <SummaryLine summary={summary} collection={collection} />
            ) : (
              <Text size="sm" c="dimmed">
                Loading decks…
              </Text>
            )}
            <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
              <Stack gap="xs">
                <Group justify="space-between">
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                    Decks
                  </Text>
                  {newDecks.length > 0 && (
                    <Group gap={6}>
                      <Text size="xs" c="green">
                        {plural(newDecks.length, 'new deck')} (included)
                      </Text>
                      <Anchor size="xs" component="button" type="button" onClick={() => void markDecksSeen(accountData(accountKey))}>
                        Mark as seen
                      </Anchor>
                    </Group>
                  )}
                </Group>
                <DeckTreePicker
                  decks={decks ?? []}
                  excluded={new Set(config.excludedDeckIds)}
                  onChange={(next) => update({ excludedDeckIds: [...next].filter((id) => deckIds.has(id)) })}
                  siteLabel={site.label}
                  folderUrl={folderUrl}
                  maxHeight={320}
                />
              </Stack>
              <Stack gap="sm">
                <BoardCheckboxes boards={boards} ignoredBoards={config.ignoredBoards} onChange={(ignoredBoards) => update({ ignoredBoards })} site={site} />
                <Text size="xs" c="dimmed">
                  Decks synced {decksMeta.lastSuccessAt ? timeAgo(decksMeta.lastSuccessAt) : 'never'} · Collection read {collection ? timeAgo(collection.fetchedAt) : 'never'}
                </Text>
                <SyncDecks accountKey={accountKey} site={site} label="Sync decks and collection" />
                <Text size="xs" c="dimmed">
                  Syncs decks (only new or changed ones are read), then what changed in your collection. These options are saved for every run of this account,
                  apart from the Comparator's.
                </Text>
              </Stack>
            </SimpleGrid>
          </>
        ))}
    </Stack>
  );
}
