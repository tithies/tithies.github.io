import { Alert, Button, Group, Modal, Paper, SimpleGrid, Stack, Text, Title } from '@mantine/core';
import { IconAlertTriangle, IconPlayerStop, IconRefresh } from '@tabler/icons-react';
import { useMemo, useRef, useState } from 'react';
import { useBlocker, useSearchParams } from 'react-router';
import { useActivity } from '@/lib/activity';
import { useExportList } from '@/lib/export/list';
import { exportSummary, ExportBar } from '@/lib/export/ui/ExportBar';
import { useRecentExports } from '@/lib/export/client';
import { ExportDialog } from '@/lib/export/ui/ExportDialog';
import { ExportProgressModal, RecentExportsModal } from '@/lib/export/ui/ExportProgress';
import { accountLabel } from '@/lib/accounts/types';
import { boardCopies } from '@/lib/decks/BoardCheckboxes';
import { DecksPanel } from '@/lib/decks/DecksPanel';
import { cancelSync, useCollectionMeta, useDeckData, useDecks, useDecksMeta, useSyncState } from '@/lib/decks/hooks';
import { StartError, useStartSync } from '@/lib/decks/StartSync';
import { SyncProgress } from '@/lib/decks/SyncProgress';
import { GettingStarted } from '@/lib/ui/GettingStarted';
import { useInitialSync } from '@/lib/ui/InitialSync';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { AccountHint } from '@/lib/ui/AccountHint';
import type { AccountKey } from '@/lib/accounts/types';
import type { SiteProvider } from '@/lib/sites/provider';
import type { DeckRow } from '@/lib/decks/types';
import { siteOf } from '@/lib/sites/registry';
import { Stat } from '@/lib/ui/Stat';
import { compareDecksToCollection } from '../compare';
import { useComparisonConfig } from '../config';
import { comparisonFiltersFromParams, comparisonSortFromParams, writeComparisonParams } from '../filtering';
import { ComparisonTable } from './ComparisonTable';

/** The current account, and the site its decks come from (Moxfield before any account exists). */
function usePageAccount(): { key: AccountKey | null; site: SiteProvider } {
  const { key, account } = useCurrentAccount();
  return { key, site: siteOf(account?.type ?? 'moxfield') };
}

/** After a sync stopped because the site is logged in as someone else: switch to that account (or offer its initial sync when new). */
function useSwitchTo(site: SiteProvider) {
  const { switchToIdentity } = useInitialSync();
  return (who: { userId: string; userName: string }) => switchToIdentity(site.type, who);
}

/** The initial sync, from the page: decks, then the whole collection, so the comparison shows right after. */
function FirstSync({ decks }: { decks: DeckRow[] }) {
  const { key, site } = usePageAccount();
  const sync = useSyncState(key);
  const { start, error, starting, clearError } = useStartSync(site.type, key);
  const switchTo = useSwitchTo(site);
  const running = sync?.status === 'running' || starting;
  const partial = decks.filter((d) => d.cardsUpdatedAt).length;
  return (
    <GettingStarted title={`First, sync your ${site.label} decks and collection`}>
      <Text size="sm">
        Tithies reads your deck list, every deck's cards, then your whole collection, and keeps them here. Later syncs only read decks you changed or
        added (using each deck's last-updated time) and what changed in your collection, so they take seconds.
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
      <SyncProgress state={sync} site={site} onSwitch={switchTo} />
      {error && <StartError error={error} type={site.type} onCancelled={clearError} />}
      <Group>
        <Button leftSection={<IconRefresh size={16} />} loading={running} onClick={() => void start(true)}>
          Sync decks and collection
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

/** Leaving the page clears the cards picked for export (not yet exported): ask first. */
function LeaveGuard({ prints, summary }: { prints: number; summary: string }) {
  const blocker = useBlocker(({ currentLocation, nextLocation }) => prints > 0 && currentLocation.pathname !== nextLocation.pathname);
  const exportRunning = useActivity().some((a) => a.kind === 'export');
  return (
    <Modal opened={blocker.state === 'blocked'} onClose={() => blocker.reset?.()} title="Leave this page?" centered>
      <Stack>
        <Text size="sm">The cards picked for export ({summary}) only live on this page: leaving clears that list.</Text>
        {exportRunning && (
          <Text size="sm" c="dimmed">
            The export already started isn't affected: it goes on in the background.
          </Text>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={() => blocker.reset?.()}>
            Stay
          </Button>
          <Button color="red" onClick={() => blocker.proceed?.()}>
            Leave and clear the list
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
  const { config, update } = useComparisonConfig(key);
  // The "Likely wrong print" card toggles the table's filter of the same name (kept in the URL).
  const [params, setParams] = useSearchParams();
  // The export shown in its own window (`?export=<id>`, also opened from the menu's "Running" list).
  const recentExports = useRecentExports(key);
  const [pickingExport, setPickingExport] = useState(false);
  const viewedExport = Number(params.get('export')) || null;
  const viewExport = (opId: number | null) =>
    setParams(
      (p) => {
        const q = new URLSearchParams(p);
        if (opId == null) q.delete('export');
        else q.set('export', String(opId));
        return q;
      },
      { replace: true },
    );
  /** One export: open it; several: pick one first. */
  const showExports = () => (recentExports.length === 1 ? viewExport(recentExports[0].id!) : setPickingExport(true));
  // The export running, to open it directly: only when none waits after it (else pick one).
  const activeExports = recentExports.filter((o) => o.status === 'running' || o.status === 'queued');
  const runningExport = activeExports.length === 1 ? activeExports[0] : undefined;
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
  const boards = useMemo(() => boardCopies(deckCards), [deckCards]);

  const collectionAt = collectionMeta?.fetchedAt;
  const fresh = useMemo(
    () =>
      config && loaded && collectionAt
        ? compareDecksToCollection(stableDecks, deckCards, collection, {
            excludedDeckIds: config.excludedDeckIds,
            ignoredBoards: config.ignoredBoards,
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
        (set, collector number, finish and the print's language); copies used by several decks add up.
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
  if (decks === undefined || decksMeta === undefined || config === null) return <Text c="dimmed">Loading…</Text>;

  if (!decksMeta.lastSuccessAt) {
    return (
      <Stack>
        {header}
        <AccountHint type={site.type} />
        <FirstSync decks={decks} />
      </Stack>
    );
  }

  const s = result?.summary;

  return (
    <Stack>
      {header}
      <AccountHint type={site.type} />
      <Paper withBorder p="md" radius="md">
        <DecksPanel
          accountKey={key}
          site={site}
          decks={decks}
          decksMeta={decksMeta}
          collection={collectionMeta}
          boards={boards}
          choices={config}
          onChange={update}
        />
      </Paper>

      {!collectionMeta ? (
        <Paper withBorder p="lg" radius="md">
          <Text c="dimmed">Click “Sync decks and collection” to read your collection and compare it with the selected decks.</Text>
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
                color={s.hinted ? 'yellow' : 'dimmed'}
                lines={[
                  'Same card is mismatched the other way in another print or finish',
                  !s.hinted && 'None with these decks and options: it takes a card both missing and in no deck, in two prints',
                ].filter(Boolean) as string[]}
                // Nothing to show: not a filter then (unless it is on, to turn it off).
                onClick={s.hinted || hintedOnly ? toggleHinted : undefined}
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
            exportList={site.capabilities.exportTo.binders || site.capabilities.exportTo.collection || site.capabilities.exportTo.decks ? exportList : undefined}
            decks={deckById}
            boardLabel={site.boardLabel}
            loading={!loaded}
            recentExports={recentExports.length}
            onSeeExports={showExports}
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
      <ExportBar
        exportList={exportList}
        siteLabel={site.label}
        onExport={() => setExporting(true)}
        exports={recentExports}
        onSeeExports={runningExport ? () => viewExport(runningExport.id!) : showExports}
      />
      <RecentExportsModal
        opened={pickingExport}
        ops={recentExports}
        onPick={(id) => {
          setPickingExport(false);
          viewExport(id);
        }}
        onClose={() => setPickingExport(false)}
      />
      <ExportProgressModal opId={viewedExport} onClose={() => viewExport(null)} />
      <ExportDialog
        opened={exporting}
        onClose={() => setExporting(false)}
        site={site}
        items={exportList.items}
        sourceAccountKey={key}
        source={`Comparator of ${account ? accountLabel(account) : 'an account'}`}
        onStarted={() => exportList.clear()}
      />
      <LeaveGuard prints={exportList.prints} summary={exportSummary(exportList)} />
    </Stack>
  );
}
