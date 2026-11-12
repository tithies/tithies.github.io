/**
 * The Moxfield page hook's state and request handling, kept free of DOM wrapping so it can be
 * tested: the session (newest login headers, and whose they are), the captured collection search
 * of the panel, and the requests the extension asks the page to make.
 *
 * The account of a session is read from the very token the request carries (see identity.ts), so
 * "which account" and "which headers" can never drift apart: when the token changes, the account
 * is re-read from the new token.
 */
import type { CollectionEntry } from '@/lib/cards/types';
import { siteFail, type SiteApiCall, type SiteIdentity, type SiteResult, type SiteTabStatus } from '@/lib/sites/types';
import { runMoxRequest } from './api';
import { identityFromAuthorization, tokenFromStartup, type TokenInfo } from './identity';
import { isCollectionSearchUrl, normalizeEntry, withPaging, type CollectionPage } from './normalize';

export type Headers = Record<string, string>;
export type PageFetch = (url: string, headers: Headers) => Promise<Response>;

export interface SessionInfo {
  hasAuth: boolean;
  identity: SiteIdentity | null;
}

export interface CaptureInfo {
  hasCapture: boolean;
  url?: string;
  capturedAt?: number;
  /** Whose collection the captured request reads (null when the token can't be read). */
  account?: SiteIdentity | null;
}

export interface CollectionResult {
  url: string;
  entries: CollectionEntry[];
  totalResults: number;
  pages: number;
  /** Whose collection this is: the account of the captured request's own token. */
  account: SiteIdentity | null;
}

/** Session headers worth replaying: the bearer token and Moxfield's own x-* headers. */
export function pickAuthHeaders(h: Headers): Headers | null {
  const out: Headers = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (key === 'authorization' || key.startsWith('x-')) out[key] = v;
  }
  return out.authorization ? out : null;
}

const toIdentity = (t: TokenInfo | null): SiteIdentity | null => (t ? { userId: t.userId, userName: t.userName } : null);

interface Snapshot {
  headers: Headers;
  identity: SiteIdentity | null;
  /** The token's own expiry (ms), when it says. */
  expiresAt?: number;
  at: number;
}

/** A token is still used this long past its expiry (clock differences); Moxfield refuses it anyway after that. */
const EXPIRY_GRACE_MS = 60_000;
/** Tokens of logged-out sessions remembered, so a late request carrying one can't bring the session back. */
const MAX_REVOKED = 20;

export class MoxPageSession {
  private auth: Snapshot | null = null;
  private captured: (Snapshot & { url: string }) | null = null;
  private last: SessionInfo = { hasAuth: false, identity: null };
  /**
   * Tokens of sessions that were logged out. Moxfield doesn't invalidate its access token on
   * logout (verified 2026-11-12: requests with it still answer 200 afterwards), so Tithies must
   * stop using it by itself.
   */
  private revoked = new Set<string>();
  /** Counts logouts (a read in progress stops when it changes). */
  private logouts = 0;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    /** Called when the session appears, goes away, or changes account. */
    private onChange: (s: SessionInfo) => void = () => {},
    private now: () => number = Date.now,
  ) {}

  private emitIfChanged() {
    const next = this.info();
    const prev = this.last;
    if (prev.hasAuth === next.hasAuth && prev.identity?.userId === next.identity?.userId && prev.identity?.userName === next.identity?.userName) return;
    this.last = next;
    this.onChange(next);
  }

  private snapshot(headers: Headers): Snapshot {
    const token = identityFromAuthorization(headers.authorization);
    return { headers, identity: toIdentity(token), expiresAt: token?.expiresAt, at: this.now() };
  }

  private set(headers: Headers) {
    if (this.revoked.has(headers.authorization)) return;
    this.auth = this.snapshot(headers);
    this.emitIfChanged();
    this.watchExpiry();
  }

  /** Reports the session as gone once its token has expired (the page refreshes it while it is used). */
  private watchExpiry() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const exp = this.auth?.expiresAt;
    if (exp === undefined) return;
    // setTimeout's longest delay is ~24.8 days.
    this.expiryTimer = setTimeout(() => this.emitIfChanged(), Math.min(2_147_483_647, Math.max(0, exp + EXPIRY_GRACE_MS - this.now()) + 1000));
  }

  private live(s: Snapshot | null): s is Snapshot {
    return s != null && (s.expiresAt === undefined || this.now() <= s.expiresAt + EXPIRY_GRACE_MS);
  }

  private revoke(authorization: string | undefined) {
    if (!authorization) return;
    this.revoked.add(authorization);
    if (this.revoked.size > MAX_REVOKED) this.revoked.delete(this.revoked.values().next().value as string);
  }

  info(): SessionInfo {
    const live = this.live(this.auth);
    return { hasAuth: live, identity: live ? (this.auth?.identity ?? null) : null };
  }

  /** Headers of a request the page itself made to the API (it refreshes its token by itself). */
  noteRequest(headers: Headers): void {
    const picked = pickAuthHeaders(headers);
    if (picked) this.set(picked);
  }

  /**
   * The page's own `startup/authenticated` call answered: it hands out the session's fresh token
   * (and is how a login starts), so the session follows it at once. A refusal means logged out.
   */
  noteStartup(status: number, body: unknown): void {
    if (status === 401 || status === 403) return this.drop();
    if (status < 200 || status >= 300) return;
    const token = tokenFromStartup(body);
    if (token) this.set({ ...(this.auth?.headers ?? {}), authorization: `Bearer ${token}` });
  }

  /** Forgets the session (when `authorization` is given: only if it is still that token). */
  drop(authorization?: string): void {
    if (!this.auth || (authorization !== undefined && this.auth.headers.authorization !== authorization)) return;
    this.auth = null;
    this.emitIfChanged();
  }

  /**
   * The user logged out (the page's own logout call answered, or another tab of this browser
   * did it: one logout ends the session of every tab). The session and the panel's captured
   * request are forgotten, and their tokens are never used again. Returns who was logged in.
   */
  logout(): SiteIdentity | null {
    const who = this.auth?.identity ?? this.captured?.identity ?? null;
    this.revoke(this.auth?.headers.authorization);
    this.revoke(this.captured?.headers.authorization);
    this.captured = null;
    this.auth = null;
    this.logouts++;
    this.emitIfChanged();
    return who;
  }

  status(path: string): SiteTabStatus {
    const { hasAuth, identity } = this.info();
    return { hasAuth, identity, authAt: this.auth?.at, path };
  }

  /** The collection page made a search: remember it (URL = the filters, headers = the session). Returns whether it was one. */
  noteCollectionSearch(absUrl: string, headers: Headers): boolean {
    if (!isCollectionSearchUrl(absUrl)) return false;
    if (this.revoked.has(headers.authorization)) return false;
    this.captured = { ...this.snapshot(headers), url: absUrl };
    return true;
  }

  captureInfo(): CaptureInfo {
    const c = this.captured;
    return c ? { hasCapture: true, url: c.url, capturedAt: c.at, account: c.identity } : { hasCapture: false };
  }

  /**
   * One request the extension asked for, made with the session's headers as they are now.
   * With `expect`, it is only sent if the session belongs to that user (checked before fetching).
   * Every answer says which account it was made as.
   */
  async api({ req, expect }: SiteApiCall, doFetch: PageFetch): Promise<SiteResult> {
    const snap = this.auth;
    if (!this.live(snap)) {
      return siteFail(0, 'no_auth', snap ? 'The Moxfield session in this tab has expired: reload the page.' : 'No Moxfield session in this tab: log in to Moxfield, or reload the page.', null);
    }
    const as = snap.identity;
    if (expect !== undefined) {
      if (!as) return siteFail(0, 'wrong_account', "Couldn't tell which Moxfield account is logged in in this tab.", null);
      if (as.userId !== expect) return siteFail(0, 'wrong_account', `Moxfield is logged in as ${as.userName} in this tab.`, as);
    }
    const headers = { ...snap.headers };
    const res = await runMoxRequest(req, (url) => doFetch(url, headers));
    // The token was refused: don't offer this session again until the page gets a new one.
    if (!res.ok && res.code === 'no_auth') this.drop(headers.authorization);
    return { ...res, as };
  }

  /**
   * Replays the captured collection search page by page (the panel's "Check selling prices").
   * Every page uses the captured request's own headers, so the whole read is one account's.
   */
  async readCapture(
    opts: { pageSize: number; delayMs: number },
    doFetch: PageFetch,
    onProgress: (p: { page: number; totalPages: number; fetched: number }) => void = () => {},
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ): Promise<CollectionResult> {
    const c = this.captured;
    if (!c) throw new Error('No collection query seen yet. Reload the collection page and try again.');
    const { url, headers, identity } = c;
    const getPage = async (pageNumber: number, pageSize: number): Promise<CollectionPage> => {
      const res = await doFetch(withPaging(url, pageNumber, pageSize), headers);
      if (res.status === 401 || res.status === 403) throw new Error('Moxfield refused the request (session expired?). Reload the page and try again.');
      if (!res.ok) throw new Error(`Moxfield answered HTTP ${res.status}`);
      return res.json();
    };

    const entries: CollectionEntry[] = [];
    const first = await getPage(1, opts.pageSize);
    // Moxfield may cap the page size: keep paging with whatever size it actually used.
    const size = first.pageSize || opts.pageSize;
    const totalPages = first.totalPages || Math.ceil((first.totalResults || 0) / size) || 1;
    const push = (p: CollectionPage) => {
      for (const raw of p.data ?? []) {
        const e = normalizeEntry(raw);
        if (e) entries.push(e);
      }
    };
    // Logged out meanwhile: stop reading with the old session.
    const logouts = this.logouts;
    const checkStillCaptured = () => {
      if (this.logouts !== logouts) throw new Error('You logged out of Moxfield while the collection was being read. Log in and try again.');
    };
    checkStillCaptured();
    push(first);
    onProgress({ page: 1, totalPages, fetched: entries.length });
    for (let page = 2; page <= totalPages; page++) {
      await sleep(opts.delayMs);
      checkStillCaptured();
      push(await getPage(page, size));
      checkStillCaptured();
      onProgress({ page, totalPages, fetched: entries.length });
    }
    return { url, entries, totalResults: first.totalResults ?? entries.length, pages: totalPages, account: identity };
  }
}
