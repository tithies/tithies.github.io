/**
 * Which Moxfield account a session belongs to, read from the session token itself.
 *
 * Verified 2026-11-12: every authenticated api2 request carries `Authorization: Bearer <JWT>`,
 * a 15-minute token whose claims include `sub` (the username) and a numeric UserId claim. The
 * page gets it from `POST /v1/startup/authenticated` (sent without Authorization, using the
 * refresh cookie), whose `refresh.access_token` is that same JWT. That response also has a
 * `refresh.user_id`, but it is a *different* id (a short public id): Tithies only ever uses the
 * token's UserId claim, so one account never gets two keys.
 *
 * Pure (runs in the page's MAIN world and in tests). The signature can't be checked here, and
 * doesn't need to be: this is the same token the page itself sends to Moxfield.
 */
import type { SiteIdentity } from '@/lib/sites/types';

export const MOX_USER_ID_CLAIM = 'http://www.moxfield.com/ws/2016/08/identity/claims/UserId';
export const STARTUP_PATH = '/v1/startup/authenticated';

export interface TokenInfo extends SiteIdentity {
  /** Token expiry (ms), when the token says. */
  expiresAt?: number;
}

function base64UrlDecode(part: string): string {
  const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  // Claims are UTF-8 (usernames may not be ASCII).
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** The account of a JWT, or null when it isn't one Tithies can read. */
export function identityFromToken(token: string | null | undefined): TokenInfo | null {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  let claims: any;
  try {
    claims = JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return null;
  }
  if (!claims || typeof claims !== 'object') return null;
  const rawId = claims[MOX_USER_ID_CLAIM];
  const userId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId).trim() : '';
  const userName = typeof claims.sub === 'string' ? claims.sub.trim() : '';
  if (!userId || !userName) return null;
  const exp = typeof claims.exp === 'number' && Number.isFinite(claims.exp) ? claims.exp * 1000 : undefined;
  return exp === undefined ? { userId, userName } : { userId, userName, expiresAt: exp };
}

/** The account of an `Authorization` header value ("Bearer <JWT>"). */
export function identityFromAuthorization(value: string | null | undefined): TokenInfo | null {
  if (typeof value !== 'string') return null;
  const m = /^Bearer\s+(\S+)$/i.exec(value.trim());
  return m ? identityFromToken(m[1]) : null;
}

/** The fresh token in a `startup/authenticated` answer, or null (logged out, or an unexpected shape). */
export function tokenFromStartup(body: unknown): string | null {
  const token = (body as any)?.refresh?.access_token;
  return typeof token === 'string' && identityFromToken(token) ? token : null;
}
