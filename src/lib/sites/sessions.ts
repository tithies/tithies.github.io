/**
 * Which account each open site tab is logged in as, for the dashboard's "logged in" dot and
 * hints. Kept in chrome.storage.session (cleared when the browser closes or the extension
 * reloads), written only by the background worker, read by the dashboard through a watcher.
 * Sessions never add accounts: only an action does (see src/lib/accounts).
 */
import { storage } from '#imports';
import type { SiteIdentity, SiteType } from './types';

export interface TabSession {
  tabId: number;
  type: SiteType;
  hasAuth: boolean;
  identity: SiteIdentity | null;
  at: number;
}

export const siteSessionsItem = storage.defineItem<TabSession[]>('session:siteSessions', { fallback: [] });

type SessionStore = Pick<typeof siteSessionsItem, 'getValue' | 'setValue'>;

/** Serialises every change, so concurrent reports never overwrite each other. */
export class SessionRegistry {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private item: SessionStore = siteSessionsItem,
    private now: () => number = Date.now,
  ) {}

  private mutate(fn: (list: TabSession[]) => TabSession[] | null): Promise<void> {
    const next = this.chain.then(async () => {
      const cur = (await this.item.getValue()) ?? [];
      const out = fn(cur);
      if (out) await this.item.setValue(out);
    });
    this.chain = next.catch(() => {});
    return next;
  }

  report(s: Omit<TabSession, 'at'>): Promise<void> {
    const row: TabSession = { ...s, identity: s.hasAuth ? s.identity : null, at: this.now() };
    return this.mutate((list) => [...list.filter((x) => x.tabId !== s.tabId), row]);
  }

  forget(tabId: number): Promise<void> {
    return this.mutate((list) => (list.some((x) => x.tabId === tabId) ? list.filter((x) => x.tabId !== tabId) : null));
  }

  /** Keeps only the sessions of tabs still open on their site. */
  prune(openTabIds: ReadonlySet<number>): Promise<void> {
    return this.mutate((list) => (list.every((x) => openTabIds.has(x.tabId)) ? null : list.filter((x) => openTabIds.has(x.tabId))));
  }
}

/** The accounts logged in right now on a site (each once). */
export function liveIdentities(sessions: readonly TabSession[], type: SiteType): SiteIdentity[] {
  const byId = new Map<string, SiteIdentity>();
  for (const s of [...sessions].sort((a, b) => b.at - a.at)) {
    if (s.type === type && s.hasAuth && s.identity && !byId.has(s.identity.userId)) byId.set(s.identity.userId, s.identity);
  }
  return [...byId.values()];
}
