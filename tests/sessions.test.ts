import { liveIdentities, SessionRegistry, type TabSession } from '@/lib/sites/sessions';

const ALICE = { userId: '111111', userName: 'alice' };
const BOB = { userId: '222222', userName: 'bob' };

/** In-memory store with slow reads, so unserialised writes would lose updates. */
function slowStore() {
  let value: TabSession[] = [];
  return {
    async getValue() {
      const v = value;
      await new Promise((r) => setTimeout(r, 2));
      return v;
    },
    async setValue(v: TabSession[]) {
      value = v;
    },
    get value() {
      return value;
    },
  };
}

describe('Site sessions', () => {
  it('keeps one session per tab, and never loses a concurrent report', async () => {
    const store = slowStore();
    let t = 0;
    const reg = new SessionRegistry(store, () => ++t);
    await Promise.all([
      reg.report({ tabId: 1, type: 'moxfield', hasAuth: true, identity: ALICE }),
      reg.report({ tabId: 2, type: 'moxfield', hasAuth: true, identity: BOB }),
      reg.report({ tabId: 1, type: 'moxfield', hasAuth: false, identity: ALICE }),
    ]);
    expect(store.value.map((s) => [s.tabId, s.hasAuth, s.identity?.userName ?? null])).toEqual([
      [2, true, 'bob'],
      [1, false, null], // logged out: no identity kept
    ]);
  });

  it('forgets closed tabs, and prunes tabs that are gone', async () => {
    const store = slowStore();
    const reg = new SessionRegistry(store);
    await reg.report({ tabId: 1, type: 'moxfield', hasAuth: true, identity: ALICE });
    await reg.report({ tabId: 2, type: 'moxfield', hasAuth: true, identity: BOB });
    await reg.report({ tabId: 3, type: 'moxfield', hasAuth: true, identity: BOB });
    await reg.forget(1);
    await reg.prune(new Set([3]));
    expect(store.value.map((s) => s.tabId)).toEqual([3]);
  });

  it('lists each logged-in account once, newest first', () => {
    const s = (tabId: number, identity: typeof ALICE | null, at: number, hasAuth = true): TabSession => ({ tabId, type: 'moxfield', hasAuth, identity, at });
    expect(liveIdentities([s(1, ALICE, 1), s(2, BOB, 3), s(3, ALICE, 2), s(4, null, 5), s(5, BOB, 9, false)], 'moxfield')).toEqual([BOB, ALICE]);
  });
});
