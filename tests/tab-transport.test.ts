import { TabTransport } from '@/lib/sites/tab-transport';
import type { SiteResult } from '@/lib/sites/types';
import { ALICE, BOB, FakeTabs } from './fake-tabs';

const SITE = { label: 'Moxfield', tabPatterns: ['https://moxfield.com/*'], syncTabUrl: 'https://moxfield.com/decks/personal' };

const opts = { authWaitMs: 50, pollMs: 5, reloadSettleMs: 0 };
const req = { kind: 'deckList' } as const;

describe('Tab transport', () => {
  it('without account checks, uses any logged-in tab (as before)', async () => {
    const port = new FakeTabs();
    port.tabs = [{ id: 1, account: BOB, active: true }];
    const t = new TabTransport(SITE, opts, port);
    expect(await t.call(req)).toMatchObject({ ok: true });
    expect(port.calls[0].call).toEqual({ req });
  });

  it('uses only tabs logged in as the expected account, and asks the page to check', async () => {
    const port = new FakeTabs();
    port.tabs = [
      { id: 1, account: BOB, active: true },
      { id: 2, account: ALICE },
    ];
    const t = new TabTransport(SITE, { ...opts, expect: ALICE }, port);
    expect(await t.call(req)).toMatchObject({ ok: true, as: ALICE });
    expect(port.calls).toEqual([{ tabId: 2, call: { req, expect: ALICE.userId } }]);
  });

  it('when only another account is logged in, fails naming it and opens no tab', async () => {
    const port = new FakeTabs();
    port.tabs = [{ id: 1, account: BOB, active: true }];
    const t = new TabTransport(SITE, { ...opts, expect: ALICE }, port);
    expect(await t.call(req)).toMatchObject({ ok: false, code: 'wrong_account', as: BOB, message: 'Moxfield is logged in as bob. Log in as alice on Moxfield, then try again.' });
    expect(port.created).toEqual([]);
    expect(port.calls).toEqual([]);
  });

  it("opens its own tab when none is open; if it comes up as another account, keeps it for logging in", async () => {
    const port = new FakeTabs();
    port.newTabAccount = BOB;
    const t = new TabTransport(SITE, { ...opts, expect: ALICE }, port);
    expect(await t.call(req)).toMatchObject({ ok: false, code: 'wrong_account', as: BOB });
    await t.release();
    expect(port.created).toHaveLength(1);
    expect(port.removed).toEqual([]);
  });

  it('closes its own tab when it was logged in as the right account', async () => {
    const port = new FakeTabs();
    port.newTabAccount = ALICE;
    const t = new TabTransport(SITE, { ...opts, expect: ALICE }, port);
    expect(await t.call(req)).toMatchObject({ ok: true, as: ALICE });
    await t.release();
    expect(port.removed).toEqual(port.created);
  });

  it("'first' binds to the first logged-in account, then sticks to it", async () => {
    const port = new FakeTabs();
    port.tabs = [{ id: 1, account: ALICE, active: true }];
    const t = new TabTransport(SITE, { ...opts, expect: 'first' }, port);
    expect(t.identity).toBeNull();
    expect(await t.call(req)).toMatchObject({ ok: true, as: ALICE });
    expect(t.identity).toEqual(ALICE);
    // The tab logs in as bob: the next request is refused by the page, and no other tab has alice.
    port.tabs[0].account = BOB;
    expect(await t.call(req)).toMatchObject({ ok: false, code: 'wrong_account', as: BOB });
    expect(port.calls.slice(1).every((c) => c.call.expect === ALICE.userId)).toBe(true);
  });

  it('after a mid-job switch, moves to another tab still logged in as the account', async () => {
    const port = new FakeTabs();
    port.tabs = [
      { id: 1, account: ALICE, active: true },
      { id: 2, account: ALICE },
    ];
    const t = new TabTransport(SITE, { ...opts, expect: ALICE }, port);
    await t.call(req);
    port.tabs[0].account = BOB;
    expect(await t.call(req)).toMatchObject({ ok: true, as: ALICE });
    expect(port.calls.map((c) => c.tabId)).toEqual([1, 1, 2]);
  });

  it('never trusts a page that does not say who answered', async () => {
    const port = new FakeTabs();
    port.tabs = [{ id: 1, account: ALICE, old: true }];
    // An old content script reports no identity: not usable, so Tithies opens its own tab.
    port.newTabAccount = null;
    const t = new TabTransport(SITE, { ...opts, expect: ALICE }, port);
    expect(await t.call(req)).toMatchObject({ ok: false, code: 'no_tab' });
    expect(port.calls).toEqual([]);
  });

  it('a tab that answers without `as` is refused', async () => {
    const port = new FakeTabs();
    port.tabs = [{ id: 1, account: ALICE }];
    const t = new TabTransport(SITE, { ...opts, expect: ALICE }, port);
    port.call = async () => ({ ok: true, kind: 'deckList', decks: [] }); // no `as`
    expect(await t.call(req)).toMatchObject({ ok: false, code: 'tab_lost', message: expect.stringContaining('older version') });
  });
});
