/** Dashboard side of the export: messages to the background, and the live change-log row. */
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountKey } from '@/lib/accounts/types';
import { getOp } from '@/lib/changes/log';
import { useEffect, useState } from 'react';
import { onMessage, sendMessage } from '@/lib/messaging';
import type { SiteType } from '@/lib/sites/types';
import type { StartExportRequest } from './job';
import type { ReadProgress, TargetRead } from './types';

export const readExportTarget = (type: SiteType, accountKey: AccountKey, read: TargetRead) => sendMessage('readExportTarget', { type, accountKey, read });

/** Progress of the preview read of `accountKey` (null when none is running). */
export function useReadProgress(accountKey: AccountKey | null): ReadProgress | null {
  const [p, setP] = useState<ReadProgress | null>(null);
  useEffect(() => {
    setP(null);
    return onMessage('exportReadProgress', ({ data }) => {
      if (data.accountKey === accountKey) setP({ done: data.done, total: data.total });
    });
  }, [accountKey]);
  return p;
}
export const startExport = (type: SiteType, req: StartExportRequest) => sendMessage('startExport', { type, ...req });
export const cancelExport = (type: SiteType) => sendMessage('cancelExport', { type });

/** An action of the change log, live (undefined while loading, null when gone). */
export function useChangeOp(opId: number | null) {
  return useLiveQuery(async () => (opId == null ? null : ((await getOp(opId)) ?? null)), [opId]);
}
