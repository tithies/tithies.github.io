/**
 * Background-only: sends site requests through a logged-in tab of that site (the page makes the
 * request with its own session, so the token never reaches the extension). Uses an open tab when
 * one is logged in, otherwise opens the site itself and closes it afterwards.
 *
 * Moxfield's app doesn't start in a tab that has never been shown (verified 2026-11-10: a tab
 * opened with `active: false` stays on "Loading Moxfield…" and makes no API request). So Tithies'
 * own tab is opened in the foreground until the site has started, then the previous tab is shown
 * again; once started, the page keeps answering from the background.
 */
import { browser } from 'wxt/browser';
import { sendMessage } from '@/lib/messaging';
import { abortableSleep } from './client';
import type { SiteProvider } from './provider';
import { siteFail, type SiteApiCall, type SiteIdentity, type SiteRequest, type SiteResult, type SiteTabStatus } from './types';

/** The tab operations the transport needs (the real one is Chrome's; tests pass a fake). */
export interface TabPort {
  /** Open, non-discarded tabs matching `patterns`, most relevant first is not required. */
  query(patterns: string[]): Promise<{ id: number; active: boolean; lastAccessed?: number }[]>;
  /** The tab in front of the last focused window. */
  activeTabId(): Promise<number | undefined>;
  create(url: string): Promise<number | undefined>;
  activate(tabId: number): Promise<void>;
  reload(tabId: number): Promise<void>;
  remove(tabId: number): Promise<void>;
  /** The site page's status, or null when no content script answers there. */
  status(tabId: number): Promise<SiteTabStatus | null>;
  /** One request made by the page. Throws when the tab went away mid-request. */
  call(tabId: number, call: SiteApiCall): Promise<SiteResult | null | undefined>;
  onRemoved(listener: (tabId: number) => void): () => void;
}

export const chromeTabPort: TabPort = {
  async query(patterns) {
    const tabs = await browser.tabs.query({ url: patterns, discarded: false });
    return tabs.filter((t) => t.id != null).map((t) => ({ id: t.id!, active: t.active, lastAccessed: t.lastAccessed }));
  },
  async activeTabId() {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    return tab?.id;
  },
  async create(url) {
    return (await browser.tabs.create({ url, active: true })).id;
  },
  async activate(tabId) {
    await browser.tabs.update(tabId, { active: true }).catch(() => {});
  },
  async reload(tabId) {
    await browser.tabs.reload(tabId);
  },
  async remove(tabId) {
    await browser.tabs.remove(tabId).catch(() => {});
  },
  async status(tabId) {
    try {
      return await sendMessage('siteStatus', undefined, tabId);
    } catch {
      return null; // no content script there (still loading, discarded, or injected by an older build)
    }
  },
  call: (tabId, call) => sendMessage('siteApi', call, tabId),
  onRemoved(listener) {
    browser.tabs.onRemoved.addListener(listener);
    return () => browser.tabs.onRemoved.removeListener(listener);
  },
};

export interface TabTransportOptions {
  signal?: AbortSignal;
  /** Progress text ("Opening Moxfield…"). */
  onStatus?: (message: string) => void;
  /** The tab Tithies opened was closed by the user. */
  onOwnTabClosed?: () => void;
  /** How long to wait for a tab to have a session (ms). */
  authWaitMs?: number;
  pollMs?: number;
  /** How many times one job may switch to another tab after losing one. */
  maxReacquire?: number;
  /** Pause after reloading Tithies' own tab, so the old page has gone (ms). */
  reloadSettleMs?: number;
  /**
   * Whose session requests may use. An account: only tabs logged in as it, and every request is
   * refused by the page if its session isn't that account's. 'first': the first logged-in account
   * found, then only that one (see `identity`). Unset: any logged-in tab, no account checks.
   */
  expect?: SiteIdentity | 'first';
}

class NoTabError extends Error {}

/** The site is logged in as another account than the one asked for. */
class WrongAccountError extends Error {
  constructor(
    message: string,
    readonly actual: SiteIdentity | null,
  ) {
    super(message);
  }
}

export class TabTransport {
  private tabId: number | null = null;
  private ownTabId: number | null = null;
  private keepOwnTab = false;
  private reacquired = 0;
  private reloadedForAuth = false;
  private readonly authWaitMs: number;
  private readonly pollMs: number;
  private readonly maxReacquire: number;
  private readonly reloadSettleMs: number;
  private readonly stopListening: () => void;
  private readonly checked: boolean;
  private expected: SiteIdentity | null;

  constructor(
    private site: Pick<SiteProvider, 'label' | 'tabPatterns' | 'syncTabUrl'>,
    private opts: TabTransportOptions = {},
    private port: TabPort = chromeTabPort,
  ) {
    this.authWaitMs = opts.authWaitMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 500;
    this.maxReacquire = opts.maxReacquire ?? 2;
    this.reloadSettleMs = opts.reloadSettleMs ?? 2000;
    this.checked = opts.expect !== undefined;
    this.expected = opts.expect && opts.expect !== 'first' ? opts.expect : null;
    this.stopListening = port.onRemoved(this.onRemoved);
  }

  /** The account requests are made as (with `expect`): the expected one, or the first one found. */
  get identity(): SiteIdentity | null {
    return this.expected;
  }

  /**
   * Whether requests may go through this tab. With account checks: only a session whose account
   * is known and is the expected one (binding 'first' to it); other accounts go to `others`.
   */
  private async usable(tabId: number, others: SiteIdentity[]): Promise<boolean> {
    const st = await this.port.status(tabId);
    if (!st?.hasAuth) return false;
    if (!this.checked) return true;
    const id = st.identity ?? null;
    if (!id) return false;
    if (!this.expected) this.expected = id;
    if (id.userId === this.expected.userId) return true;
    if (!others.some((o) => o.userId === id.userId)) others.push(id);
    return false;
  }

  private wrongAccount(actual: SiteIdentity): WrongAccountError {
    const { label } = this.site;
    const want = this.expected ? ` Log in as ${this.expected.userName} on ${label}, then try again.` : '';
    return new WrongAccountError(`${label} is logged in as ${actual.userName}.${want}`, actual);
  }

  private onRemoved = (tabId: number) => {
    if (tabId === this.tabId) this.tabId = null;
    if (tabId === this.ownTabId) {
      this.ownTabId = null;
      this.opts.onOwnTabClosed?.();
    }
  };

  private async waitForAuth(tabId: number): Promise<boolean> {
    const end = Date.now() + this.authWaitMs;
    while (Date.now() < end) {
      if ((await this.port.status(tabId))?.hasAuth) return true;
      if (this.ownTabId !== tabId && this.tabId !== tabId) return false; // closed meanwhile
      await abortableSleep(this.pollMs, this.opts.signal);
    }
    return false;
  }

  /**
   * Shows `tabId` until its session is ready (`start` = create/reload it meanwhile), then
   * switches back to whatever tab was in front before. Returns whether the session is ready.
   */
  private async showUntilReady(tabId: number | null, start: () => Promise<number>): Promise<boolean> {
    const previous = await this.port.activeTabId().catch(() => undefined);
    const id = await start();
    if (tabId != null) await this.port.activate(tabId);
    const ready = await this.waitForAuth(id);
    if (ready && previous != null && previous !== id) await this.port.activate(previous);
    return ready;
  }

  /** Picks the tab requests go through: Tithies' own tab, else a logged-in open tab, else a new tab of its own. */
  private async acquire(): Promise<number> {
    const others: SiteIdentity[] = [];
    if (this.ownTabId != null && (await this.usable(this.ownTabId, others))) return (this.tabId = this.ownTabId);

    const tabs = await this.port.query(this.site.tabPatterns);
    tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    for (const t of tabs) {
      if (t.id === this.ownTabId) continue;
      if (await this.usable(t.id, others)) return (this.tabId = t.id);
    }
    // Logged in as someone else: a new tab would be too (one login per browser profile).
    if (others.length) throw this.wrongAccount(others[0]);

    const { label } = this.site;
    this.opts.onStatus?.(`Opening ${label} (shown for a moment while it starts)…`);
    const ready = await this.showUntilReady(this.ownTabId, async () => {
      if (this.ownTabId == null) {
        const id = await this.port.create(this.site.syncTabUrl);
        if (id == null) throw new NoTabError(`Couldn't open a ${label} tab.`);
        this.ownTabId = id;
      }
      this.tabId = this.ownTabId;
      return this.ownTabId;
    });
    if (ready && this.ownTabId != null) {
      if (await this.usable(this.ownTabId, others)) return this.ownTabId;
      // Leave the tab open so the user can log in as the right account there.
      this.keepOwnTab = true;
      if (others.length) throw this.wrongAccount(others[0]);
      throw new NoTabError(`Couldn't tell which ${label} account is logged in. Reload the ${label} tab, then try again.`);
    }
    // Leave the tab open so the user can log in there.
    this.keepOwnTab = true;
    throw new NoTabError(`${label} has no logged-in session. Log in to ${label} (Tithies left a ${label} tab open for you), then try again.`);
  }

  /** One request. Never throws (except when cancelled): failures come back as `{ ok: false }`. */
  call = async (req: SiteRequest): Promise<SiteResult> => {
    const { label } = this.site;
    for (;;) {
      let tabId: number;
      try {
        tabId = this.tabId ?? (await this.acquire());
      } catch (e) {
        if (this.opts.signal?.aborted) throw e;
        if (e instanceof WrongAccountError) return siteFail(0, 'wrong_account', e.message, e.actual);
        return siteFail(0, 'no_tab', e instanceof Error ? e.message : String(e));
      }
      let res: SiteResult | null | undefined;
      try {
        res = await this.port.call(tabId, this.checked ? { req, expect: this.expected?.userId } : { req });
      } catch {
        // The tab was closed, reloaded or navigated away mid-request.
        this.tabId = null;
        if (this.reacquired++ < this.maxReacquire) continue;
        return siteFail(0, 'tab_lost', `Lost the ${label} tab (closed or reloaded). Try again.`);
      }
      if (res == null) {
        this.tabId = null;
        if (this.reacquired++ < this.maxReacquire) continue;
        return siteFail(0, 'tab_lost', `The ${label} tab stopped answering. Reload it and try again.`);
      }
      if (this.checked) {
        // A content script from before account checks doesn't say who answered: never trust it.
        if (res.as === undefined) {
          this.tabId = null;
          return siteFail(0, 'tab_lost', `The ${label} tab runs an older version of Tithies: reload it, then try again.`);
        }
        // The tab now belongs to another account: look for another tab still logged in as the right one.
        // (A failure made as nobody, e.g. "no session", is handled below like any failure.)
        const otherAccount = res.as ? res.as.userId !== this.expected?.userId : res.ok;
        if ((!res.ok && res.code === 'wrong_account') || otherAccount) {
          this.tabId = null;
          if (this.reacquired++ < this.maxReacquire) continue;
          return res.ok ? siteFail(0, 'wrong_account', `${label} answered as another account.`, res.as) : res;
        }
      }
      // The session of a hidden tab can expire: reload Tithies' own tab once to get a fresh one.
      if (!res.ok && res.code === 'no_auth' && tabId === this.ownTabId && !this.reloadedForAuth) {
        this.reloadedForAuth = true;
        this.opts.onStatus?.(`Refreshing the ${label} session…`);
        const refreshed = await this.showUntilReady(tabId, async () => {
          await this.port.reload(tabId);
          await abortableSleep(this.reloadSettleMs, this.opts.signal); // let the old page go away first
          return tabId;
        });
        if (refreshed) continue;
        this.keepOwnTab = true;
      }
      return res;
    }
  };

  /** Closes the tab Tithies opened (unless the user must log in there) and stops listening. */
  async release(opts: { keepOwnTab?: boolean } = {}): Promise<void> {
    this.stopListening();
    const own = this.ownTabId;
    this.ownTabId = null;
    this.tabId = null;
    if (own != null && !this.keepOwnTab && !opts.keepOwnTab) await this.port.remove(own);
  }
}
