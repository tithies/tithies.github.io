import { storage } from '#imports';
import { z } from 'zod';
import { MAX_COLLECTION_PAGE_SIZE, MOX_PACING } from '@/lib/sites/moxfield/constants';

export const settingsSchema = z.object({
  /** Minimum gap between two F2F requests (ms). */
  requestIntervalMs: z.number().int().min(500).max(30_000).default(1500),
  /** Extra random delay added to each request (ms). */
  jitterMs: z.number().int().min(0).max(10_000).default(750),
  /** Prints looked up per F2F request (a request with more than 100 hits is split automatically). */
  batchSize: z.number().int().min(5).max(100).default(20),
  /** Reuse F2F results younger than this (hours, 0 = never). F2F reprices during the day, so keep it short. */
  cacheTtlHours: z.number().min(0).max(24 * 14).default(1),
  /** Store-credit bonus over cash (0.3 = +30 %). */
  creditBonus: z.number().min(0).max(2).default(0.3),
  /** Set + collector number search for prints the name lookup missed. */
  fallbackEnabled: z.boolean().default(true),
  /** Max fallback requests per run (each covers up to `batchSize` prints); also the most cards checked on Shopify search (pass 3). */
  fallbackCap: z.number().int().min(0).max(2000).default(200),
  /** Moxfield page size requested when the panel reads the collection (verified: Moxfield accepts up to 5000). */
  moxfieldPageSize: z.number().int().min(25).max(MAX_COLLECTION_PAGE_SIZE).default(1000),
  /** Minimum gap between two Moxfield requests of a sync (ms). */
  moxfieldIntervalMs: z.number().int().min(250).max(30_000).default(MOX_PACING.intervalMs),
  /** Extra random delay added to each Moxfield request (ms). */
  moxfieldJitterMs: z.number().int().min(0).max(10_000).default(MOX_PACING.jitterMs),
});

/** The settings of each Settings section ("Reset to defaults" only resets its own). */
export const SELLING_SETTING_KEYS = ['requestIntervalMs', 'jitterMs', 'batchSize', 'cacheTtlHours', 'creditBonus', 'fallbackEnabled', 'fallbackCap'] as const;
export const MOXFIELD_SETTING_KEYS = ['moxfieldIntervalMs', 'moxfieldJitterMs', 'moxfieldPageSize'] as const;

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

/** Moxfield panel minimised or not. Survives reloads and is shared by every Moxfield tab. */
export const overlayCollapsedItem = storage.defineItem<boolean>('local:overlayCollapsed', { fallback: false });
