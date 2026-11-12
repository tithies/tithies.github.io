import { useLiveQuery } from 'dexie-react-hooks';
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { getStoredCurrentKey, listAccounts, resolveCurrent, setCurrentAccount } from './data';
import type { AccountKey, AccountRow } from './types';

export interface CurrentAccount {
  /** The account every page shows (null: no account yet). */
  key: AccountKey | null;
  account: AccountRow | null;
  /** Every account, most recently used first. */
  accounts: AccountRow[];
  loading: boolean;
  switchTo(key: AccountKey): Promise<boolean>;
}

const Ctx = createContext<CurrentAccount>({ key: null, account: null, accounts: [], loading: true, switchTo: async () => false });

/** One current account for every dashboard tab (stored in IndexedDB), live. */
export function AccountProvider({ children }: { children: ReactNode }) {
  const data = useLiveQuery(async () => {
    const [accounts, stored] = await Promise.all([listAccounts(), getStoredCurrentKey()]);
    return { accounts, stored };
  }, []);
  const value = useMemo<CurrentAccount>(() => {
    const accounts = [...(data?.accounts ?? [])].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    const account = data ? resolveCurrent(accounts, data.stored) : null;
    return { key: account?.key ?? null, account, accounts, loading: data === undefined, switchTo: (key) => setCurrentAccount(key) };
  }, [data]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useCurrentAccount = (): CurrentAccount => useContext(Ctx);
