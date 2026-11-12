/**
 * "New version available" check. Unpacked extensions never update themselves, so the dashboard
 * reads the published `version.json` (GitHub Pages, at most every 6 hours, or when the user
 * clicks "Checked … ago" in the header) and compares versions.
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
  /** False when the last check couldn't read `version.json` (offline, page down…). */
  ok?: boolean;
  latest?: ReleaseInfo;
  /** A newer version the user chose to hide the banner for. */
  dismissed?: string;
}

export const CHECK_EVERY_MS = 6 * 3600_000;

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

export interface CheckOptions {
  /** Check now, even if the last check is recent (the header's manual check). */
  force?: boolean;
  fetchImpl?: typeof fetch;
  now?: number;
}

let inFlight: Promise<UpdateCheckState> | null = null;

/**
 * Latest published release, from the cache when the last check is less than CHECK_EVERY_MS old.
 * Network or parse errors keep the previous answer, are recorded (`ok: false`) and wait as long
 * before the next automatic try; they never block the dashboard. Calls made while a check runs
 * share it. A forced check also brings back the banner of a version the user had hidden: they
 * asked.
 */
export async function getLatestRelease({ force = false, fetchImpl = fetch, now = Date.now() }: CheckOptions = {}): Promise<UpdateCheckState> {
  const state = await updateCheckItem.getValue();
  if (!force && state.checkedAt > 0 && now - state.checkedAt < CHECK_EVERY_MS) return state;
  inFlight ??= fetchLatest(fetchImpl, now).finally(() => (inFlight = null));
  const next = await inFlight;
  if (!force || next.dismissed === undefined) return next;
  const shown: UpdateCheckState = { ...next, dismissed: undefined };
  await updateCheckItem.setValue(shown);
  return shown;
}

async function fetchLatest(fetchImpl: typeof fetch, now: number): Promise<UpdateCheckState> {
  let latest: ReleaseInfo | null = null;
  try {
    const res = await fetchImpl(RELEASE_VERSION_URL, { cache: 'no-store' });
    if (res.ok) latest = parseReleaseInfo(await res.json());
  } catch {
    /* offline or page not published yet */
  }
  // Read after the fetch: the banner may have been dismissed meanwhile.
  const state = await updateCheckItem.getValue();
  const next: UpdateCheckState = { ...state, checkedAt: now, ok: latest != null, latest: latest ?? state.latest };
  await updateCheckItem.setValue(next);
  return next;
}

export const downloadUrl = (r: ReleaseInfo) => new URL(r.file, RELEASE_PAGE_URL).toString();
