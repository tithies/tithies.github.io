import PQueue from 'p-queue';
import { moxFail, type MoxApiRequest, type MoxApiResult, type MoxApiSuccess, type MoxErrorCode } from './api';
import type { DeckCard, DeckSummary } from '@/lib/decks/types';
import type { CollectionEntry } from '@/lib/cards/types';

/** Sends one request to Moxfield (in practice: through a logged-in Moxfield tab). */
export type MoxTransport = (req: MoxApiRequest) => Promise<MoxApiResult>;

export class MoxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: MoxErrorCode | 'rate_limited' | 'not_found',
  ) {
    super(message);
    this.name = new.target.name;
  }
}
/** Not logged in, or the session expired. */
export class MoxAuthError extends MoxError {}
/** Still HTTP 429 after every retry. */
export class MoxRateLimitError extends MoxError {}
/** The deck (or page) doesn't exist (any more). */
export class MoxNotFoundError extends MoxError {}
export class MoxCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'MoxCancelledError';
  }
}

export interface MoxClientOptions {
  /** Minimum gap between two requests (ms). */
  intervalMs: number;
  /** Random extra delay per request (ms). */
  jitterMs: number;
  /** Waits after successive HTTP 429s; one more 429 after the last wait fails the request. Moxfield says "wait about 30 secs". */
  rateLimitWaitsMs: number[];
  /** Waits after network errors, timeouts and 5xx. */
  errorWaitsMs: number[];
  /** The gap never grows past this after rate limiting (ms). */
  maxIntervalMs: number;
  signal?: AbortSignal;
  /** Called before each long wait, e.g. to show "Rate limited, retrying in 30 s (1/3)". */
  onWait?: (message: string, ms: number) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

export const DEFAULT_MOX_CLIENT_OPTIONS: MoxClientOptions = {
  intervalMs: 1000,
  jitterMs: 500,
  rateLimitWaitsMs: [30_000, 60_000, 120_000],
  errorWaitsMs: [5_000, 15_000],
  maxIntervalMs: 4000,
};

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new MoxCancelledError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new MoxCancelledError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

const retryable = (r: { status: number; code: MoxErrorCode }) =>
  r.code === 'network' || r.code === 'timeout' || r.status === 408 || r.status >= 500;

/**
 * Polite Moxfield client: one request at a time, a minimum gap plus jitter between requests,
 * fixed waits on HTTP 429 (Moxfield sends no Retry-After), short retries on network/5xx errors.
 */
export class MoxfieldClient {
  private queue = new PQueue({ concurrency: 1 });
  private lastAt = 0;
  private opts: MoxClientOptions;
  private interval: number;
  requests = 0;

  constructor(
    private transport: MoxTransport,
    opts: Partial<MoxClientOptions> = {},
  ) {
    this.opts = { ...DEFAULT_MOX_CLIENT_OPTIONS, ...opts };
    this.interval = this.opts.intervalMs;
  }

  private sleep(ms: number) {
    return (this.opts.sleep ?? abortableSleep)(ms, this.opts.signal);
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }
  private checkCancelled() {
    if (this.opts.signal?.aborted) throw new MoxCancelledError();
  }

  private async send(req: MoxApiRequest): Promise<MoxApiSuccess> {
    let rateLimited = 0;
    let failures = 0;
    for (;;) {
      this.checkCancelled();
      const wait = this.lastAt + this.interval + (this.opts.random ?? Math.random)() * this.opts.jitterMs - this.now();
      if (this.lastAt && wait > 0) await this.sleep(wait);
      this.checkCancelled();
      this.requests++;
      let res: MoxApiResult;
      try {
        res = await this.transport(req);
      } catch (e) {
        res = moxFail(0, 'network', e instanceof Error ? e.message : String(e));
      } finally {
        this.lastAt = this.now();
      }
      if (res.ok) return res;

      if (res.status === 429) {
        const waitMs = this.opts.rateLimitWaitsMs[rateLimited];
        if (waitMs == null) throw new MoxRateLimitError('Moxfield is rate limiting Tithies. Wait a few minutes, then try again.', 429, 'rate_limited');
        rateLimited++;
        this.interval = Math.min(this.opts.maxIntervalMs, Math.round(this.interval * 1.5));
        this.opts.onWait?.(`Moxfield is rate limiting: retrying in ${Math.round(waitMs / 1000)} s (${rateLimited}/${this.opts.rateLimitWaitsMs.length})`, waitMs);
        await this.sleep(waitMs);
        continue;
      }
      if (res.code === 'no_auth') throw new MoxAuthError(res.message, res.status, res.code);
      if (res.status === 404) throw new MoxNotFoundError(res.message, 404, 'not_found');
      if (retryable(res)) {
        const waitMs = this.opts.errorWaitsMs[failures];
        if (waitMs == null) throw new MoxError(res.message, res.status, res.code);
        failures++;
        this.opts.onWait?.(`${res.message}: retrying in ${Math.round(waitMs / 1000)} s`, waitMs);
        await this.sleep(waitMs);
        continue;
      }
      throw new MoxError(res.message, res.status, res.code);
    }
  }

  private request<K extends MoxApiSuccess['kind']>(req: MoxApiRequest & { kind: K }): Promise<Extract<MoxApiSuccess, { kind: K }>> {
    return this.queue.add(() => this.send(req)) as Promise<Extract<MoxApiSuccess, { kind: K }>>;
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
export type DeckSource = Pick<MoxfieldClient, 'deckList' | 'deck'>;
export type CollectionSource = Pick<MoxfieldClient, 'collectionPage'>;

export function describeMoxError(e: unknown): string {
  if (e instanceof MoxCancelledError) return 'Cancelled';
  if (e instanceof Error) return e.message;
  return String(e);
}
