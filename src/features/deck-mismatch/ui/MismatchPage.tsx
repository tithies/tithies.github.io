import { Alert, Anchor, Button, Checkbox, Divider, Group, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconArrowsDiff, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { DeckTreePicker } from '@/lib/decks/DeckTreePicker';
import { cancelSync, startSync, useCollectionMeta, useDeckData, useDecks, useDecksMeta, useSyncState } from '@/lib/decks/hooks';
import { GettingStarted } from '@/lib/ui/GettingStarted';
import { markDecksSeen } from '@/lib/decks/sync';
import type { DeckCardsRow, DeckRow } from '@/lib/decks/types';
import { timeAgo } from '@/lib/format';
import { siteOf } from '@/lib/sites/registry';
import { Stat } from '@/lib/ui/Stat';
import { compareDecksToCollection } from '../compare';
import { useMismatchConfig, type MismatchConfig } from '../config';
import { mismatchFiltersFromParams, mismatchSortFromParams, writeMismatchParams } from '../filtering';
import { MismatchTable } from './MismatchTable';
import { SyncProgress } from './SyncProgress';

/** The site whose decks are compared. */
const site = siteOf('moxfield');

/** Boards always offered, even before any deck uses them. */
const BASE_BOARDS = ['commanders', 'mainboard', 'sideboard', 'maybeboard'];

function useStartSync() {
  const [error, setError] = useState<string | null>(null);
  const start = async (collection: boolean) => {
    setError(null);
    try {
      await startSync(site.type, collection);
    } catch (e) {
      setError(`Couldn't start the sync: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  return { start, error };
}

function FirstSync({ decks }: { decks: DeckRow[] }) {
  const sync = useSyncState();
  const { start, error } = useStartSync();
  const running = sync?.status === 'running';
  const partial = decks.filter((d) => d.cardsUpdatedAt).length;
  return (
    <GettingStarted title={`First, sync your ${site.label} decks`}>
      <Text size="sm">
        Tithies reads your deck list, then every deck's cards, and keeps them here. Later syncs only read decks you changed or added
        (using each deck's last-updated time), so they take seconds.
      </Text>
      <Text size="sm" c="dimmed">
        You must be logged in to {site.label} in this browser. If no logged-in {site.label} tab is open, Tithies opens one (shown for a few seconds while {site.label} starts, then it switches back here) and closes it at the end.
        Requests go one at a time, about one per second, so a first sync of ~270 decks takes about 6 minutes. You can leave this page meanwhile.
      </Text>
      {partial > 0 && !running && (
        <Text size="sm" c="yellow">
          {partial} of {decks.length} decks were already read by an earlier, unfinished sync; syncing again continues from there.
        </Text>
      )}
      <SyncProgress state={sync} site={site} />
      {error && (
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          {error}
        </Alert>
      )}
      <Group>
        <Button leftSection={<IconRefresh size={16} />} loading={running} onClick={() => void start(false)}>
          Sync decks
        </Button>
        {running && (
          <Button variant="default" leftSection={<IconPlayerStop size={16} />} onClick={() => void cancelSync(site.type)}>
            Cancel
          </Button>
        )}
      </Group>
    </GettingStarted>
  );
}

/** Copies per board across every cached deck (to list only boards that exist). */
function boardCopies(deckCards: DeckCardsRow[]): Map<string, number> {
  const m = new Map<string, number>(BASE_BOARDS.map((b) => [b, 0]));
  for (const row of deckCards) for (const c of row.cards) m.set(c.board, (m.get(c.board) ?? 0) + c.qty);
  return m;
}

function OptionsCard({
  config,
  update,
  boards,
  decksSyncedAt,
  collectionAt,
}: {
  config: MismatchConfig;
  update: (p: Partial<MismatchConfig>) => void;
  boards: Map<string, number>;
  decksSyncedAt?: number;
  collectionAt?: number;
}) {
  const sync = useSyncState();
  const { start, error } = useStartSync();
  const running = sync?.status === 'running';
  const ignored = new Set(config.ignoredBoards);
  const boardKeys = [...boards.keys()].filter((b) => BASE_BOARDS.includes(b) || (boards.get(b) ?? 0) > 0).sort((a, b) => site.boardOrder(a) - site.boardOrder(b));
  const toggleBoard = (b: string, count: boolean) => update({ ignoredBoards: count ? config.ignoredBoards.filter((x) => x !== b) : [...ignored, b] });

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Title order={4}>Options</Title>
        <Stack gap={6}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Show
          </Text>
          <Checkbox
            label="Deck cards missing from the collection"
            description="Copies used in decks that the collection doesn't have (exact print)"
            checked={config.showMissing}
            onChange={(e) => update({ showMissing: e.currentTarget.checked })}
          />
          <Checkbox
            label="Collection cards not in any deck"
            description="Copies in the collection that no included deck uses"
            checked={config.showUnassigned}
            onChange={(e) => update({ showUnassigned: e.currentTarget.checked })}
          />
        </Stack>
        <Stack gap={6}>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
            Deck boards counted
          </Text>
          <Group gap="md">
            {boardKeys.map((b) => (
              <Checkbox
                key={b}
                size="sm"
                label={
                  <>
                    {site.boardLabel(b)}{' '}
                    <Text span size="xs" c="dimmed" className="ti-num">
                      {boards.get(b) ?? 0}
                    </Text>
                  </>
                }
                checked={!ignored.has(b)}
                onChange={(e) => toggleBoard(b, e.currentTarget.checked)}
              />
            ))}
          </Group>
        </Stack>
        <Checkbox
          label="Ignore proxies"
          description="Proxy copies are left out on both sides"
          checked={config.ignoreProxies}
          onChange={(e) => update({ ignoreProxies: e.currentTarget.checked })}
        />
        <Divider />
        <Text size="xs" c="dimmed">
          Decks synced {decksSyncedAt ? timeAgo(decksSyncedAt) : 'never'} · Collection read {collectionAt ? timeAgo(collectionAt) : 'never'}
        </Text>
        <SyncProgress state={sync} site={site} />
        {error && (
          <Alert color="red" icon={<IconAlertTriangle size={18} />}>
            {error}
          </Alert>
        )}
        <Group gap="xs">
          {/* During a decks-only sync this joins it: the collection is read right after the decks. */}
          <Button leftSection={<IconArrowsDiff size={16} />} loading={running && sync?.withCollection} onClick={() => void start(true)}>
            Find mismatches
          </Button>
          <Button variant="default" leftSection={<IconRefresh size={16} />} disabled={running} onClick={() => void start(false)}>
            Sync decks only
          </Button>
          {running && (
            <Button variant="subtle" color="gray" leftSection={<IconPlayerStop size={16} />} onClick={() => void cancelSync(site.type)}>
              Cancel
            </Button>
          )}
        </Group>
        <Text size="xs" c="dimmed">
          Find mismatches first syncs decks (only new or changed ones are read), then reads your whole collection. Options and deck choices apply instantly.
        </Text>
      </Stack>
    </Paper>
  );
}

export function MismatchPage() {
  const decks = useDecks();
  const decksMeta = useDecksMeta();
  const sync = useSyncState();
  const collectionMeta = useCollectionMeta();
  const { config, update } = useMismatchConfig();
  // The "Likely wrong print" card toggles the table's filter of the same name (kept in the URL).
  const [params, setParams] = useSearchParams();
  const hintedOnly = params.get('hint') === '1';
  const toggleHinted = () => {
    const f = mismatchFiltersFromParams(params);
    setParams(writeMismatchParams(params, { ...f, hinted: !f.hinted }, mismatchSortFromParams(params), 1), { replace: true });
  };

  // Big tables are reloaded when a sync job ends, not on every deck it writes.
  const version = `${sync?.jobId ?? ''}:${sync?.status === 'running' ? 'running' : 'idle'}:${collectionMeta?.fetchedAt ?? 0}:${decksMeta?.lastSuccessAt ?? 0}`;
  const { deckCards, collection, loaded } = useDeckData(version);

  const deckById = useMemo(() => new Map((decks ?? []).map((d) => [d.id, d])), [decks]);
  // The comparison only needs deck ids; names are looked up at render time.
  const deckIdsKey = (decks ?? []).map((d) => d.id).join(',');
  const stableDecks = useMemo(() => decks ?? [], [deckIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const excluded = useMemo(() => new Set(config?.excludedDeckIds ?? []), [config?.excludedDeckIds]);
  const boards = useMemo(() => boardCopies(deckCards), [deckCards]);

  const collectionAt = collectionMeta?.fetchedAt;
  const fresh = useMemo(
    () =>
      config && loaded && collectionAt
        ? compareDecksToCollection(stableDecks, deckCards, collection, {
            excludedDeckIds: config.excludedDeckIds,
            ignoredBoards: config.ignoredBoards,
            ignoreProxies: config.ignoreProxies,
          })
        : null,
    [config, loaded, collectionAt, stableDecks, deckCards, collection],
  );
  // While new data loads, keep showing the previous (consistent) result rather than blinking.
  const previous = useRef(fresh);
  if (fresh) previous.current = fresh;
  const result = fresh ?? previous.current;
  const shown = useMemo(
    () => (result && config ? result.rows.filter((r) => (r.kind === 'missing' ? config.showMissing : config.showUnassigned)) : []),
    [result, config],
  );

  if (decks === undefined || decksMeta === undefined || config === null) return <Text c="dimmed">Loading…</Text>;

  const header = (
    <Stack gap={4}>
      <Title order={2}>Deck ↔ collection mismatches</Title>
      <Text size="sm" c="dimmed">
        Every deck card should be in your collection, and every collection card in a deck. Compared by exact print (set, collector number and finish);
        copies used by several decks add up.
      </Text>
    </Stack>
  );

  if (!decksMeta.lastSuccessAt) {
    return (
      <Stack>
        {header}
        <FirstSync decks={decks} />
      </Stack>
    );
  }

  const newDecks = decks.filter((d) => d.isNew);
  const s = result?.summary;

  return (
    <Stack>
      {header}
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Paper withBorder p="md" radius="md">
          <Stack gap="xs">
            <Group justify="space-between">
              <Title order={4}>Decks</Title>
              {newDecks.length > 0 && (
                <Group gap={6}>
                  <Text size="xs" c="green">
                    {newDecks.length} new deck{newDecks.length === 1 ? '' : 's'} (included)
                  </Text>
                  <Anchor size="xs" component="button" type="button" onClick={() => void markDecksSeen()}>
                    Mark as seen
                  </Anchor>
                </Group>
              )}
            </Group>
            <DeckTreePicker
              decks={decks}
              excluded={excluded}
              onChange={(next) => update({ excludedDeckIds: [...next].filter((id) => deckById.has(id)) })}
              siteLabel={site.label}
            />
          </Stack>
        </Paper>
        <OptionsCard config={config} update={update} boards={boards} decksSyncedAt={decksMeta.lastSuccessAt} collectionAt={collectionMeta?.fetchedAt} />
      </SimpleGrid>

      {!collectionMeta ? (
        <Paper withBorder p="lg" radius="md">
          <Text c="dimmed">Click “Find mismatches” to read your collection and compare it with the selected decks.</Text>
        </Paper>
      ) : (
        <>
          {s && (
            <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }}>
              <Stat
                label="Missing from collection"
                value={`${s.missingCopies} copies`}
                color={config.showMissing ? 'red' : 'dimmed'}
                lines={[`${s.missingPrints} prints`, !config.showMissing && 'Hidden: click to show'].filter(Boolean) as string[]}
                onClick={() => update({ showMissing: !config.showMissing })}
                active={config.showMissing}
                activeSuffix=" · shown"
                hint={config.showMissing ? 'Hide these rows' : 'Show these rows'}
              />
              <Stat
                label="Not in any deck"
                value={`${s.unassignedCopies} copies`}
                color={config.showUnassigned ? 'orange' : 'dimmed'}
                lines={[`${s.unassignedPrints} prints`, !config.showUnassigned && 'Hidden: click to show'].filter(Boolean) as string[]}
                onClick={() => update({ showUnassigned: !config.showUnassigned })}
                active={config.showUnassigned}
                activeSuffix=" · shown"
                hint={config.showUnassigned ? 'Hide these rows' : 'Show these rows'}
              />
              <Stat
                label="Likely wrong print"
                value={String(s.hinted)}
                color="yellow"
                lines={['Same card is mismatched the other way in another print or finish']}
                onClick={toggleHinted}
                active={hintedOnly}
                hint={hintedOnly ? 'Show every row' : 'Show only these rows'}
              />
              <Stat
                label="Compared"
                value={`${s.decksIncluded} decks`}
                lines={[
                  `${s.deckCopies} deck copies · ${s.collectionCopies} collection copies`,
                  `${s.matchedCopies} copies match`,
                  s.proxiesSkipped.decks + s.proxiesSkipped.collection > 0 &&
                    `Proxies ignored: ${s.proxiesSkipped.decks} in decks, ${s.proxiesSkipped.collection} in collection`,
                  s.nonPaperSkipped > 0 && `${s.nonPaperSkipped} MTGO/Arena copies ignored`,
                ].filter(Boolean) as string[]}
              />
            </SimpleGrid>
          )}
          {s && s.decksWithoutCards > 0 && (
            <Alert color="yellow" icon={<IconAlertTriangle size={18} />} p="xs">
              {s.decksWithoutCards} included deck{s.decksWithoutCards === 1 ? " hasn't" : "s haven't"} been read yet (sync unfinished or failed): their cards are
              not counted.
            </Alert>
          )}
          <MismatchTable
            rows={shown}
            decks={deckById}
            boardLabel={site.boardLabel}
            loading={!loaded}
            emptyText={config.showMissing || config.showUnassigned ? 'No mismatches: decks and collection agree' : 'Both “Show” options are off'}
          />
        </>
      )}
    </Stack>
  );
}
