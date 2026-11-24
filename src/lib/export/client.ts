/** Dashboard side of the export: messages to the background, and the live change-log row. */
import { useLiveQuery } from 'dexie-react-hooks';
import type { AccountKey } from '@/lib/accounts/types';
import { getOp, latestOps } from '@/lib/changes/log';
import { db } from '@/lib/db';
import type { ChangeOp } from '@/lib/changes/types';
import { useEffect, useState } from 'react';
import { onMessage, sendMessage } from '@/lib/messaging';
import type { SiteType } from '@/lib/sites/types';
import type { StartExportsRequest } from './job';
import type { ExportDetails, ReadProgress, TargetRead } from './types';

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
/** Starts the exports of the cards to each target (one after another, in the order given). */
export const startExport = (type: SiteType, req: StartExportsRequest) => sendMessage('startExport', { type, ...req });
/** Cancels these exports (running or waiting); the others go on. */
export const cancelExport = (type: SiteType, opIds: number[]) => sendMessage('cancelExport', { type, opIds });
/** Stops the preview read (the dialog closed while reading). */
export const cancelExportRead = (type: SiteType) => sendMessage('cancelExport', { type, read: true });

/** An action of the change log, live (undefined while loading, null when gone). */
export function useChangeOp(opId: number | null) {
  return useLiveQuery(async () => (opId == null ? null : ((await getOp(opId)) ?? null)), [opId]);
}

/** Actions of the change log, live, in the order asked (gone ones left out; undefined while loading). */
export function useChangeOps(opIds: readonly number[]) {
  const key = opIds.join(',');
  return useLiveQuery(async () => (await db.changeOps.bulkGet([...opIds])).filter((o): o is ChangeOp => !!o), [key]);
}

/** Running first, then waiting (the next to run first), then the rest as given (newest first). */
const ACTIVE_ORDER: Partial<Record<ChangeOp['status'], number>> = { running: 0, queued: 1 };
const activeFirst = (ops: ChangeOp[]) =>
  ops
    .map((o, i) => ({ o, i }))
    .sort((a, b) => (ACTIVE_ORDER[a.o.status] ?? 2) - (ACTIVE_ORDER[b.o.status] ?? 2) || (a.o.status === 'queued' && b.o.status === 'queued' ? a.o.id! - b.o.id! : a.i - b.i))
    .map(({ o }) => o);

/** The latest exports made from `sourceAccountKey`'s pages, running first, then waiting, then newest first, live. */
export function useRecentExports(sourceAccountKey: AccountKey | null, limit = 10): ChangeOp[] {
  return (
    useLiveQuery(async () => {
      if (!sourceAccountKey) return [];
      return activeFirst(await latestOps((o) => o.kind === 'export' && (o.details as ExportDetails | undefined)?.sourceAccountKey === sourceAccountKey, limit));
    }, [sourceAccountKey, limit]) ?? []
  );
}
