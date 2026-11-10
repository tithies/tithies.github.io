import { storage } from '#imports';
import { z } from 'zod';

export const settingsSchema = z.object({
  /** Minimum gap between two F2F requests (ms). */
  requestIntervalMs: z.number().int().min(500).max(30_000).default(1500),
  /** Extra random delay added to each request (ms). */
  jitterMs: z.number().int().min(0).max(10_000).default(750),
  /** Prints looked up per F2F request. */
  batchSize: z.number().int().min(5).max(100).default(40),
  /** Reuse F2F results younger than this (hours, 0 = never). F2F reprices during the day, so keep it short. */
  cacheTtlHours: z.number().min(0).max(24 * 14).default(1),
  /** Store-credit bonus over cash (0.3 = +30 %). */
  creditBonus: z.number().min(0).max(2).default(0.3),
  /** Set + collector number search for prints the name lookup missed. */
  fallbackEnabled: z.boolean().default(true),
  /** Max fallback requests per run (each covers up to `batchSize` prints). */
  fallbackCap: z.number().int().min(0).max(2000).default(200),
  /** Moxfield page size requested when reading the collection (verified: Moxfield accepts up to 5000). */
  moxfieldPageSize: z.number().int().min(25).max(5000).default(1000),
});

export type Settings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({});

export const settingsItem = storage.defineItem<Settings>('local:settings', { fallback: DEFAULT_SETTINGS });

export async function getSettings(): Promise<Settings> {
  const raw = await settingsItem.getValue();
  const parsed = settingsSchema.safeParse({ ...DEFAULT_SETTINGS, ...(raw ?? {}) });
  return parsed.success ? parsed.data : DEFAULT_SETTINGS;
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = settingsSchema.parse({ ...(await getSettings()), ...patch });
  await settingsItem.setValue(next);
  return next;
}

/** Dashboard table columns the user has hidden (F2F stock is hidden by default). */
export const DEFAULT_HIDDEN_COLUMNS = ['stock'];
export const hiddenColumnsItem = storage.defineItem<string[]>('local:f2fHiddenColumns', { fallback: DEFAULT_HIDDEN_COLUMNS });
