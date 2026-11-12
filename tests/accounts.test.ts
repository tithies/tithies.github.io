import { addAccountFromAction, getCurrentAccount, listAccounts, resolveCurrent, setCurrentAccount, setNickname } from '@/lib/accounts/data';
import { accountKey, accountLabel, parseAccountKey, type AccountKey, type AccountRow } from '@/lib/accounts/types';
import { db } from '@/lib/db';
import { SessionRegistry } from '@/lib/sites/sessions';
import { progressFor, startRunFromSite } from '@/features/f2f-buylist/start';
import { shouldSwitchForRun } from '@/features/f2f-buylist/ui/RunDetailPage';
import { fixture, resetDb } from './helpers';
import { normalizeEntry } from '@/lib/sites/moxfield/normalize';
import type { CollectionEntry } from '@/lib/cards/types';

const ALICE = { userId: '111111', userName: 'alice' };
const BOB = { userId: '222222', userName: 'bob' };
const ENTRIES: CollectionEntry[] = fixture<{ data: unknown[] }>('moxfield-page.json').data.map(normalizeEntry).filter((e): e is CollectionEntry => !!e);

beforeEach(resetDb);

describe('Account keys', () => {
  it('are site type + user id, split on the first colon', () => {
    expect(accountKey('moxfield', '123')).toBe('moxfield:123');
    expect(parseAccountKey('moxfield:12:34')).toEqual({ type: 'moxfield', userId: '12:34' });
    expect(parseAccountKey('archidekt:1')).toBeNull(); // not a supported site (yet)
    expect(parseAccountKey('moxfield:')).toBeNull();
    expect(parseAccountKey(42)).toBeNull();
  });

  it('show the nickname, else the username', () => {
    expect(accountLabel({ userName: 'alice' })).toBe('alice');
    expect(accountLabel({ userName: 'alice', nickname: ' Main ' })).toBe('Main');
  });
});

describe('Accounts', () => {
  const row = (key: string, lastUsedAt: number) => ({ key, lastUsedAt }) as AccountRow;

  it('the current account is the stored one, else the most recently used', () => {
    const accounts = [row('moxfield:1', 5), row('moxfield:2', 9)];
    expect(resolveCurrent(accounts, 'moxfield:1')?.key).toBe('moxfield:1');
    expect(resolveCurrent(accounts, 'moxfield:gone')?.key).toBe('moxfield:2');
    expect(resolveCurrent(accounts, undefined)?.key).toBe('moxfield:2');
    expect(resolveCurrent([], 'moxfield:1')).toBeNull();
  });

  it('an action adds the account once, keeps its username current and makes it current', async () => {
    await addAccountFromAction('moxfield', ALICE, 1);
    await addAccountFromAction('moxfield', BOB, 2);
    expect((await getCurrentAccount())?.userName).toBe('bob');
    await addAccountFromAction('moxfield', { ...ALICE, userName: 'alice-renamed' }, 3);
    expect(await listAccounts()).toHaveLength(2);
    expect(await getCurrentAccount()).toMatchObject({ key: 'moxfield:111111', userName: 'alice-renamed', addedAt: 1, lastUsedAt: 3 });
    expect(await setCurrentAccount('moxfield:222222' as AccountKey, 4)).toBe(true);
    expect((await getCurrentAccount())?.userName).toBe('bob');
    expect(await setCurrentAccount('moxfield:999' as AccountKey)).toBe(false);
    await setNickname('moxfield:222222' as AccountKey, '  Cube  ');
    expect((await getCurrentAccount())?.nickname).toBe('Cube');
    await setNickname('moxfield:222222' as AccountKey, '');
    expect((await getCurrentAccount())?.nickname).toBeUndefined();
  });

  it('a tab merely logged in never adds an account', async () => {
    const store = { value: [] as never[], getValue: async () => store.value, setValue: async (v: never[]) => void (store.value = v) };
    await new SessionRegistry(store as never).report({ tabId: 1, type: 'moxfield', hasAuth: true, identity: ALICE });
    expect(await db.accounts.count()).toBe(0);
  });
});

describe('Selling runs started from a site tab', () => {
  const source = { url: 'u', pageUrl: 'p', query: {}, summary: '' };

  it("belong to the captured collection's account, which is added and made current", async () => {
    await addAccountFromAction('moxfield', BOB);
    const res = await startRunFromSite({ type: 'moxfield', account: ALICE, source, entries: ENTRIES }, 7, 0.3);
    expect(res.accountKey).toBe('moxfield:111111');
    expect((await db.runs.get(res.runId))).toMatchObject({ accountKey: 'moxfield:111111', source: { tabId: 7 } });
    expect((await getCurrentAccount())?.userName).toBe('alice');
  });

  it('are refused when the account is unknown or malformed', async () => {
    for (const account of [null, { userId: '', userName: 'x' }, { userName: 'no id' }]) {
      await expect(startRunFromSite({ type: 'moxfield', account, source, entries: ENTRIES }, 7, 0.3)).rejects.toThrow("Couldn't tell which Moxfield account");
    }
    await expect(startRunFromSite({ type: 'other', account: ALICE, source, entries: ENTRIES }, 7, 0.3)).rejects.toThrow('Unknown site');
    expect(await db.runs.count()).toBe(0);
    expect(await db.accounts.count()).toBe(0);
  });

  it("the panel only ever gets its own account's progress", async () => {
    const a = await startRunFromSite({ type: 'moxfield', account: ALICE, source, entries: ENTRIES }, 7, 0.3);
    const b = await startRunFromSite({ type: 'moxfield', account: BOB, source, entries: ENTRIES }, 7, 0.3);
    expect((await progressFor({ accountKey: a.accountKey }, 7))?.runId).toBe(a.runId);
    expect((await progressFor({ accountKey: b.accountKey }, 7))?.runId).toBe(b.runId);
    expect(await progressFor({ runId: b.runId, accountKey: a.accountKey }, 7)).toBeNull();
    expect((await progressFor({ runId: b.runId }, undefined))?.accountKey).toBe(b.accountKey);
    expect(await progressFor({ accountKey: a.accountKey }, 99)).toBeNull();
  });
});

describe('Opening a run of another account', () => {
  it('switches to its account once per run, so two tabs never keep switching each other', () => {
    const done = new Set<number>();
    expect(shouldSwitchForRun(1, 'moxfield:2', 'moxfield:1', done)).toBe(true);
    expect(shouldSwitchForRun(1, 'moxfield:2', 'moxfield:2', done)).toBe(false);
    // Another tab switched back: this one stays (it shows a banner instead).
    expect(shouldSwitchForRun(1, 'moxfield:2', 'moxfield:1', done)).toBe(false);
    expect(shouldSwitchForRun(2, 'moxfield:2', 'moxfield:1', done)).toBe(true);
  });
});
