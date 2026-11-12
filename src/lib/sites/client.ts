import PQueue from 'p-queue';
import type { CollectionEntry } from '@/lib/cards/types';
import type { DeckCard, DeckSummary } from '@/lib/decks/types';
import { siteFail, type SiteErrorCode, type SiteIdentity, type SiteRequest, type SiteResult, type SiteSuccess } from './types';

/** Sends one request to a site (in practice: through a logged-in tab of that site). */
export type SiteTransport = (req: SiteRequest) => Promise<SiteResult>;

export class SiteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: SiteErrorCode | 'rate_limited' | 'not_found',
  ) {
    super(message);
    this.name = new.target.name;
  }
}
/** Not logged in, or the session expired. */
export class SiteAuthError extends SiteError {}
/** Still HTTP 429 after every retry. */
export class SiteRateLimitError extends SiteError {}
/** The deck (or page) doesn't exist (any more). */
export class SiteNotFoundError extends SiteError {}
/** The site's session belongs to another account than the one asked for: nothing was read as it. */
export class SiteWrongAccountError extends SiteError {
  constructor(
    message: string,
    /** Who the site is logged in as (null when unknown). */
    readonly actual: SiteIdentity | null,
  ) {
    super(message, 0, 'wrong_account');
  }
}
export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

/** How fast a client may go. Each site provider has its own defaults. */
export interface SitePacing {
  /** Minimum gap between two requests (ms). */
  intervalMs: number;
  /** Random extra delay per request (ms). */
  jitterMs: number;
  /** Waits after successive HTTP 429s; one more 429 after the last wait fails the request. */
  rateLimitWaitsMs: number[];
  /** Waits after network errors, timeouts and 5xx. */
  errorWaitsMs: number[];
  /** The gap never grows past this after rate limiting (ms). */
  maxIntervalMs: number;
}

export interface SiteClientOptions extends SitePacing {
  /** The site's name in messages ("Moxfield is rate limiting Tithies…"). */
  label: string;
  /**
   * The account every answer must have been made as (a userId; read before each answer, so it
   * can be bound late). Any answer made as someone else fails with SiteWrongAccountError before
   * its status means anything (a 404 as another account is not "deck deleted").
   */
  expectedUserId?: () => string | undefined;
  signal?: AbortSignal;
  /** Called before each long wait, e.g. to show "Rate limited, retrying in 30 s (1/3)". */
  onWait?: (message: string, ms: number) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new CancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const retryable = (r: { status: number; code: SiteErrorCode }) =>
  r.code === 'network' || r.code === 'timeout' || r.status === 408 || r.status >= 500;

/**
 * Polite site client: one request at a time, a minimum gap plus jitter between requests,
 * fixed waits on HTTP 429 (sites like Moxfield send no Retry-After), short retries on network/5xx errors.
 */
export class SiteClient {
  private queue = new PQueue({ concurrency: 1 });
  private lastAt = 0;
  private interval: number;
  requests = 0;

  constructor(
    private transport: SiteTransport,
    private opts: SiteClientOptions,
  ) {
    this.interval = opts.intervalMs;
  }

  private sleep(ms: number) {
    return (this.opts.sleep ?? abortableSleep)(ms, this.opts.signal);
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }
  private checkCancelled() {
    if (this.opts.signal?.aborted) throw new CancelledError();
  }

  private async send(req: SiteRequest): Promise<SiteSuccess> {
    const { label } = this.opts;
    let rateLimited = 0;
    let failures = 0;
    for (;;) {
      this.checkCancelled();
      const wait = this.lastAt + this.interval + (this.opts.random ?? Math.random)() * this.opts.jitterMs - this.now();
      if (this.lastAt && wait > 0) await this.sleep(wait);
      this.checkCancelled();
      this.requests++;
      let res: SiteResult;
      try {
        res = await this.transport(req);
      } catch (e) {
        res = siteFail(0, 'network', e instanceof Error ? e.message : String(e));
      } finally {
        this.lastAt = this.now();
      }
      const expected = this.opts.expectedUserId?.();
      if (expected !== undefined) {
        // Success must say it was made as the expected account; a failure made as somebody else too.
        const other = res.ok ? res.as?.userId !== expected : !!res.as && res.as.userId !== expected;
        if (other) {
          const who = res.as ? `as ${res.as.userName}` : 'as an unknown account';
          throw new SiteWrongAccountError(res.ok ? `${label} answered ${who}.` : res.message, res.as ?? null);
        }
      }
      if (!res.ok && res.code === 'wrong_account') throw new SiteWrongAccountError(res.message, res.as ?? null);
      if (res.ok) return res;

      if (res.status === 429) {
        const waitMs = this.opts.rateLimitWaitsMs[rateLimited];
        if (waitMs == null) throw new SiteRateLimitError(`${label} is rate limiting Tithies. Wait a few minutes, then try again.`, 429, 'rate_limited');
        rateLimited++;
        this.interval = Math.min(this.opts.maxIntervalMs, Math.round(this.interval * 1.5));
        this.opts.onWait?.(`${label} is rate limiting: retrying in ${Math.round(waitMs / 1000)} s (${rateLimited}/${this.opts.rateLimitWaitsMs.length})`, waitMs);
        await this.sleep(waitMs);
        continue;
      }
      if (res.code === 'no_auth') throw new SiteAuthError(res.message, res.status, res.code);
      if (res.status === 404) throw new SiteNotFoundError(res.message, 404, 'not_found');
      if (retryable(res)) {
        const waitMs = this.opts.errorWaitsMs[failures];
        if (waitMs == null) throw new SiteError(res.message, res.status, res.code);
        failures++;
        this.opts.onWait?.(`${res.message}: retrying in ${Math.round(waitMs / 1000)} s`, waitMs);
        await this.sleep(waitMs);
        continue;
      }
      throw new SiteError(res.message, res.status, res.code);
    }
  }

  private request<K extends SiteSuccess['kind']>(req: SiteRequest & { kind: K }): Promise<Extract<SiteSuccess, { kind: K }>> {
    return this.queue.add(() => this.send(req)) as Promise<Extract<SiteSuccess, { kind: K }>>;
  }

  async deckList(): Promise<DeckSummary[]> {
    return (await this.request({ kind: 'deckList' })).decks;
  }

  async deck(publicId: string): Promise<{ lastUpdatedAt: string; cards: DeckCard[] }> {
    const { lastUpdatedAt, cards } = await this.request({ kind: 'deck', publicId });
    return { lastUpdatedAt, cards };
  }

  async collectionPage(pageNumber: number, pageSize: number): Promise<{ entries: CollectionEntry[]; totalResults: number; totalPages: number; pageSize: number }> {
    const { entries, totalResults, totalPages, pageSize: size } = await this.request({ kind: 'collection', pageNumber, pageSize });
    return { entries, totalResults, totalPages, pageSize: size };
  }
}

/** What the deck sync needs from a client (lets tests use a fake). */
export type DeckSource = Pick<SiteClient, 'deckList' | 'deck'>;
export type CollectionSource = Pick<SiteClient, 'collectionPage'>;

export function describeSiteError(e: unknown): string {
  if (e instanceof CancelledError) return 'Cancelled';
  if (e instanceof Error) return e.message;
  return String(e);
}
