/** Validation of what site pages send (the page world isn't trusted). */
import { z } from 'zod';
import type { SiteIdentity } from './types';

const identitySchema = z.object({
  userId: z.string().trim().min(1).max(64),
  userName: z.string().trim().min(1).max(100),
});

/** A well-formed account, else null ("unknown"). Extra fields are dropped. */
export function parseIdentity(v: unknown): SiteIdentity | null {
  const r = identitySchema.safeParse(v);
  return r.success ? { userId: r.data.userId, userName: r.data.userName } : null;
}
