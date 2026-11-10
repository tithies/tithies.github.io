import { compareVersions, getLatestRelease, parseReleaseInfo, updateCheckItem } from '@/lib/release';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Release check', () => {
  beforeEach(() => updateCheckItem.setValue({ checkedAt: 0 }));

  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.3')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.0', '0.1.1')).toBe(-1);
    expect(compareVersions('0.2.0-beta', '0.2.0')).toBe(0);
  });

  it('accepts only sane release files', () => {
    expect(parseReleaseInfo({ version: '0.2.0', file: 'tithies.zip', size: 10 })).toMatchObject({ version: '0.2.0', file: 'tithies.zip' });
    expect(parseReleaseInfo({ version: '0.2.0', file: '../evil.exe' })!.file).toBe('tithies.zip');
    expect(parseReleaseInfo({ version: 'latest' })).toBeNull();
    expect(parseReleaseInfo(null)).toBeNull();
  });

  it('fetches at most once a day and survives being offline', async () => {
    let calls = 0;
    const ok = async () => {
      calls++;
      return json({ version: '0.2.0', file: 'tithies.zip', size: 1, sha256: 'x', publishedAt: '2026-11-10' });
    };
    const day = 24 * 3600_000;
    const t0 = Date.UTC(2026, 10, 10);
    expect((await getLatestRelease(ok as typeof fetch, t0)).latest?.version).toBe('0.2.0');
    await getLatestRelease(ok as typeof fetch, t0 + day / 2);
    expect(calls).toBe(1);
    const offline = async () => {
      throw new TypeError('Failed to fetch');
    };
    // A failed check keeps the last known release.
    expect((await getLatestRelease(offline as typeof fetch, t0 + day * 2)).latest?.version).toBe('0.2.0');
  });
});
