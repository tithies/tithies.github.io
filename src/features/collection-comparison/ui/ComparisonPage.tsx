import { Alert, Anchor, Button, Checkbox, Divider, Group, Modal, Paper, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconArrowsDiff, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import { useMemo, useRef, useState } from 'react';
import { useBlocker, useSearchParams } from 'react-router';
import { useExportList } from '@/lib/export/list';
import { exportSummary, ExportBar } from '@/lib/export/ui/ExportBar';
import { ExportDialog } from '@/lib/export/ui/ExportDialog';
import { accountLabel } from '@/lib/accounts/types';
import { DeckTreePicker } from '@/lib/decks/DeckTreePicker';
import { cancelSync, startSync, useCollectionMeta, useDeckData, useDecks, useDecksMeta, useSyncState } from '@/lib/decks/hooks';
import { GettingStarted } from '@/lib/ui/GettingStarted';
import { markDecksSeen } from '@/lib/decks/sync';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { accountData, addAccountFromAction } from '@/lib/accounts/data';
import { AccountHint } from '@/lib/ui/AccountHint';
import type { AccountKey } from '@/lib/accounts/types';
import type { SiteProvider } from '@/lib/sites/provider';
import type { CollectionMeta, DeckCardsRow, DeckRow } from '@/lib/decks/types';
import { timeAgo } from '@/lib/format';
import { siteOf } from '@/lib/sites/registry';
import { Stat } from '@/lib/ui/Stat';
import { compareDecksToCollection } from '../compare';
import { useComparisonConfig, type ComparisonConfig } from '../config';
import { PresetBar } from './PresetBar';
import { comparisonFiltersFromParams, comparisonSortFromParams, writeComparisonParams } from '../filtering';
import { ComparisonTable } from './ComparisonTable';
import { SyncProgress } from './SyncProgress';

/** The current account, and the site its decks come from (Moxfield before any account exists). */
function usePageAccount(): { key: AccountKey | null; site: SiteProvider } {
  const { key, account } = useCurrentAccount();
  return { key, site: siteOf(account?.type ?? 'moxfield') };
}

/** Boards always offered, even before any deck uses them. */
const BASE_BOARDS = ['commanders', 'mainboard', 'sideboard', 'maybeboard'];

/**
 * Starts (or joins) the current account's sync. Without an account, syncs whoever is logged in on
 * the site: that account is added and becomes current (the page then shows it).
 */
function useStartSync() {
  const { key, site } = usePageAccount();
  const [error, setError] = useState<{ message: string; busy: boolean } | null>(null);
  const [starting, setStarting] = useState(false);
  const start = async (collection: boolean, fullCollection = false) => {
    setError(null);
    setStarting(true);
    try {
      const res = await startSync(site.type, key, collection, fullCollection);
      if (!res.ok && res.code !== 'cancelled') setError({ message: res.error, busy: res.code === 'busy' });
    } catch (e) {
      setError({ message: `Couldn't start the sync: ${e instanceof Error ? e.message : String(e)}`, busy: false });
    } finally {
      setStarting(false);
    }
  };
  return { start, error, starting, clearError: () => setError(null) };
}

/** Why a sync couldn't start; when another account's sync is running, offer to cancel it. */
function StartError({ error, site, onCancelled }: { error: { message: string; busy: boolean }; site: SiteProvider; onCancelled: () => void }) {
  return (
    <Alert color={error.busy ? 'yellow' : 'red'} icon={<IconAlertTriangle size={18} />}>
      <Group justify="space-between" gap="xs">
        <Text size="sm">{error.message}</Text>
        {error.busy && (
          <Button size="xs" variant="light" color="yellow" onClick={() => void cancelSync(site.type).then(onCancelled)}>
            Cancel the other sync
          </Button>
        )}
      </Group>
    </Alert>
  );
}

/** Switching after a sync stopped because the site is logged in as someone else (an action: adds the account if needed). */
const switchTo = (site: SiteProvider) => (who: { userId: string; userName: string }) => void addAccountFromAction(site.type, who);

function FirstSync({ decks }: { decks: DeckRow[] }) {
  const { key, site } = usePageAccount();
  const sync = useSyncState(key);
  const { start, error, starting, clearError } = useStartSync();
  const running = sync?.status === 'running' || starting;
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
      <SyncProgress state={sync} site={site} onSwitch={switchTo(site)} />
      {error && <StartError error={error} site={site} onCancelled={clearError} />}
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
  collection,
}: {
  config: ComparisonConfig;
  update: (p: Partial<ComparisonConfig>) => void;
  boards: Map<string, number>;
  decksSyncedAt?: number;
  collection?: CollectionMeta | null;
}) {
  const { key, site } = usePageAccount();
  const sync = useSyncState(key);
  const { start, error, starting, clearError } = useStartSync();
  const running = sync?.status === 'running' || starting;
  const ignored = new Set(config.ignoredBoards);
  const boardKeys = [...boards.keys()].filter((b) => BASE_BOARDS.includes(b) || (boards.get(b) ?? 0) > 0).sort((a, b) => site.boardOrder(a) - site.boardOrder(b));
  const toggleBoard = (b: string, count: boolean) => update({ ignoredBoards: count ? config.ignoredBoards.filter((x) => x !== b) : [...ignored, b] });

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <Title order={4}>Options</Title>
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
          Decks synced {decksSyncedAt ? timeAgo(decksSyncedAt) : 'never'} · Collection read {collection ? timeAgo(collection.fetchedAt) : 'never'}
          {collection?.lastRead?.mode === 'changes' && (
            <>
              {' '}
              (only what changed: {collection.lastRead.changed.toLocaleString('en-CA')} {collection.lastRead.changed === 1 ? 'entry' : 'entries'} in{' '}
              {collection.lastRead.pages === 1 ? '1 request' : `${collection.lastRead.pages} requests`}; every page read {collection.fullReadAt ? timeAgo(collection.fullReadAt) : 'never'})
            </>
          )}
          {collection?.lastRead?.mode === 'full' && (
            <>
              {' '}
              (every page{collection.lastRead.why ? `: ${collection.lastRead.why}` : ''})
            </>
          )}
          {collection && (
            <>
              {' · '}
              <Tooltip
                label="Compare usually reads only what changed in your collection since the last read (Moxfield lists entries by last change), and every page when its totals don't match. This reads every page now."
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
        <SyncProgress state={sync} site={site} onSwitch={switchTo(site)} />
        {error && <StartError error={error} site={site} onCancelled={clearError} />}
        <Group gap="xs">
          {/* During a decks-only sync this joins it: the collection is read right after the decks. */}
          <Button leftSection={<IconArrowsDiff size={16} />} loading={running && sync?.withCollection} onClick={() => void start(true)}>
            Compare
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
          Compare first syncs decks (only new or changed ones are read), then reads what changed in your collection (every page once a week, or when
          something was deleted). Options, presets and deck choices apply instantly.
        </Text>
      </Stack>
    </Paper>
  );
}

/** Leaving the page clears what it was going to export: ask first. */
function LeaveGuard({ prints, summary }: { prints: number; summary: string }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => prints > 0 && currentLocation.pathname !== nextLocation.pathname);
  return (
    <Modal opened={blocker.state === 'blocked'} onClose={() => blocker.reset?.()} title="Leave this page?" centered>
      <Stack>
        <Text size="sm">The cards to export ({summary}) only live on this page: leaving clears them.</Text>
        <Group justify="flex-end">
          <Button variant="default" onClick={() => blocker.reset?.()}>
            Stay
          </Button>
          <Button color="red" onClick={() => blocker.proceed?.()}>
            Leave and clear the export
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}

export function ComparisonPage() {
  const { key, site } = usePageAccount();
  const { account } = useCurrentAccount();
  const exportList = useExportList();
  const [exporting, setExporting] = useState(false);
  const decks = useDecks(key);
  const decksMeta = useDecksMeta(key);
  const sync = useSyncState(key);
  const collectionMeta = useCollectionMeta(key);
  const presets = useComparisonConfig(key);
  const { state, config, update } = presets;
  // The "Likely wrong print" card toggles the table's filter of the same name (kept in the URL).
  const [params, setParams] = useSearchParams();
  const hintedOnly = params.get('hint') === '1';
  const toggleHinted = () => {
    const f = comparisonFiltersFromParams(params);
    setParams(writeComparisonParams(params, { ...f, hinted: !f.hinted }, comparisonSortFromParams(params), 1), { replace: true });
  };

  // Big tables are reloaded when a sync job ends, not on every deck it writes.
  const version = `${sync?.jobId ?? ''}:${sync?.status === 'running' ? 'running' : 'idle'}:${collectionMeta?.fetchedAt ?? 0}:${decksMeta?.lastSuccessAt ?? 0}`;
  const { deckCards, collection, loaded } = useDeckData(key, version);

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
    () =>
      result && config
        ? result.rows.filter((r) => (r.kind === 'missing' ? config.showMissing : r.kind === 'unassigned' ? config.showUnassigned : config.showMatched))
        : [],
    [result, config],
  );

  const header = (
    <Stack gap={4}>
      <Title order={2}>Comparator</Title>
      <Text size="sm" c="dimmed">
        Your decks compared with your collection: deck cards the collection doesn't have, and collection cards no deck uses. Compared by exact print
        (set, collector number and finish); copies used by several decks add up.
      </Text>
    </Stack>
  );

  // No account yet: the first sync adds the account logged in on the site.
  if (!key) {
    return (
      <Stack>
        {header}
        <AccountHint type={site.type} />
        <FirstSync decks={[]} />
      </Stack>
    );
  }
  if (decks === undefined || decksMeta === undefined || config === null || state === null) return <Text c="dimmed">Loading…</Text>;

  if (!decksMeta.lastSuccessAt) {
    return (
      <Stack>
        {header}
        <AccountHint type={site.type} />
        <FirstSync decks={decks} />
      </Stack>
    );
  }

  const newDecks = decks.filter((d) => d.isNew);
  const s = result?.summary;

  return (
    <Stack>
      {header}
      <AccountHint type={site.type} />
      <PresetBar state={state} load={presets.load} save={presets.save} rename={presets.rename} remove={presets.remove} />
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
                  <Anchor size="xs" component="button" type="button" onClick={() => void markDecksSeen(accountData(key))}>
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
        <OptionsCard config={config} update={update} boards={boards} decksSyncedAt={decksMeta.lastSuccessAt} collection={collectionMeta} />
      </SimpleGrid>

      {!collectionMeta ? (
        <Paper withBorder p="lg" radius="md">
          <Text c="dimmed">Click “Compare” to read your collection and compare it with the selected decks.</Text>
        </Paper>
      ) : (
        <>
          {s && (
            <SimpleGrid cols={{ base: 1, xs: 2, md: 3, xl: 5 }}>
              <Stat
                label="Missing from collection"
                value={`${s.missingCopies} copies`}
                color={config.showMissing ? 'red' : 'dimmed'}
                lines={["Copies used in decks that the collection doesn't have (exact print)", `${s.missingPrints} prints`, !config.showMissing && 'Hidden from the table'].filter(Boolean) as string[]}
                onClick={() => update({ showMissing: !config.showMissing })}
                active={config.showMissing}
                activeSuffix=" · shown"
                action={config.showMissing ? 'Hide these rows' : 'Show these rows'}
              />
              <Stat
                label="Not in any deck"
                value={`${s.unassignedCopies} copies`}
                color={config.showUnassigned ? 'orange' : 'dimmed'}
                lines={['Copies in the collection that no included deck uses', `${s.unassignedPrints} prints`, !config.showUnassigned && 'Hidden from the table'].filter(Boolean) as string[]}
                onClick={() => update({ showUnassigned: !config.showUnassigned })}
                active={config.showUnassigned}
                activeSuffix=" · shown"
                action={config.showUnassigned ? 'Hide these rows' : 'Show these rows'}
              />
              <Stat
                label="Matching"
                value={`${s.matchedCopies} copies`}
                color={config.showMatched ? 'teal' : 'dimmed'}
                lines={[
                  'Copies both in decks and in the collection (exact print)',
                  `${s.matchedPrints} prints${s.matchedPrints > s.exactPrints ? ` (${s.matchedPrints - s.exactPrints} also have a difference, in its own row)` : ''}`,
                  !config.showMatched && 'Hidden from the table',
                ].filter(Boolean) as string[]}
                onClick={() => update({ showMatched: !config.showMatched })}
                active={config.showMatched}
                activeSuffix=" · shown"
                action={config.showMatched ? 'Hide these rows' : 'Show these rows'}
              />
              <Stat
                label="Likely wrong print"
                value={String(s.hinted)}
                color="yellow"
                lines={['Same card is mismatched the other way in another print or finish']}
                onClick={toggleHinted}
                active={hintedOnly}
                action={hintedOnly ? 'Show every row' : 'Show only these rows'}
              />
              <Stat
                label="Compared"
                value={`${s.decksIncluded} decks`}
                lines={[
                  `${s.deckCopies} deck copies · ${s.collectionCopies} collection copies`,
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
          <ComparisonTable
            rows={shown}
            allRows={result?.rows ?? []}
            exportList={site.capabilities.exportTo.binders || site.capabilities.exportTo.collection ? exportList : undefined}
            decks={deckById}
            boardLabel={site.boardLabel}
            loading={!loaded}
            emptyText={
              config.showMissing || config.showUnassigned || config.showMatched
                ? config.showMatched
                  ? 'Nothing to show'
                  : 'No differences: decks and collection agree'
                : 'Every kind of row is hidden: click “Missing from collection”, “Not in any deck” or “Matching” above to show them'
            }
          />
        </>
      )}
      <ExportBar exportList={exportList} siteLabel={site.label} onExport={() => setExporting(true)} />
      <ExportDialog
        opened={exporting}
        onClose={() => setExporting(false)}
        site={site}
        items={exportList.items}
        sourceAccountKey={key}
        source={`Comparator of ${account ? accountLabel(account) : 'an account'}`}
        onClearExport={() => exportList.clear()}
      />
      <LeaveGuard prints={exportList.prints} summary={exportSummary(exportList)} />
    </Stack>
  );
}
