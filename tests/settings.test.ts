import { DEFAULT_SETTINGS } from '@/lib/settings';

describe('settings defaults', () => {
  it('keeps F2F results for 1 h and reads Moxfield 1000 rows per request', () => {
    expect(DEFAULT_SETTINGS.cacheTtlHours).toBe(1);
    expect(DEFAULT_SETTINGS.moxfieldPageSize).toBe(1000);
  });
});
