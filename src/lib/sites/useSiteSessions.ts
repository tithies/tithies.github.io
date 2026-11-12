/** Dashboard: which accounts are logged in on each site right now, from the open site tabs. */
import { useEffect, useMemo, useState } from 'react';
import { browser } from 'wxt/browser';
import { accountKey, type AccountKey } from '@/lib/accounts/types';
import { sendMessage } from '@/lib/messaging';
import { SITE_TYPES, siteOf } from './registry';
import { liveIdentities, siteSessionsItem, type TabSession } from './sessions';
import type { SiteIdentity, SiteType } from './types';

export interface SiteSessionsView {
  sessions: TabSession[];
  /** Accounts logged in right now, per site. */
  live: Record<SiteType, SiteIdentity[]>;
  liveKeys: Set<AccountKey>;
  /** Open site tabs that never said who is logged in (opened before Tithies was installed, updated or reloaded). */
  silentTabs: Record<SiteType, number>;
}

/** Tabs report within a second or so of loading: only call a tab silent after this. */
const SILENT_AFTER_MS = 4000;

export function useSiteSessions(): SiteSessionsView {
  const [sessions, setSessions] = useState<TabSession[]>([]);
  const [openTabs, setOpenTabs] = useState<Record<SiteType, number[]>>(() => Object.fromEntries(SITE_TYPES.map((t) => [t, []])) as unknown as Record<SiteType, number[]>);

  useEffect(() => {
    let alive = true;
    void sendMessage('pruneSessions', undefined).catch(() => {});
    void siteSessionsItem.getValue().then((v) => alive && setSessions(v ?? []));
    const unwatch = siteSessionsItem.watch((v) => setSessions(v ?? []));
    const scan = async () => {
      const next = {} as Record<SiteType, number[]>;
      for (const type of SITE_TYPES) {
        const tabs = await browser.tabs.query({ url: siteOf(type).tabPatterns, discarded: false }).catch(() => []);
        next[type] = tabs.map((t) => t.id).filter((id): id is number => id != null);
      }
      if (alive) setOpenTabs(next);
    };
    const timer = setTimeout(scan, SILENT_AFTER_MS);
    const interval = setInterval(scan, 15_000);
    return () => {
      alive = false;
      unwatch();
      clearTimeout(timer);
      clearInterval(interval);
    };
  }, []);

  return useMemo(() => {
    const live = {} as Record<SiteType, SiteIdentity[]>;
    const silentTabs = {} as Record<SiteType, number>;
    const liveKeys = new Set<AccountKey>();
    const reported = new Set(sessions.map((s) => s.tabId));
    for (const type of SITE_TYPES) {
      live[type] = liveIdentities(sessions, type);
      for (const id of live[type]) liveKeys.add(accountKey(type, id.userId));
      silentTabs[type] = (openTabs[type] ?? []).filter((id) => !reported.has(id)).length;
    }
    return { sessions, live, liveKeys, silentTabs };
  }, [sessions, openTabs]);
}
