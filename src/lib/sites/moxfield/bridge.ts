import { defineCustomEventMessaging } from '@webext-core/messaging/page';
import type { SiteApiCall, SiteResult, SiteTabStatus } from '@/lib/sites/types';
import type { CaptureInfo, CollectionResult, SessionInfo } from './page-api';

export type { CaptureInfo, CollectionResult, SessionInfo };

/** Bridge between the MAIN-world Moxfield hook and the isolated Moxfield content script. */
interface BridgeProtocol {
  getCaptureInfo(): CaptureInfo;
  fetchCollection(data: { pageSize: number; delayMs: number }): CollectionResult;
  /** Whether the page has a Moxfield session Tithies can use, and whose. */
  getStatus(): SiteTabStatus;
  /** One Moxfield API request, made by the page with its own session; answers are trimmed in the page. */
  api(data: SiteApiCall): SiteResult;
  /** main → isolated */
  captureUpdated(data: CaptureInfo): void;
  collectionProgress(data: { page: number; totalPages: number; fetched: number }): void;
  /** main → isolated: the session appeared, went away, or now belongs to another account. */
  sessionChanged(data: SessionInfo): void;
}

/**
 * The page world is not trusted (it is Moxfield's own JS, and anything injected there): the
 * isolated side validates what it receives before relaying it to the extension.
 */
export const bridge = defineCustomEventMessaging<BridgeProtocol>({ namespace: 'tithies-bridge' });
