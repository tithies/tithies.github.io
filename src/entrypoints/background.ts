import { defineBackground } from '#imports';
import { browser } from 'wxt/browser';
import { db } from '@/lib/db';
import { AccountSyncJob } from '@/lib/decks/job';
import { holdAwake } from '@/lib/keepalive';
import { onMessage, sendMessage } from '@/lib/messaging';
import { SITE_TYPES, siteOf } from '@/lib/sites/registry';
import { TabTransport } from '@/lib/sites/tab-transport';
import type { SiteType } from '@/lib/sites/types';
import { getSettings } from '@/lib/settings';
import { controlRun, createRun, Runner, toProgress } from '@/features/f2f-buylist/runner';
import type { Run } from '@/features/f2f-buylist/types';

const WATCHDOG = 'tithies-watchdog';

export default defineBackground(() => {
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
        createTransport: (ctl) => new TabTransport(site, ctl),
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
    const res = await createRun({ ...data.source, tabId: sender.tab?.id }, data.entries, settings.creditBonus);
    runner.kick();
    return res;
  });

  onMessage('controlRun', async ({ data }) => {
    const ok = await controlRun(data.runId, data.action);
    if (ok && (data.action === 'resume' || data.action === 'retryErrors')) runner.kick();
    const run = await db.runs.get(data.runId);
    if (run) notify(run);
    return { ok, error: ok ? undefined : 'Action not available for this run' };
  });

  onMessage('openDashboard', ({ data }) => void openDashboard(data.runId));

  onMessage('startAccountSync', ({ data }) => syncJobs[data.type].start({ collection: data.collection }));
  onMessage('cancelAccountSync', ({ data }) => ({ ok: syncJobs[data.type].cancel() }));

  onMessage('getProgress', async ({ data, sender }) => {
    let run = data.runId ? await db.runs.get(data.runId) : undefined;
    if (!run && sender.tab?.id != null) {
      const tabRuns = await db.runs.filter((r) => r.source.tabId === sender.tab!.id).toArray();
      run = tabRuns.sort((a, b) => b.createdAt - a.createdAt)[0];
    }
    return run ? toProgress(run) : null;
  });

  browser.action.onClicked.addListener(() => void openDashboard());

  // Resume runs interrupted by a browser restart or a worker shutdown.
  browser.alarms.create(WATCHDOG, { periodInMinutes: 1 });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG && !runner.isActive) runner.kick();
  });
  browser.runtime.onStartup.addListener(() => runner.kick());
  runner.kick();
});
