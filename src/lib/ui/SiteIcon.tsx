import { SITE_ICONS } from '@/lib/sites/icons';
import { siteOf } from '@/lib/sites/registry';
import type { SiteType } from '@/lib/sites/types';

/** The icon of a collection site (an account's type). */
export function SiteIcon({ type, size = 18 }: { type: SiteType; size?: number }) {
  return (
    <img
      src={SITE_ICONS[type]}
      width={size}
      height={size}
      alt={siteOf(type).label}
      title={siteOf(type).label}
      style={{ borderRadius: Math.round(size / 4), flexShrink: 0, display: 'block' }}
    />
  );
}
