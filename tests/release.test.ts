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

  const hour = 3600_000;
  const t0 = Date.UTC(2026, 10, 10);
  const release = (version = '0.2.0') => ({ version, file: 'tithies.zip', size: 1, sha256: 'x', publishedAt: '2026-11-10' });

  it('fetches at most every 6 hours and survives being offline', async () => {
    let calls = 0;
    const ok = (async () => {
      calls++;
      return json(release());
    }) as typeof fetch;
    const first = await getLatestRelease({ fetchImpl: ok, now: t0 });
    expect(first).toMatchObject({ ok: true, checkedAt: t0, latest: { version: '0.2.0' } });
    await getLatestRelease({ fetchImpl: ok, now: t0 + 5 * hour });
    expect(calls).toBe(1);
    await getLatestRelease({ fetchImpl: ok, now: t0 + 7 * hour });
    expect(calls).toBe(2);
    const offline = (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;
    // A failed check is recorded and keeps the last known release.
    expect(await getLatestRelease({ fetchImpl: offline, now: t0 + 14 * hour })).toMatchObject({ ok: false, checkedAt: t0 + 14 * hour, latest: { version: '0.2.0' } });
    const notFound = (async () => json({}, 404)) as typeof fetch;
    expect((await getLatestRelease({ fetchImpl: notFound, now: t0 + 21 * hour })).ok).toBe(false);
  });

  it('checks now when forced, and shows a hidden version again', async () => {
    let calls = 0;
    const ok = (async () => {
      calls++;
      return json(release('0.3.0'));
    }) as typeof fetch;
    await getLatestRelease({ fetchImpl: ok, now: t0 });
    await updateCheckItem.setValue({ ...(await updateCheckItem.getValue()), dismissed: '0.3.0' });
    // Not due yet: the cached answer, still hidden.
    expect((await getLatestRelease({ fetchImpl: ok, now: t0 + hour })).dismissed).toBe('0.3.0');
    const forced = await getLatestRelease({ force: true, fetchImpl: ok, now: t0 + hour });
    expect(calls).toBe(2);
    expect(forced).toMatchObject({ ok: true, checkedAt: t0 + hour, latest: { version: '0.3.0' } });
    expect(forced.dismissed).toBeUndefined();
    expect((await updateCheckItem.getValue()).dismissed).toBeUndefined();
  });

  it('shares one fetch between calls made while it runs', async () => {
    let calls = 0;
    const slow = (async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return json(release());
    }) as typeof fetch;
    const [a, b] = await Promise.all([getLatestRelease({ fetchImpl: slow, now: t0 }), getLatestRelease({ force: true, fetchImpl: slow, now: t0 })]);
    expect(calls).toBe(1);
    expect(a.latest?.version).toBe('0.2.0');
    expect(b.latest?.version).toBe('0.2.0');
  });
});

describe('Automatic version', () => {
  it('adds the number of extension commits as the patch', async () => {
    // @ts-expect-error plain ESM helper without type declarations
    const { toExtensionVersion } = await import('../scripts/version.mjs');
    expect(toExtensionVersion('0.1.0', 7)).toBe('0.1.7');
    expect(toExtensionVersion('1.2.9', 7, true)).toBe('1.2.8');
    expect(toExtensionVersion('0.3.0-beta', 0)).toBe('0.3.0');
    expect(toExtensionVersion('0.1.0', 99_999)).toBe('0.1.65535');
  });
});
