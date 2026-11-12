import { defineBackground } from '#imports';
import { browser } from 'wxt/browser';
import { findRun } from '@/lib/accounts/data';
import { migrateStorage } from '@/lib/accounts/migrate';
import { AccountSyncJob } from '@/lib/decks/job';
import { holdAwake } from '@/lib/keepalive';
import { onMessage, sendMessage } from '@/lib/messaging';
import { isSiteType, SITE_TYPES, siteOf } from '@/lib/sites/registry';
import { SessionRegistry } from '@/lib/sites/sessions';
import { chromeTabPort, TabTransport } from '@/lib/sites/tab-transport';
import { parseIdentity } from '@/lib/sites/validate';
import type { SiteType } from '@/lib/sites/types';
import { getSettings } from '@/lib/settings';
import { controlRun, Runner, toProgress } from '@/features/f2f-buylist/runner';
import { progressFor, startRunFromSite } from '@/features/f2f-buylist/start';
import type { Run } from '@/features/f2f-buylist/types';

const WATCHDOG = 'tithies-watchdog';

export default defineBackground(() => {
  void migrateStorage().catch(() => {});

  const notify = (run: Run, message?: string) => {
    const tabId = run.source.tabId;
    if (tabId == null) return;
    sendMessage('runProgress', toProgress(run, message), tabId).catch(() => {
      /* tab closed or navigated away: progress is still visible in the dashboard */
    });
  };

  const runner = new Runner({
    onProgress: notify,
    onActiveChange: (active) => holdAwake('f2f-runner', active),
  });

  // Decks + collection of each site, read through a logged-in tab of that site (shared by deck features).
  const syncJobs = Object.fromEntries(
    SITE_TYPES.map((type) => {
      const site = siteOf(type);
      const job = new AccountSyncJob(site, {
        createTransport: ({ expect, ...ctl }) => new TabTransport(site, { ...ctl, expect }),
        onActiveChange: (active) => holdAwake(`${type}-sync`, active),
      });
      return [type, job];
    }),
  ) as Record<SiteType, AccountSyncJob>;
  for (const job of Object.values(syncJobs)) void job.markStale();

  const openDashboard = (runId?: number) =>
    browser.tabs.create({ url: browser.runtime.getURL('/dashboard.html') + (runId ? `#/f2f/runs/${runId}` : '#/f2f/runs') });

  onMessage('startRun', async ({ data, sender }) => {
    const settings = await getSettings();
    const res = await startRunFromSite(data, sender.tab?.id, settings.creditBonus);
    runner.kick();
    return res;
  });

  onMessage('controlRun', async ({ data }) => {
    const ok = await controlRun(data.runId, data.action);
    if (ok && (data.action === 'resume' || data.action === 'retryErrors')) runner.kick();
    const run = await findRun(data.runId);
    if (run) notify(run);
    return { ok, error: ok ? undefined : 'Action not available for this run' };
  });

  onMessage('openDashboard', ({ data }) => void openDashboard(data.runId));

  onMessage('startAccountSync', ({ data }) => {
    if (!isSiteType(data.type)) return { ok: false, code: 'no_account', error: 'Unknown site.' } as const;
    return syncJobs[data.type].start({ accountKey: data.accountKey ?? null, collection: data.collection === true });
  });
  onMessage('cancelAccountSync', ({ data }) => ({ ok: syncJobs[data.type].cancel() }));

  onMessage('getProgress', ({ data, sender }) => progressFor(data, sender.tab?.id));

  // Which account each open site tab is logged in as (dashboard dot and hints; never adds accounts).
  const sessions = new SessionRegistry();
  const pruneSessions = async () => {
    const open = new Set<number>();
    for (const type of SITE_TYPES) for (const t of await chromeTabPort.query(siteOf(type).tabPatterns).catch(() => [])) open.add(t.id);
    await sessions.prune(open);
  };
  onMessage('siteSessionChanged', ({ data, sender }) => {
    const tabId = sender.tab?.id;
    if (tabId == null || !isSiteType(data?.type)) return;
    const hasAuth = data.hasAuth === true;
    void sessions.report({ tabId, type: data.type, hasAuth, identity: hasAuth ? parseIdentity(data.identity) : null });
  });
  onMessage('pruneSessions', () => pruneSessions());
  browser.tabs.onRemoved.addListener((tabId) => void sessions.forget(tabId));
  browser.tabs.onReplaced.addListener((_added, removed) => void sessions.forget(removed));
  void pruneSessions();

  browser.action.onClicked.addListener(() => void openDashboard());

  // Resume runs interrupted by a browser restart or a worker shutdown.
  browser.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG && !runner.isActive) runner.kick();
  });
  browser.runtime.onStartup.addListener(() => runner.kick());
  runner.kick();
});
