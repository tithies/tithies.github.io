import { DEFAULT_SETTINGS } from '@/lib/settings';

describe('settings defaults', () => {
  it('keeps F2F results for 1 h and reads Moxfield 1000 rows per request', () => {
    expect(DEFAULT_SETTINGS.cacheTtlHours).toBe(1);
    expect(DEFAULT_SETTINGS.moxfieldPageSize).toBe(1000);
  });
});

describe('Moxfield pacing settings', () => {
  it('default to the Moxfield provider pace', async () => {
    const { MOX_PACING } = await import('@/lib/sites/moxfield/constants');
    expect(DEFAULT_SETTINGS.moxfieldIntervalMs).toBe(MOX_PACING.intervalMs);
    expect(DEFAULT_SETTINGS.moxfieldJitterMs).toBe(MOX_PACING.jitterMs);
  });

  it('each Settings section owns its own keys', async () => {
    const { MOXFIELD_SETTING_KEYS, SELLING_SETTING_KEYS } = await import('@/lib/settings');
    const all = [...SELLING_SETTING_KEYS, ...MOXFIELD_SETTING_KEYS];
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
  });
});
