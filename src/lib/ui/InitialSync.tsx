/**
 * The initial sync of new accounts, offered from the dashboard menu: a button while Tithies
 * knows of an account whose decks and collection were never read (logged in on the site but not in
 * Tithies yet, added by a selling check, or no account at all), and the prompt it opens. The
 * account menu, the hints and Settings → Accounts open the same prompt.
 */
import { Alert, Anchor, Button, Divider, Group, Loader, Modal, Stack, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconExternalLink, IconInfoCircle, IconPlayerStop, IconRefresh, IconRefreshAlert, IconUserExclamation, IconUserPlus } from '@tabler/icons-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useCurrentAccount } from '@/lib/accounts/AccountProvider';
import { addAccountFromAction, getInitialSyncDismissed, setInitialSyncDismissed } from '@/lib/accounts/data';
import { accountKey, accountLabel, parseAccountKey, type AccountKey } from '@/lib/accounts/types';
import { cancelSync, startSync, useCollectionMeta, useSyncState } from '@/lib/decks/hooks';
import { candidateId, initialSyncCandidates, isSetUp, readSyncSetups, type InitialSyncCandidate, type SyncSetup } from '@/lib/decks/initial-sync';
import { StartError, useSyncStarter } from '@/lib/decks/StartSync';
import { SyncProgress } from '@/lib/decks/SyncProgress';
import { timeAgo } from '@/lib/format';
import { SITE_TYPES, siteOf } from '@/lib/sites/registry';
import type { SiteIdentity, SiteType } from '@/lib/sites/types';
import { useSiteSessions, type SiteSessionsView } from '@/lib/sites/useSiteSessions';
import { SiteIcon } from './SiteIcon';

/** One account to open the prompt for: one Tithies doesn't know yet, or one it has. */
export type InitialSyncTarget = { type: SiteType; identity: SiteIdentity } | { accountKey: AccountKey };

interface InitialSyncContext {
  /** What the menu offers now, most relevant first. */
  candidates: InitialSyncCandidate[];
  /** Opens the prompt: for every candidate, or for one account (even one the user said "Not now" to). */
  open(target?: InitialSyncTarget): void;
  /** "Switch Tithies to X": switches to an account Tithies has; offers the initial sync of one it doesn't. */
  switchToIdentity(type: SiteType, who: SiteIdentity): void;
}

const Ctx = createContext<InitialSyncContext>({
  candidates: [],
  open: () => {},
  switchToIdentity: (type, who) => void addAccountFromAction(type, who),
});

export const useInitialSync = (): InitialSyncContext => useContext(Ctx);

const nameOf = (c: InitialSyncCandidate): string => (c.kind === 'unknown' ? c.identity.userName : c.kind === 'unsynced' ? accountLabel(c.account) : siteOf(c.type).label);

/** "its decks and collection have", "its collection has"… (never read). */
function missingOf(s: Pick<SyncSetup, 'decksSyncedAt' | 'collectionReadAt'>): string {
  if (!s.decksSyncedAt && !s.collectionReadAt) return 'decks and collection have';
  return s.decksSyncedAt ? 'collection has' : 'decks have';
}

export function InitialSyncProvider({ children }: { children: ReactNode }) {
  const { accounts, key: currentKey, loading } = useCurrentAccount();
  const sessions = useSiteSessions();
  const keys = accounts.map((a) => a.key);
  const loaded = useLiveQuery(
    async () => ({ setups: await readSyncSetups(keys), dismissed: new Set<string>(await getInitialSyncDismissed()) }),
    [keys.join(',')],
  );
  // Starts still looking for their tab: not offered meanwhile (a first sync only adds its account once connected).
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const [shown, setShown] = useState<InitialSyncCandidate[] | null>(null);

  const list = loaded
    ? initialSyncCandidates({ accounts, currentKey, live: sessions.live, setups: loaded.setups, dismissed: loaded.dismissed, siteTypes: SITE_TYPES }).filter(
        (c) => !pending.has(candidateId(c)),
      )
    : [];
  // Sync progress rewrites the account meta every second: only a different list is a new one.
  const signature = list.map((c) => `${c.kind}:${candidateId(c)}:${nameOf(c)}:${c.kind === 'unsynced' ? missingOf(c.setup) : ''}`).join('|');
  const candidates = useMemo(() => list, [signature]); // eslint-disable-line react-hooks/exhaustive-deps

  const latest = useRef({ accounts, setups: loaded?.setups, candidates });
  latest.current = { accounts, setups: loaded?.setups, candidates };

  const open = useCallback((target?: InitialSyncTarget) => {
    const { accounts: all, setups, candidates: offered } = latest.current;
    if (!target) return setShown(offered.length ? offered : null);
    if ('identity' in target) return setShown([{ kind: 'unknown', type: target.type, key: accountKey(target.type, target.identity.userId), identity: target.identity }]);
    const account = all.find((a) => a.key === target.accountKey);
    if (account) setShown([{ kind: 'unsynced', type: account.type, key: account.key, account, setup: setups?.get(account.key) ?? { running: false } }]);
  }, []);

  const switchToIdentity = useCallback(
    (type: SiteType, who: SiteIdentity) => {
      const known = latest.current.accounts.some((a) => a.key === accountKey(type, who.userId));
      if (known) void addAccountFromAction(type, who);
      else open({ type, identity: who });
    },
    [open],
  );

  // Opened from the Moxfield panel (`?initialSync=<account>&as=<username>`): that account's prompt, once.
  const [params, setParams] = useSearchParams();
  const asked = params.get('initialSync');
  useEffect(() => {
    if (!asked || loading || !loaded) return;
    const parsed = parseAccountKey(asked);
    const known = accounts.find((a) => a.key === asked);
    if (known) {
      const setup = loaded.setups.get(known.key);
      if (setup && !isSetUp(setup) && !setup.running) open({ accountKey: known.key });
    } else if (parsed) {
      open({ type: parsed.type, identity: { userId: parsed.userId, userName: params.get('as') || parsed.userId } });
    }
    setParams(
      (p) => {
        const q = new URLSearchParams(p);
        q.delete('initialSync');
        q.delete('as');
        return q;
      },
      { replace: true },
    );
  }, [asked, loading, !!loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const value = useMemo(() => ({ candidates, open, switchToIdentity }), [candidates, open, switchToIdentity]);
  const markPending = useCallback((id: string, on: boolean) => {
    setPending((p) => {
      const next = new Set(p);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const remove = (id: string) => setShown((s) => (s && s.length > 1 ? s.filter((c) => candidateId(c) !== id) : null));

  return (
    <Ctx.Provider value={value}>
      {children}
      <Modal opened={!!shown} onClose={() => setShown(null)} title={shown ? modalTitle(shown) : ''} centered size="lg">
        {shown && (
          <Stack gap="lg">
            {shown.map((c, i) => (
              <Fragment key={candidateId(c)}>
                {i > 0 && <Divider />}
                <CandidateCard
                  candidate={c}
                  sessions={sessions}
                  dismissed={loaded?.dismissed.has(candidateId(c)) ?? false}
                  markPending={markPending}
                  onRemove={() => remove(candidateId(c))}
                  onClose={() => setShown(null)}
                />
              </Fragment>
            ))}
          </Stack>
        )}
      </Modal>
    </Ctx.Provider>
  );
}

function modalTitle(shown: InitialSyncCandidate[]): string {
  if (shown.length > 1) return 'Initial sync of new accounts';
  const c = shown[0];
  const site = siteOf(c.type).label;
  if (c.kind === 'unknown') return `New ${site} account: ${c.identity.userName}`;
  if (c.kind === 'unsynced') return `Initial sync of ${accountLabel(c.account)}`;
  return `Add your ${site} account`;
}

/** Whether the account can be read now: another account logged in on the site would stop the sync at once. */
function LoginNote({ candidate: c, sessions }: { candidate: InitialSyncCandidate; sessions: SiteSessionsView }) {
  const site = siteOf(c.type);
  const others = sessions.live[c.type].filter((id) => accountKey(c.type, id.userId) !== c.key);
  if (c.kind === 'none') {
    return (
      <Text size="sm" c="dimmed">
        Log in to{' '}
        <Anchor href={site.homeUrl} target="_blank" size="sm">
          {site.label} <IconExternalLink size={12} style={{ verticalAlign: 'middle' }} />
        </Anchor>{' '}
        in this browser first: Tithies adds the account logged in there.
      </Text>
    );
  }
  if (sessions.liveKeys.has(c.key)) return null;
  const name = nameOf(c);
  if (others.length) {
    return (
      <Alert color="yellow" variant="light" icon={<IconUserExclamation size={18} />} p="xs">
        <Text size="sm">
          {site.label} is logged in as <b>{others[0].userName}</b> in your open tabs, not as {name}: log in as {name} on {site.label} first, or the sync stops
          without reading anything.
        </Text>
      </Alert>
    );
  }
  if (sessions.silentTabs[c.type] > 0) {
    return (
      <Alert color="gray" variant="light" icon={<IconRefreshAlert size={18} />} p="xs">
        <Text size="sm">Reload your open {site.label} tabs so Tithies can see which account is logged in there.</Text>
      </Alert>
    );
  }
  return (
    <Text size="sm" c="dimmed">
      No {site.label} tab is logged in as {name} right now: Tithies opens {site.label}, which must be logged in as {name}.
    </Text>
  );
}

function CandidateCard({
  candidate: c,
  sessions,
  dismissed,
  markPending,
  onRemove,
  onClose,
}: {
  candidate: InitialSyncCandidate;
  sessions: SiteSessionsView;
  dismissed: boolean;
  markPending(id: string, on: boolean): void;
  /** Done with this account here (added, or "Not now"). */
  onRemove(): void;
  onClose(): void;
}) {
  const site = siteOf(c.type);
  const { accounts, key: currentKey, switchTo } = useCurrentAccount();
  const { switchToIdentity } = useInitialSync();
  const navigate = useNavigate();
  const { run, error, starting, clearError } = useSyncStarter();
  const [following, setFollowing] = useState<{ key: AccountKey; jobId: string; at: number } | null>(null);
  const sync = useSyncState(following?.key ?? null);
  const collection = useCollectionMeta(following?.key ?? null);
  // This start's job (or a later one of the same account), never an earlier sync's leftover state.
  const state = following && sync && (sync.jobId === following.jobId || sync.startedAt >= following.at) ? sync : null;
  const followedAccount = following ? accounts.find((a) => a.key === following.key) : undefined;
  const name = followedAccount ? accountLabel(followedAccount) : nameOf(c);

  const start = async () => {
    const id = candidateId(c);
    const at = Date.now();
    markPending(id, true);
    try {
      const res = await run(async () => {
        if (c.kind === 'unknown') {
          // Added first, so the sync expects this account and never reads whoever else is logged in.
          const row = await addAccountFromAction(c.type, c.identity);
          await setInitialSyncDismissed(row.key, false);
          return startSync(c.type, row.key, true);
        }
        if (c.kind === 'unsynced') {
          await setInitialSyncDismissed(c.key, false);
          if (c.key !== currentKey) await switchTo(c.key);
          return startSync(c.type, c.key, true);
        }
        return startSync(c.type, null, true);
      });
      if (res?.ok) setFollowing({ key: res.accountKey, jobId: res.jobId, at });
    } finally {
      markPending(id, false);
    }
  };
  const notNow = async () => {
    if (c.key) await setInitialSyncDismissed(c.key, true);
    onRemove();
  };
  const addOnly = async () => {
    if (c.kind !== 'unknown') return;
    await addAccountFromAction(c.type, c.identity);
    await setInitialSyncDismissed(c.key, true);
    onRemove();
  };
  const openComparator = async () => {
    if (following && following.key !== currentKey) await switchTo(following.key);
    onClose();
    navigate('/collection/comparator');
  };

  const header = (
    <Group gap="xs" wrap="nowrap">
      <SiteIcon type={c.type} size={20} />
      <Text fw={600} truncate>
        {name}
      </Text>
    </Group>
  );

  // Started: the job's progress, then its outcome.
  if (following) {
    const running = !state || state.status === 'running';
    if (state?.status === 'done') {
      const d = state.decks;
      return (
        <Stack gap="sm">
          {header}
          <Alert color="teal" variant="light" icon={<IconCheck size={18} />} title={`${name} is ready`}>
            <Text size="sm">
              {d ? `${d.total.toLocaleString('en-CA')} deck${d.total === 1 ? '' : 's'}` : 'Its decks'} and{' '}
              {collection ? `${collection.entries.toLocaleString('en-CA')} collection entries (${collection.copies.toLocaleString('en-CA')} copies)` : 'its collection'}{' '}
              are in Tithies now ({state.requests} {site.label} request{state.requests === 1 ? '' : 's'}). Later syncs only read what changed.
            </Text>
          </Alert>
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
            <Button onClick={() => void openComparator()}>Open the Comparator</Button>
          </Group>
        </Stack>
      );
    }
    return (
      <Stack gap="sm">
        {header}
        {state ? (
          <SyncProgress state={state} site={site} onSwitch={(who) => switchToIdentity(c.type, who)} />
        ) : (
          <Group gap="xs">
            <Loader size="xs" />
            <Text size="sm" c="dimmed">
              Starting…
            </Text>
          </Group>
        )}
        {running ? (
          <Text size="xs" c="dimmed">
            You can close this window or leave the page: the sync goes on in the background (see “Running” in the menu).
          </Text>
        ) : null}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
          {running ? (
            <Button variant="subtle" color="gray" leftSection={<IconPlayerStop size={16} />} onClick={() => void cancelSync(c.type)}>
              Cancel the sync
            </Button>
          ) : (
            <Button leftSection={<IconRefresh size={16} />} onClick={() => void start()}>
              Try again
            </Button>
          )}
        </Group>
      </Stack>
    );
  }

  const label = site.label;
  const decksSyncedAt = c.kind === 'unsynced' ? c.setup.decksSyncedAt : undefined;
  return (
    <Stack gap="sm">
      {header}
      <Text size="sm" c="dimmed">
        {c.kind === 'unknown' && `Logged in on ${label} in your open tabs, not in Tithies yet.`}
        {c.kind === 'unsynced' && `Its ${missingOf(c.setup)} never been read.${c.key !== currentKey ? ' Tithies switches to it.' : ''}`}
        {c.kind === 'none' && `No ${label} account in Tithies yet.`}
      </Text>
      <Text size="sm">
        {decksSyncedAt
          ? `${name}'s decks were synced ${timeAgo(decksSyncedAt)}: the initial sync reads the decks changed since, then the whole collection, and keeps it here for the Comparator and the other tools.`
          : `The initial sync reads ${c.kind === 'none' ? 'your' : `${name}'s`} deck list, every deck's cards, then the whole collection, and keeps them here for the Comparator and the other tools.`}{' '}
        Later syncs only read what changed, so they take seconds.
      </Text>
      <Text size="sm" c="dimmed">
        Requests go one at a time, about one per second{decksSyncedAt ? ' (one per page of the collection)' : ': ~270 decks take about 6 minutes'}. If no
        logged-in {label} tab is open, Tithies opens one (shown for a few seconds while {label} starts) and closes it at the end.
      </Text>
      <LoginNote candidate={c} sessions={sessions} />
      {error && <StartError error={error} type={c.type} onCancelled={clearError} />}
      <Group justify="flex-end" gap="xs">
        {c.kind === 'none' || dismissed ? (
          <Button variant="default" onClick={onClose}>
            Close
          </Button>
        ) : (
          <Tooltip
            label={`Tithies stops offering it in the menu. ${c.kind === 'unknown' ? 'The account menu still lists it.' : 'Settings → Accounts still has it.'}`}
            multiline
            w={260}
          >
            <Button variant="subtle" color="gray" disabled={starting} onClick={() => void notNow()}>
              Not now
            </Button>
          </Tooltip>
        )}
        {c.kind === 'unknown' && (
          <Tooltip label={`Shows ${name} in Tithies without reading anything (the selling checks don't need it).`} multiline w={260}>
            <Button variant="default" leftSection={<IconUserPlus size={16} />} disabled={starting} onClick={() => void addOnly()}>
              Add without syncing
            </Button>
          </Tooltip>
        )}
        {starting && (
          <Button variant="subtle" color="gray" leftSection={<IconPlayerStop size={16} />} onClick={() => void cancelSync(c.type)}>
            Cancel
          </Button>
        )}
        <Button leftSection={<IconRefresh size={16} />} loading={starting} onClick={() => void start()}>
          Start initial sync
        </Button>
      </Group>
    </Stack>
  );
}

/** Menu: while some account needs its initial sync. */
export function InitialSyncButton() {
  const { candidates, open } = useInitialSync();
  if (!candidates.length) return null;
  const c = candidates[0];
  const site = siteOf(c.type).label;
  const tip =
    candidates.length > 1
      ? `${candidates.length} accounts whose decks and collection Tithies hasn't read yet`
      : c.kind === 'unknown'
        ? `${site} is logged in as ${c.identity.userName}, an account Tithies doesn't know yet: read its decks and collection`
        : c.kind === 'unsynced'
          ? `${accountLabel(c.account)}'s ${missingOf(c.setup)} never been read`
          : `Log in to ${site}, then read your decks and collection`;
  return (
    <Tooltip label={tip} multiline w={260} withinPortal position="right">
      <Button
        variant="light"
        color="teal"
        size="compact-md"
        fullWidth
        justify="flex-start"
        leftSection={c.kind === 'none' ? <IconInfoCircle size={16} /> : <IconUserPlus size={16} />}
        onClick={() => open()}
      >
        <Text span inherit truncate>
          {c.kind === 'none' && candidates.length === 1 ? `Add your ${site} account` : `Initial sync · ${candidates.length > 1 ? `${candidates.length} accounts` : nameOf(c)}`}
        </Text>
      </Button>
    </Tooltip>
  );
}
