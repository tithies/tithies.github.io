/**
 * Background-only: sends Moxfield requests through a logged-in Moxfield tab (the page makes the
 * request with its own session, so the token never reaches the extension). Uses an open tab when
 * one is logged in, otherwise opens moxfield.com itself and closes it afterwards.
 *
 * Moxfield's app doesn't start in a tab that has never been shown (verified 2026-11-10: a tab
 * opened with `active: false` stays on "Loading Moxfield…" and makes no API request). So Tithies'
 * own tab is opened in the foreground until Moxfield has started, then the previous tab is shown
 * again; once started, the page keeps answering from the background.
 */
import { browser } from 'wxt/browser';
import { sendMessage } from '@/lib/messaging';
import { moxFail, MOX_SYNC_TAB_URL, MOX_TAB_PATTERNS, type MoxApiRequest, type MoxApiResult, type MoxTabStatus } from './api';
import { abortableSleep } from './client';

export interface TabTransportOptions {
  signal?: AbortSignal;
  /** Progress text ("Opening Moxfield in a background tab…"). */
  onStatus?: (message: string) => void;
  /** The tab Tithies opened was closed by the user. */
  onOwnTabClosed?: () => void;
  /** How long to wait for a tab to have a Moxfield session (ms). */
  authWaitMs?: number;
  pollMs?: number;
  /** How many times one job may switch to another tab after losing one. */
  maxReacquire?: number;
}

class NoTabError extends Error {}

export class MoxTabTransport {
  private tabId: number | null = null;
  private ownTabId: number | null = null;
  private keepOwnTab = false;
  private reacquired = 0;
  private reloadedForAuth = false;
  private readonly authWaitMs: number;
  private readonly pollMs: number;
  private readonly maxReacquire: number;

  constructor(private opts: TabTransportOptions = {}) {
    this.authWaitMs = opts.authWaitMs ?? 30_000;
    this.pollMs = opts.pollMs ?? 500;
    this.maxReacquire = opts.maxReacquire ?? 2;
    browser.tabs.onRemoved.addListener(this.onRemoved);
  }

  private onRemoved = (tabId: number) => {
    if (tabId === this.tabId) this.tabId = null;
    if (tabId === this.ownTabId) {
      this.ownTabId = null;
      this.opts.onOwnTabClosed?.();
    }
  };

  private async status(tabId: number): Promise<MoxTabStatus | null> {
    try {
      return await sendMessage('moxfieldStatus', undefined, tabId);
    } catch {
      return null; // no content script there (still loading, discarded, or injected by an older build)
    }
  }

  private async waitForAuth(tabId: number): Promise<boolean> {
    const end = Date.now() + this.authWaitMs;
    while (Date.now() < end) {
      if ((await this.status(tabId))?.hasAuth) return true;
      if (this.ownTabId !== tabId && this.tabId !== tabId) return false; // closed meanwhile
      await abortableSleep(this.pollMs, this.opts.signal);
    }
    return false;
  }

  /**
   * Shows `tabId` until its Moxfield session is ready (`start` = create/reload it meanwhile), then
   * switches back to whatever tab was in front before. Returns whether the session is ready.
   */
  private async showUntilReady(tabId: number | null, start: () => Promise<number>): Promise<boolean> {
    const [previous] = await browser.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
    const id = await start();
    if (tabId != null) await browser.tabs.update(tabId, { active: true }).catch(() => {});
    const ready = await this.waitForAuth(id);
    if (ready && previous?.id != null && previous.id !== id) await browser.tabs.update(previous.id, { active: true }).catch(() => {});
    return ready;
  }

  /** Picks the tab requests go through: Tithies' own tab, else a logged-in open tab, else a new tab of its own. */
  private async acquire(): Promise<number> {
    if (this.ownTabId != null && (await this.status(this.ownTabId))?.hasAuth) return (this.tabId = this.ownTabId);

    const tabs = await browser.tabs.query({ url: MOX_TAB_PATTERNS, discarded: false });
    tabs.sort((a, b) => Number(b.active) - Number(a.active) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
    for (const t of tabs) {
      if (t.id == null || t.id === this.ownTabId) continue;
      if ((await this.status(t.id))?.hasAuth) return (this.tabId = t.id);
    }

    this.opts.onStatus?.('Opening Moxfield (shown for a moment while it starts)…');
    const ready = await this.showUntilReady(this.ownTabId, async () => {
      if (this.ownTabId == null) {
        const tab = await browser.tabs.create({ url: MOX_SYNC_TAB_URL, active: true });
        if (tab.id == null) throw new NoTabError("Couldn't open a Moxfield tab.");
        this.ownTabId = tab.id;
      }
      this.tabId = this.ownTabId;
      return this.ownTabId;
    });
    if (ready && this.ownTabId != null) return this.ownTabId;
    // Leave the tab open so the user can log in there.
    this.keepOwnTab = true;
    throw new NoTabError('Moxfield has no logged-in session. Log in to moxfield.com (Tithies left a Moxfield tab open for you), then try again.');
  }

  /** One request. Never throws: failures come back as `{ ok: false }`. */
  call = async (req: MoxApiRequest): Promise<MoxApiResult> => {
    for (;;) {
      let tabId: number;
      try {
        tabId = this.tabId ?? (await this.acquire());
      } catch (e) {
        if (this.opts.signal?.aborted) throw e;
        return moxFail(0, 'no_tab', e instanceof Error ? e.message : String(e));
      }
      let res: MoxApiResult;
      try {
        res = await sendMessage('moxfieldApi', req, tabId);
      } catch {
        // The tab was closed, reloaded or navigated away mid-request.
        this.tabId = null;
        if (this.reacquired++ < this.maxReacquire) continue;
        return moxFail(0, 'tab_lost', 'Lost the Moxfield tab (closed or reloaded). Try again.');
      }
      if (res == null) {
        this.tabId = null;
        if (this.reacquired++ < this.maxReacquire) continue;
        return moxFail(0, 'tab_lost', 'The Moxfield tab stopped answering. Reload it and try again.');
      }
      // The session of a hidden tab can expire: reload Tithies' own tab once to get a fresh one.
      if (!res.ok && res.code === 'no_auth' && tabId === this.ownTabId && !this.reloadedForAuth) {
        this.reloadedForAuth = true;
        this.opts.onStatus?.('Refreshing the Moxfield session…');
        const refreshed = await this.showUntilReady(tabId, async () => {
          await browser.tabs.reload(tabId);
          await abortableSleep(2000, this.opts.signal); // let the old page go away first
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
    browser.tabs.onRemoved.removeListener(this.onRemoved);
    const own = this.ownTabId;
    this.ownTabId = null;
    this.tabId = null;
    if (own != null && !this.keepOwnTab && !opts.keepOwnTab) await browser.tabs.remove(own).catch(() => {});
  }
}
