import { Alert, Badge, Button, Checkbox, Group, List, Modal, Paper, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconDatabase, IconTrash } from '@tabler/icons-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useEffect, useState } from 'react';
import type { BulkRates } from '@/features/f2f-buylist/types';
import { db, getMeta } from '@/lib/db';
import { META_COLLECTION, META_DECKS, META_SYNC, type CollectionMeta, type DecksMeta, type MoxSyncState } from '@/lib/decks/types';
import { timeAgo } from '@/lib/format';
import { getSettings, settingsItem } from '@/lib/settings';
import { SettingsSection } from '@/lib/ui/SettingsSection';
import { clearStoredData, type DataGroup } from './stored-data';

const n = (v: number) => v.toLocaleString('en-CA');
const ago = (t?: number) => (t ? timeAgo(t) : 'never');
const megabytes = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`);

/** Counts and dates for every group, live (they follow runs and syncs while the page is open). */
function useStats(ttlHours: number) {
  return useLiveQuery(async () => {
    const cutoff = Date.now() - ttlHours * 3600_000;
    const [lookups, fresh, oldest, bulk, sets, decks, deckCards, decksMeta, sync, collection, collectionMeta, runs, items, activeRuns] = await Promise.all([
      db.f2fCache.count(),
      ttlHours > 0 ? db.f2fCache.where('fetchedAt').aboveOrEqual(cutoff).count() : 0,
      db.f2fCache.orderBy('fetchedAt').first(),
      getMeta<BulkRates>('bulkRates'),
      getMeta<{ fetchedAt: number; sets: string[] }>('f2fSets'),
      db.decks.count(),
      db.deckCards.count(),
      getMeta<DecksMeta>(META_DECKS),
      getMeta<MoxSyncState>(META_SYNC),
      db.moxCollection.count(),
      getMeta<CollectionMeta>(META_COLLECTION),
      db.runs.count(),
      db.items.count(),
      db.runs.where('status').anyOf('running', 'queued').count(),
    ]);
    return { lookups, fresh, oldest: oldest?.fetchedAt, bulk, sets, decks, deckCards, decksMeta, syncing: sync?.status === 'running', collection, collectionMeta, runs, items, activeRuns };
  }, [ttlHours]);
}

interface Row {
  id: DataGroup;
  title: string;
  kind: { label: string; color: string };
  details: React.ReactNode[];
  /** What clearing it means. */
  effect: string;
  empty: boolean;
  /** Why it can't be cleared right now. */
  blocked?: string;
}

const CACHE = { label: 'Cache', color: 'gray' };
const SYNCED = { label: 'Copy of Moxfield', color: 'blue' };
const YOURS = { label: 'Your data', color: 'red' };

/** Settings → Stored data: what Tithies keeps in IndexedDB, with checkboxes to clear any of it. */
export function StoredDataSection() {
  const [ttlHours, setTtlHours] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<DataGroup>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  const [usage, setUsage] = useState<number | null>(null);
  const stats = useStats(ttlHours ?? 1);

  useEffect(() => {
    void getSettings().then((s) => setTtlHours(s.cacheTtlHours));
    return settingsItem.watch(() => void getSettings().then((s) => setTtlHours(s.cacheTtlHours)));
  }, []);
  const refreshUsage = () => void navigator.storage?.estimate?.().then((e) => setUsage(e.usage ?? null));
  useEffect(refreshUsage, []);

  if (!stats || ttlHours == null) return null;
  const s = stats;
  const syncBlock = s.syncing ? 'A Moxfield sync is running: wait for it to finish, or cancel it on the Mismatches page.' : undefined;

  const rows: Row[] = [
    {
      id: 'f2fCache',
      title: 'F2F lookups',
      kind: CACHE,
      details: [
        `${n(s.lookups)} prints looked up${s.lookups ? `, oldest ${ago(s.oldest)}` : ''}`,
        ttlHours > 0 ? `${n(s.fresh)} recent enough to be reused (under ${ttlHours} h old)` : 'None reused: "Reuse F2F results for" is 0 h',
        `Bulk rates fetched ${ago(s.bulk?.fetchedAt)}; F2F set list (${n(s.sets?.sets.length ?? 0)} sets) fetched ${ago(s.sets?.fetchedAt)}`,
      ],
      effect: 'The next run looks every card up again, and fetches the bulk rates and the set list again.',
      empty: !s.lookups && !s.bulk && !s.sets,
    },
    {
      id: 'moxDecks',
      title: 'Moxfield decks',
      kind: SYNCED,
      details: [`${n(s.decks)} decks, ${n(s.deckCards)} with their cards read`, `Last complete sync ${ago(s.decksMeta?.lastSuccessAt)}`],
      effect: 'The next sync reads every deck again (about one second per deck). Your decks on Moxfield are not touched.',
      empty: !s.decks && !s.deckCards && !s.decksMeta,
      blocked: syncBlock,
    },
    {
      id: 'moxCollection',
      title: 'Moxfield collection',
      kind: SYNCED,
      details: [s.collectionMeta ? `${n(s.collectionMeta.entries)} rows (${n(s.collectionMeta.copies)} copies), read ${ago(s.collectionMeta.fetchedAt)}` : `${n(s.collection)} rows`],
      effect: 'Read again the next time you click "Find mismatches". Your collection on Moxfield is not touched.',
      empty: !s.collection && !s.collectionMeta,
      blocked: syncBlock,
    },
    {
      id: 'runs',
      title: 'Selling runs',
      kind: YOURS,
      details: [`${n(s.runs)} runs, ${n(s.items)} card results`, ...(s.activeRuns ? [`${s.activeRuns} still running: cancelled first`] : [])],
      effect: 'Deletes every run and its results, for good. Export the ones you want to keep to CSV first.',
      empty: !s.runs,
    },
  ];

  const selectable = rows.filter((r) => !r.empty && !r.blocked).map((r) => r.id);
  const chosen = rows.filter((r) => selected.has(r.id) && selectable.includes(r.id));
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;
  const toggle = (id: DataGroup, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
    setCleared(null);
  };

  const clear = async () => {
    setBusy(true);
    try {
      await clearStoredData(chosen.map((r) => r.id));
      setCleared(chosen.map((r) => r.title).join(', '));
      setSelected(new Set());
      refreshUsage();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <SettingsSection
      title="Stored data"
      icon={IconDatabase}
      description={`Kept in this browser (IndexedDB)${usage != null ? `: about ${megabytes(usage)} in all` : ''}. Nothing is sent anywhere.`}
    >
      <Paper withBorder radius="md">
        <Table.ScrollContainer minWidth={760}>
          <Table verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={40}>
                  <Checkbox
                    aria-label="Select everything"
                    checked={allChosen}
                    indeterminate={chosen.length > 0 && !allChosen}
                    disabled={!selectable.length}
                    onChange={(e) => {
                      setSelected(new Set(e.currentTarget.checked ? selectable : []));
                      setCleared(null);
                    }}
                  />
                </Table.Th>
                <Table.Th>What</Table.Th>
                <Table.Th>Contents</Table.Th>
                <Table.Th>If you clear it</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((r) => (
                <Table.Tr key={r.id} style={{ verticalAlign: 'top' }}>
                  <Table.Td>
                    <Checkbox aria-label={`Clear ${r.title}`} checked={selected.has(r.id) && selectable.includes(r.id)} disabled={r.empty || Boolean(r.blocked)} onChange={(e) => toggle(r.id, e.currentTarget.checked)} />
                  </Table.Td>
                  <Table.Td>
                    <Stack gap={4} align="flex-start">
                      <Text size="sm" fw={600}>
                        {r.title}
                      </Text>
                      <Badge size="xs" variant="light" color={r.kind.color}>
                        {r.kind.label}
                      </Badge>
                    </Stack>
                  </Table.Td>
                  <Table.Td>
                    {r.empty ? (
                      <Text size="sm" c="dimmed">
                        Empty
                      </Text>
                    ) : (
                      r.details.map((d, i) => (
                        <Text key={i} size="sm" c={i ? 'dimmed' : undefined} className="ti-num">
                          {d}
                        </Text>
                      ))
                    )}
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {r.effect}
                    </Text>
                    {r.blocked && (
                      <Text size="xs" c="yellow" mt={4}>
                        {r.blocked}
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Group justify="space-between" p="md" pt="xs">
          <Text size="xs" c="dimmed">
            Tick everything (the box at the top) to clear all of Tithies' data. Settings are kept: see "Reset settings" below.
          </Text>
          <Group gap="sm">
            {cleared && (
              <Group gap={4}>
                <IconCheck size={14} color="var(--mantine-color-teal-5)" />
                <Text size="xs" c="dimmed">
                  Cleared: {cleared}
                </Text>
              </Group>
            )}
            <Button color="red" variant="light" leftSection={<IconTrash size={16} />} disabled={!chosen.length} onClick={() => setConfirming(true)}>
              {allChosen ? 'Clear everything' : `Clear selected (${chosen.length})`}
            </Button>
          </Group>
        </Group>
      </Paper>

      <Modal opened={confirming} onClose={() => setConfirming(false)} title={allChosen ? 'Clear all stored data?' : 'Clear the selected data?'} centered>
        <Stack>
          <List size="sm" spacing={6}>
            {chosen.map((r) => (
              <List.Item key={r.id}>
                <b>{r.title}</b>: {r.effect}
              </List.Item>
            ))}
          </List>
          {chosen.some((r) => r.id === 'runs') && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />}>
              Your {n(s.runs)} Selling runs are deleted for good. This can't be undone.
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirming(false)}>
              Keep it
            </Button>
            <Button color="red" loading={busy} onClick={() => void clear()}>
              Clear
            </Button>
          </Group>
        </Stack>
      </Modal>
    </SettingsSection>
  );
}
