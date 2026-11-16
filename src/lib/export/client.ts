/** Dashboard side of the export: messages to the background, and the live change-log row. */
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountKey } from '@/lib/accounts/types';
import { getOp } from '@/lib/changes/log';
import { sendMessage } from '@/lib/messaging';
import type { SiteType } from '@/lib/sites/types';
import type { StartExportRequest } from './job';

export const readExportTarget = (type: SiteType, accountKey: AccountKey) => sendMessage('readExportTarget', { type, accountKey });
export const startExport = (type: SiteType, req: StartExportRequest) => sendMessage('startExport', { type, ...req });
export const cancelExport = (type: SiteType) => sendMessage('cancelExport', { type });

/** An action of the change log, live (undefined while loading, null when gone). */
export function useChangeOp(opId: number | null) {
  return useLiveQuery(async () => (opId == null ? null : ((await getOp(opId)) ?? null)), [opId]);
}
