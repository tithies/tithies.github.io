import { moxfieldExporter } from '@/lib/sites/moxfield/export';
import type { BinderVisibility, SiteMutation, SiteType } from '@/lib/sites/types';
import type { PlanLimits } from './plan';
import type { ExportItem } from './types';

/** The writes an export makes on one site. */
export interface SiteExporter {
  limits: PlanLimits;
  createBinder(name: string, visibility: BinderVisibility): SiteMutation;
  /** One write per chunk of entries. */
  removeEntries(entryIds: string[]): SiteMutation[];
  deleteCollection(): SiteMutation;
  /** The writes that add `items`: one per chunk of items, plus one per item `limits.oneByOne` picks; into the binder when given. */
  importItems(items: ExportItem[], binderId: string | null): SiteMutation[];
}

export const EXPORTERS: Partial<Record<SiteType, SiteExporter>> = { moxfield: moxfieldExporter };

export const exporterOf = (type: SiteType): SiteExporter | null => EXPORTERS[type] ?? null;
