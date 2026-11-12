/**
 * Accounts: one user of one collection site (e.g. a Moxfield account). Every per-account row is
 * keyed by `AccountKey` = `${type}:${userId}`, where `userId` is the site's immutable id (Moxfield:
 * the token's UserId claim) and `userName` is only for display (it can change).
 * Pure module: safe to import anywhere, including content scripts.
 */
import { isSiteType } from '@/lib/sites/registry';
import type { SiteIdentity, SiteType } from '@/lib/sites/types';

export type AccountKey = string & { readonly __brand: 'AccountKey' };

export const accountKey = (type: SiteType, userId: string): AccountKey => `${type}:${userId}` as AccountKey;

/** Splits on the first ':' only (a userId may contain ':'). */
export function parseAccountKey(k: unknown): { type: SiteType; userId: string } | null {
  if (typeof k !== 'string') return null;
  const i = k.indexOf(':');
  if (i <= 0 || i === k.length - 1) return null;
  const type = k.slice(0, i);
  return isSiteType(type) ? { type, userId: k.slice(i + 1) } : null;
}

export interface AccountRow {
  key: AccountKey;
  type: SiteType;
  userId: string;
  /** As the site shows it (kept up to date when it changes). */
  userName: string;
  /** Free label set by the user ("Main", "Cube"…). */
  nickname?: string;
  addedAt: number;
  /** Last time Tithies acted as this account (or the user switched to it). */
  lastUsedAt: number;
  /** Last time a site tab was seen logged in as it during an action. */
  lastSeenAt: number;
}

/** What to call an account in the interface: its nickname, else its username. */
export const accountLabel = (a: Pick<AccountRow, 'nickname' | 'userName'>): string => a.nickname?.trim() || a.userName;

export const identityOf = (a: Pick<AccountRow, 'userId' | 'userName'>): SiteIdentity => ({ userId: a.userId, userName: a.userName });
