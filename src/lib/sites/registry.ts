/** Every supported collection site, by type. */
import { moxfieldSite } from './moxfield/provider';
import type { SiteProvider } from './provider';
import type { SiteType } from './types';

export const SITES: Record<SiteType, SiteProvider> = {
  moxfield: moxfieldSite,
};

export const SITE_TYPES = Object.keys(SITES) as SiteType[];

export const siteOf = (type: SiteType): SiteProvider => SITES[type];

export const isSiteType = (v: unknown): v is SiteType => typeof v === 'string' && Object.hasOwn(SITES, v);

export type { SiteProvider };
