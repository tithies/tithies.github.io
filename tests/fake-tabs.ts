/** Fake browser tabs of a site whose pages answer like the Moxfield page hook (shared by tests). */
import type { TabPort } from '@/lib/sites/tab-transport';
import type { SiteApiCall, SiteIdentity, SiteResult, SiteTabStatus } from '@/lib/sites/types';

export const ALICE: SiteIdentity = { userId: '111111', userName: 'alice' };
export const BOB: SiteIdentity = { userId: '222222', userName: 'bob' };

export interface FakeTab {
  id: number;
  active?: boolean;
  /** Who is logged in there (null = logged out). */
  account: SiteIdentity | null;
  /** Content script from before account checks: answers without `as`. */
  old?: boolean;
  /** A buggy page that sends requests as whoever is logged in, ignoring `expect`. */
  ignoresExpect?: boolean;
}

/** Tabs whose pages answer like the Moxfield hook: refuse a request for another account, say who answered. */
export class FakeTabs implements TabPort {
  tabs: FakeTab[] = [];
  created: number[] = [];
  removed: number[] = [];
  calls: { tabId: number; call: SiteApiCall }[] = [];
  /** Account a newly created tab comes up logged in as. */
  newTabAccount: SiteIdentity | null = null;
  /** What a logged-in page answers, as `account` (default: an empty deck list). */
  answer: (account: SiteIdentity, call: SiteApiCall, tab: FakeTab) => SiteResult | Promise<SiteResult> = () => ({ ok: true, kind: 'deckList', decks: [] });
  /** Runs first on every request (e.g. to switch the tab's login at a given request). */
  onCall: (call: SiteApiCall, tab: FakeTab) => void | Promise<void> = () => {};
  private nextId = 100;
  private removedListeners: ((id: number) => void)[] = [];

  async query() {
    return this.tabs.map((t) => ({ id: t.id, active: !!t.active }));
  }
  async activeTabId() {
    return this.tabs.find((t) => t.active)?.id;
  }
  async create() {
    const id = this.nextId++;
    this.created.push(id);
    this.tabs.push({ id, account: this.newTabAccount });
    return id;
  }
  async activate() {}
  async reload() {}
  async remove(tabId: number) {
    this.removed.push(tabId);
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
  }
  async status(tabId: number): Promise<SiteTabStatus | null> {
    const t = this.tabs.find((x) => x.id === tabId);
    if (!t) return null;
    return t.old ? { hasAuth: !!t.account, path: '/' } : { hasAuth: !!t.account, identity: t.account, path: '/' };
  }
  async call(tabId: number, call: SiteApiCall): Promise<SiteResult> {
    this.calls.push({ tabId, call });
    const t = this.tabs.find((x) => x.id === tabId);
    if (!t) throw new Error('tab gone');
    await this.onCall(call, t);
    if (t.old) {
      const { as: _as, ...res } = await this.answer(t.account!, call, t);
      return res as SiteResult;
    }
    if (!t.account) return { ok: false, status: 0, code: 'no_auth', message: 'log in', as: null };
    if (call.expect !== undefined && call.expect !== t.account.userId && !t.ignoresExpect) {
      return { ok: false, status: 0, code: 'wrong_account', message: `Moxfield is logged in as ${t.account.userName} in this tab.`, as: t.account };
    }
    const account = t.account;
    return { ...(await this.answer(account, call, t)), as: account };
  }
  onRemoved(l: (id: number) => void) {
    this.removedListeners.push(l);
    return () => (this.removedListeners = this.removedListeners.filter((x) => x !== l));
  }
}
