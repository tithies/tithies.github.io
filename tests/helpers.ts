import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSearch, type F2FDoc, type SearchResponse } from '@/lib/f2f/api';
import { MOX_USER_ID_CLAIM } from '@/lib/sites/moxfield/identity';

export const fixture = <T = unknown>(name: string): T => JSON.parse(readFileSync(join(__dirname, 'fixtures', name), 'utf8')) as T;
export const docs = (name: string): F2FDoc[] => parseSearch(fixture<SearchResponse>(name)).docs;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A token shaped like Moxfield's session token (fake users only). */
export const fakeJwt = (userId: string, userName: string, extra: Record<string, unknown> = {}) =>
  `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: userName, [MOX_USER_ID_CLAIM]: userId, exp: 2_000_000_000, iat: 1_999_999_100, ...extra })}.c2ln`;
export const bearer = (userId: string, userName: string) => `Bearer ${fakeJwt(userId, userName)}`;

/** Empties every table of the test database. */
export async function resetDb(): Promise<void> {
  const { db } = await import('@/lib/db');
  await Promise.all(db.tables.map((t) => t.clear()));
}

/** A fake Moxfield account, added as an action would add it (it becomes the current account). */
export async function newAccount(userId: string, userName: string) {
  const { accountData, addAccountFromAction } = await import('@/lib/accounts/data');
  const row = await addAccountFromAction('moxfield', { userId, userName });
  return { key: row.key, row, data: accountData(row.key), identity: { userId, userName } };
}
