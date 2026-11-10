/**
 * "New version available" check. Unpacked extensions never update themselves, so the dashboard
 * reads the published `version.json` (GitHub Pages, at most once a day) and compares versions.
 */
import { storage } from '#imports';
import { RELEASE_PAGE_URL, RELEASE_VERSION_URL } from './release-url';

export { RELEASE_PAGE_URL, RELEASE_VERSION_URL };

/** Contents of `version.json`, written by scripts/build-site.mjs. */
export interface ReleaseInfo {
  version: string;
  /** Zip name, relative to the page ("tithies.zip"). */
  file: string;
  size: number;
  sha256: string;
  publishedAt: string;
}

export interface UpdateCheckState {
  checkedAt: number;
  latest?: ReleaseInfo;
  /** A newer version the user chose to hide the banner for. */
  dismissed?: string;
}

const CHECK_EVERY_MS = 24 * 3600_000;

export const updateCheckItem = storage.defineItem<UpdateCheckState>('local:updateCheck', { fallback: { checkedAt: 0 } });

/** Compares dotted numeric versions ("0.10.0" > "0.9.3"); anything after a "-" is ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

export function parseReleaseInfo(raw: unknown): ReleaseInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== 'string' || !/^\d+(\.\d+)*/.test(r.version)) return null;
  return {
    version: r.version,
    file: typeof r.file === 'string' && /^[\w.-]+\.zip$/.test(r.file) ? r.file : 'tithies.zip',
    size: typeof r.size === 'number' ? r.size : 0,
    sha256: typeof r.sha256 === 'string' ? r.sha256 : '',
    publishedAt: typeof r.publishedAt === 'string' ? r.publishedAt : '',
  };
}

/**
 * Latest published release, from the cache when it's less than a day old. Network or parse errors
 * keep the previous answer and wait a day before trying again (never blocks the dashboard).
 */
export async function getLatestRelease(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<UpdateCheckState> {
  const state = await updateCheckItem.getValue();
  if (state.checkedAt > 0 && now - state.checkedAt < CHECK_EVERY_MS) return state;
  let latest = state.latest;
  try {
    const res = await fetchImpl(RELEASE_VERSION_URL, { cache: 'no-store' });
    if (res.ok) latest = parseReleaseInfo(await res.json()) ?? latest;
  } catch {
    /* offline or page not published yet */
  }
  const next: UpdateCheckState = { ...state, checkedAt: now, latest };
  await updateCheckItem.setValue(next);
  return next;
}

export const downloadUrl = (r: ReleaseInfo) => new URL(r.file, RELEASE_PAGE_URL).toString();
