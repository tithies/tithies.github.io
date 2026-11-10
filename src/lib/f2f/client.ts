import ky, { HTTPError } from 'ky';
import PQueue from 'p-queue';
import { parseFacetValues, parseSearch, type F2FDoc, type SearchResponse } from './api';

export interface ThrottleOptions {
  intervalMs: number;
  jitterMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polite F2F client: one request at a time, a minimum gap plus random jitter between requests,
 * retries with exponential backoff and `Retry-After` support for 429/503.
 */
export class F2FClient {
  private queue = new PQueue({ concurrency: 1 });
  private lastAt = 0;
  requests = 0;

  constructor(private throttle: ThrottleOptions) {}

  setThrottle(t: ThrottleOptions) {
    this.throttle = t;
  }

  private http = ky.create({
    timeout: 30_000,
    credentials: 'omit',
    headers: { accept: 'application/json' },
    retry: {
      limit: 4,
      methods: ['get'],
      statusCodes: [408, 429, 500, 502, 503, 504],
      afterStatusCodes: [429, 503],
      maxRetryAfter: 120_000,
      delay: (attempt) => 5_000 * 2 ** (attempt - 1),
      backoffLimit: 60_000,
      // ±20 % around the backoff delay (full jitter could retry almost immediately).
      jitter: (delay) => delay * (0.8 + Math.random() * 0.4),
      retryOnTimeout: true,
    },
    hooks: {
      beforeRequest: [
        () => {
          this.requests++;
        },
      ],
    },
  });

  /** GET one URL as JSON, waiting for its throttle slot first. */
  private get(url: string): Promise<SearchResponse> {
    return this.queue.add(async () => {
      const wait = this.lastAt + this.throttle.intervalMs + Math.random() * this.throttle.jitterMs - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        return await this.http.get(url).json<SearchResponse>();
      } finally {
        this.lastAt = Date.now();
      }
    }) as Promise<SearchResponse>;
  }

  /** Product search: parsed, trimmed docs. */
  async search(url: string): Promise<{ total: number; docs: F2FDoc[] }> {
    return parseSearch(await this.get(url));
  }

  /** Values of one facet aggregation (e.g. all F2F set names). */
  async facetValues(url: string, facet: string): Promise<string[]> {
    return parseFacetValues(await this.get(url), facet);
  }
}

export function describeError(e: unknown): string {
  if (e instanceof HTTPError) return `F2F answered HTTP ${e.response.status}${e.response.status === 429 ? ' (rate limited)' : ''}`;
  if (e instanceof Error) return e.message;
  return String(e);
}
