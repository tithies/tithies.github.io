/** The run page's "Cards in decks" filter: the Comparator's decks panel (decks, boards, the deck sync it needs). */
import { Button, Divider, Group, Stack, Switch, Text } from '@mantine/core';
import { IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import type { AccountKey } from '@/lib/accounts/types';
import { DecksPanel } from '@/lib/decks/DecksPanel';
import { cancelSync, useSyncState } from '@/lib/decks/hooks';
import { StartError, useStartSync } from '@/lib/decks/StartSync';
import { SyncProgress } from '@/lib/decks/SyncProgress';
import type { CollectionMeta, DeckRow, DecksMeta } from '@/lib/decks/types';
import type { SiteProvider } from '@/lib/sites/provider';
import { useInitialSync } from '@/lib/ui/InitialSync';
import type { SellingDeckFilter } from '../deck-filter';
import type { FreeCopiesSummary } from '../in-decks';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-CA')} ${n === 1 ? one : many}`;

/** Before the first sync: syncs the account's decks, then its collection (the counts the filter needs). */
function SyncDecks({ accountKey, site }: { accountKey: AccountKey; site: SiteProvider }) {
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
          Sync decks and collection
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
  const synced = Boolean(decksMeta?.lastSuccessAt);

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
            <SyncDecks accountKey={accountKey} site={site} />
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
            <DecksPanel
              accountKey={accountKey}
              site={site}
              decks={decks ?? []}
              decksMeta={decksMeta}
              collection={collection}
              boards={boards}
              choices={config}
              onChange={update}
              title={
                <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                  Decks
                </Text>
              }
              maxHeight={320}
              note="These options are saved for every run of this account, apart from the Comparator's."
            />
          </>
        ))}
    </Stack>
  );
}
