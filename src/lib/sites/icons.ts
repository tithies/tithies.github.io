/**
 * Each site's icon, for extension pages only (bundled: nothing is loaded from the site). Kept out
 * of the provider so content scripts don't pull images in.
 */
import moxfieldIcon from '@/assets/sites/moxfield.png';
import type { SiteType } from './types';

export const SITE_ICONS: Record<SiteType, string> = {
  moxfield: moxfieldIcon,
};
