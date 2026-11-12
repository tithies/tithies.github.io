import { ActionIcon, Alert, Badge, Button, Checkbox, Group, List, Modal, Paper, Stack, Table, Text, Tooltip } from '@mantine/core';
import { IconAlertTriangle, IconCheck, IconDatabase, IconRefresh, IconTrash } from '@tabler/icons-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Fragment, useEffect, useState } from 'react';
import type { BulkRates } from '@/features/f2f-buylist/types';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { accountData, type AccountDataGroup } from '@/lib/accounts/data';
import { accountLabel, type AccountKey, type AccountRow } from '@/lib/accounts/types';
import { db, getMeta } from '@/lib/db';
import { timeAgo } from '@/lib/format';
import { getSettings, settingsItem } from '@/lib/settings';
import { siteOf } from '@/lib/sites/registry';
import { SettingsSection } from '@/lib/ui/SettingsSection';
import { SiteIcon } from '@/lib/ui/SiteIcon';
import { clearStoredData, measureStoredData, type DataGroup } from './stored-data';

const n = (v: number) => v.toLocaleString('en-CA');
const ago = (t?: number) => (t ? timeAgo(t) : 'never');
const megabytes = (bytes: number) => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : bytes > 0 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : '0 KB');

async function accountStats(key: AccountKey) {
  const data = accountData(key);
  const [decks, deckCards, decksMeta, sync, collection, collectionMeta, runs, items, activeRuns] = await Promise.all([
    data.decks.count(),
    data.deckCards.count(),
    data.meta.get('decks'),
    data.meta.get('sync'),
    data.collection.count(),
    data.meta.get('collection'),
    data.runs.count(),
    data.items.count(),
    data.runs.activeIds().then((ids) => ids.length),
  ]);
  return { decks, deckCards, decksMeta, syncing: sync?.status === 'running', collection, collectionMeta, runs, items, activeRuns };
}
type AccountStats = Awaited<ReturnType<typeof accountStats>>;

/** Counts and dates: the shared F2F caches, and each account's data. Live while the page is open. */
function useStats(ttlHours: number, keys: AccountKey[]) {
  return useLiveQuery(async () => {
    const cutoff = Date.now() - ttlHours * 3600_000;
    const [lookups, fresh, oldest, bulk, sets, perAccount] = await Promise.all([
      db.f2fCache.count(),
      ttlHours > 0 ? db.f2fCache.where('fetchedAt').aboveOrEqual(cutoff).count() : 0,
      db.f2fCache.orderBy('fetchedAt').first(),
      getMeta<BulkRates>('bulkRates'),
      getMeta<{ fetchedAt: number; sets: string[] }>('f2fSets'),
      Promise.all(keys.map(accountStats)),
    ]);
    const accounts = Object.fromEntries(keys.map((k, i) => [k, perAccount[i]])) as Record<AccountKey, AccountStats>;
    return { lookups, fresh, oldest: oldest?.fetchedAt, bulk, sets, accounts };
  }, [ttlHours, keys.join(',')]);
}

interface Row {
  /** 'f2fCache', or `${accountKey}|${group}`. */
  id: string;
  group: DataGroup;
  account: AccountRow | null;
  title: string;
  kind: { label: string; color: string };
  details: React.ReactNode[];
  /** What clearing it means. */
  effect: string;
  empty: boolean;
  /** Why it can't be cleared right now. */
  blocked?: string;
  /** Selling runs it deletes (for the warning). */
  runs?: number;
}

const CACHE = { label: 'Cache', color: 'gray' };
const synced = (label: string) => ({ label: `Copy of ${label}`, color: 'blue' });
const YOURS = { label: 'Your data', color: 'red' };

function accountRows(a: AccountRow, s: AccountStats): Row[] {
  const site = siteOf(a.type);
  const id = (g: AccountDataGroup) => `${a.key}|${g}`;
  const syncBlock = s.syncing ? `A sync of this account is running: wait for it to finish, or cancel it on the Mismatches page.` : undefined;
  return [
    {
      id: id('decks'),
      group: 'decks',
      account: a,
      title: `${site.label} decks`,
      kind: synced(site.label),
      details: [`${n(s.decks)} decks, ${n(s.deckCards)} with their cards read`, `Last complete sync ${ago(s.decksMeta?.lastSuccessAt)}`],
      effect: `The next sync reads every deck again (about one second per deck). Your decks on ${site.label} are not touched.`,
      empty: !s.decks && !s.deckCards && !s.decksMeta,
      blocked: syncBlock,
    },
    {
      id: id('collection'),
      group: 'collection',
      account: a,
      title: `${site.label} collection`,
      kind: synced(site.label),
      details: [s.collectionMeta ? `${n(s.collectionMeta.entries)} rows (${n(s.collectionMeta.copies)} copies), read ${ago(s.collectionMeta.fetchedAt)}` : `${n(s.collection)} rows`],
      effect: `Read again the next time you click "Find mismatches". Your collection on ${site.label} is not touched.`,
      empty: !s.collection && !s.collectionMeta,
      blocked: syncBlock,
    },
    {
      id: id('runs'),
      group: 'runs',
      account: a,
      title: 'Selling runs',
      kind: YOURS,
      details: [`${n(s.runs)} runs, ${n(s.items)} card results`, ...(s.activeRuns ? [`${s.activeRuns} still running: cancelled first`] : [])],
      effect: 'Deletes every run of this account and its results, for good. Export the ones you want to keep to CSV first.',
      empty: !s.runs,
      runs: s.runs,
    },
  ];
}

/** Settings → Stored data: what Tithies keeps in IndexedDB (shared caches, then each account's data), with checkboxes to clear any of it. */
export function StoredDataSection() {
  const { accounts } = useCurrentAccount();
  const keys = accounts.map((a) => a.key);
  const [ttlHours, setTtlHours] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  /** Database files on disk, as the browser reports them (keeps cleared space until it compacts them). */
  const [usage, setUsage] = useState<number | null>(null);
  /** What each row's data weighs: measured on demand, it reads every row. */
  const [sizes, setSizes] = useState<Record<string, number> | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const stats = useStats(ttlHours ?? 1, keys);

  useEffect(() => {
    void getSettings().then((s) => setTtlHours(s.cacheTtlHours));
    return settingsItem.watch(() => void getSettings().then((s) => setTtlHours(s.cacheTtlHours)));
  }, []);
  const measure = () => {
    setMeasuring(true);
    void navigator.storage?.estimate?.().then((e) => setUsage(e.usage ?? null));
    void Promise.all([measureStoredData(null), ...keys.map((k) => measureStoredData(k).then((m) => [k, m] as const))])
      .then(([shared, ...perAccount]) => {
        const out: Record<string, number> = { f2fCache: shared.f2fCache };
        for (const [k, m] of perAccount) for (const g of ['decks', 'collection', 'runs'] as const) out[`${k}|${g}`] = m[g];
        setSizes(out);
      })
      .finally(() => setMeasuring(false));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(measure, [keys.join(',')]);

  if (!stats || ttlHours == null) return null;
  const s = stats;

  const shared: Row = {
    id: 'f2fCache',
    group: 'f2fCache',
    account: null,
    title: 'F2F lookups',
    kind: CACHE,
    details: [
      `${n(s.lookups)} prints looked up${s.lookups ? `, oldest ${ago(s.oldest)}` : ''}`,
      ttlHours > 0 ? `${n(s.fresh)} recent enough to be reused (under ${ttlHours} h old)` : 'None reused: "Reuse F2F results for" is 0 h',
      `Bulk rates fetched ${ago(s.bulk?.fetchedAt)}; F2F set list (${n(s.sets?.sets.length ?? 0)} sets) fetched ${ago(s.sets?.fetchedAt)}`,
    ],
    effect: 'Shared by every account. The next run looks every card up again, and fetches the bulk rates and the set list again.',
    empty: !s.lookups && !s.bulk && !s.sets,
  };
  const blocks: { account: AccountRow | null; rows: Row[] }[] = [
    { account: null, rows: [shared] },
    ...accounts.filter((a) => s.accounts[a.key]).map((a) => ({ account: a, rows: accountRows(a, s.accounts[a.key]) })),
  ];
  const rows = blocks.flatMap((b) => b.rows);

  const selectable = rows.filter((r) => !r.empty && !r.blocked).map((r) => r.id);
  const chosen = rows.filter((r) => selected.has(r.id) && selectable.includes(r.id));
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;
  const runsChosen = chosen.reduce((sum, r) => sum + (r.runs ?? 0), 0);
  const rowTitle = (r: Row) => (r.account ? `${r.title} of ${accountLabel(r.account)}` : r.title);
  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
    setCleared(null);
  };

  const clear = async () => {
    setBusy(true);
    try {
      if (chosen.some((r) => r.group === 'f2fCache')) await clearStoredData(['f2fCache'], null);
      for (const a of accounts) {
        const groups = chosen.filter((r) => r.account?.key === a.key).map((r) => r.group);
        if (groups.length) await clearStoredData(groups, a.key);
      }
      setCleared(chosen.map(rowTitle).join(', '));
      setSelected(new Set());
      measure();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <SettingsSection title="Stored data" icon={IconDatabase} description="Kept in this browser (IndexedDB), per account. Nothing is sent anywhere.">
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
                <Table.Th ta="right">Size</Table.Th>
                <Table.Th>If you clear it</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {blocks.map((b) => (
                <Fragment key={b.account?.key ?? 'shared'}>
                  <Table.Tr>
                    <Table.Td colSpan={5} bg="var(--mantine-color-default-hover)" py={6}>
                      {b.account ? (
                        <Group gap="xs">
                          <SiteIcon type={b.account.type} size={16} />
                          <Text size="sm" fw={600}>
                            {accountLabel(b.account)}
                          </Text>
                          {b.account.nickname && (
                            <Text size="xs" c="dimmed">
                              {b.account.userName}
                            </Text>
                          )}
                        </Group>
                      ) : (
                        <Text size="sm" fw={600}>
                          Shared by every account
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                  {b.rows.map((r) => (
                    <Table.Tr key={r.id} style={{ verticalAlign: 'top' }}>
                      <Table.Td>
                        <Checkbox
                          aria-label={`Clear ${rowTitle(r)}`}
                          checked={selected.has(r.id) && selectable.includes(r.id)}
                          disabled={r.empty || Boolean(r.blocked)}
                          onChange={(e) => toggle(r.id, e.currentTarget.checked)}
                        />
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
                      <Table.Td ta="right">
                        <Text size="sm" className="ti-num" style={{ whiteSpace: 'nowrap' }}>
                          {r.empty ? '0 KB' : sizes && sizes[r.id] != null ? `≈ ${megabytes(sizes[r.id])}` : '…'}
                        </Text>
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
                </Fragment>
              ))}
              {!accounts.length && (
                <Table.Tr>
                  <Table.Td />
                  <Table.Td colSpan={4}>
                    <Text size="sm" c="dimmed">
                      No account yet: nothing else is stored.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
        <Group justify="space-between" p="md" pt="xs" align="flex-start">
          <Stack gap={2} style={{ flex: 1, minWidth: 240 }}>
            <Group gap={6}>
              <Text size="sm" className="ti-num">
                Your data: {sizes ? <b>≈ {megabytes(Object.values(sizes).reduce((sum, v) => sum + v, 0))}</b> : '…'}
              </Text>
              <Tooltip label="Measure again">
                <ActionIcon variant="subtle" color="gray" size="sm" loading={measuring} onClick={measure} aria-label="Measure again">
                  <IconRefresh size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
            {usage != null && (
              <Text size="xs" c="dimmed">
                The browser reports {megabytes(usage)} on disk. It keeps the space of cleared data until it compacts its files, later and on its own, so that
                figure goes down after a while.
              </Text>
            )}
            <Text size="xs" c="dimmed">
              Tick everything (the box at the top) to clear all of Tithies' data. Accounts and settings are kept: see "Accounts" and "Reset settings".
            </Text>
          </Stack>
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
                <b>{rowTitle(r)}</b>: {r.effect}
              </List.Item>
            ))}
          </List>
          {runsChosen > 0 && (
            <Alert color="red" variant="light" icon={<IconAlertTriangle size={18} />}>
              {n(runsChosen)} Selling run{runsChosen === 1 ? ' is' : 's are'} deleted for good. This can't be undone.
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
