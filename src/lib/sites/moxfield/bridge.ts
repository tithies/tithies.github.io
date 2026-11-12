import { defineCustomEventMessaging } from '@webext-core/messaging/page';
import type { CollectionEntry } from '@/lib/cards/types';
import type { SiteRequest, SiteResult, SiteTabStatus } from '@/lib/sites/types';

export interface CaptureInfo {
  hasCapture: boolean;
  url?: string;
  capturedAt?: number;
}

export interface CollectionResult {
  url: string;
  entries: CollectionEntry[];
  totalResults: number;
  pages: number;
}

/** Bridge between the MAIN-world Moxfield hook and the isolated Moxfield content script. */
interface BridgeProtocol {
  getCaptureInfo(): CaptureInfo;
  fetchCollection(data: { pageSize: number; delayMs: number }): CollectionResult;
  /** Whether the page has a Moxfield session Tithies can use. */
  getStatus(): SiteTabStatus;
  /** One Moxfield API request, made by the page with its own session; answers are trimmed in the page. */
  api(data: SiteRequest): SiteResult;
  /** main → isolated */
  captureUpdated(data: CaptureInfo): void;
  collectionProgress(data: { page: number; totalPages: number; fetched: number }): void;
}

export const bridge = defineCustomEventMessaging<BridgeProtocol>({ namespace: 'tithies-bridge' });
