/**
 * The change log: every write Tithies makes to a site, grouped by the user action that made it.
 * Writes can only be made through SiteClient.mutate, which needs a WriteLogger: `writeLogger`
 * below is the one every feature uses, so any new kind of write is logged without more code.
 */
import type { AccountKey } from '@/lib/accounts/types';
import { db } from '@/lib/db';
import type { WriteLogger, WriteOutcome } from '@/lib/sites/client';
import type { DescribedRequest } from '@/lib/sites/types';
import type { ChangeCall, ChangeOp } from './types';

export type NewChangeOp = Omit<ChangeOp, 'id' | 'status' | 'startedAt' | 'heartbeatAt' | 'calls' | 'unknownCalls'>;

export async function startOp(op: NewChangeOp, now = Date.now()): Promise<number> {
  return (await db.changeOps.add({ ...op, status: 'running', startedAt: now, heartbeatAt: now, calls: 0, unknownCalls: 0 })) as number;
}

/**
 * Several actions started together, in the order they run: the first running, the others queued
 * (each claims its turn with claimQueuedOp). All rows or none.
 */
export async function startOps(ops: NewChangeOp[], now = Date.now()): Promise<number[]> {
  return db.transaction('rw', db.changeOps, async () => {
    const ids: number[] = [];
    for (const [i, op] of ops.entries()) {
      ids.push((await db.changeOps.add({ ...op, status: i === 0 ? 'running' : 'queued', startedAt: now, heartbeatAt: now, calls: 0, unknownCalls: 0 })) as number);
    }
    return ids;
  });
}

/**
 * A queued action's turn: marks it running (started now) if it is still queued. False when it
 * was cancelled meanwhile, or deleted (its account forgotten, the log cleared): it doesn't run.
 */
export async function claimQueuedOp(id: number, now = Date.now()): Promise<boolean> {
  return db.transaction('rw', db.changeOps, async () => {
    const op = await db.changeOps.get(id);
    if (!op) return false;
    if (op.status === 'running') return true;
    if (op.status !== 'queued') return false;
    await db.changeOps.update(id, { status: 'running', startedAt: now, heartbeatAt: now });
    return true;
  });
}

/** A queued action that won't run: cancelled before it started (nothing sent). No-op once it has started. */
export async function cancelQueuedOp(id: number, error: string, now = Date.now()): Promise<boolean> {
  return db.transaction('rw', db.changeOps, async () => {
    const op = await db.changeOps.get(id);
    if (op?.status !== 'queued') return false;
    await db.changeOps.update(id, { status: 'cancelled', error, phase: undefined, finishedAt: now, heartbeatAt: now });
    return true;
  });
}

export async function patchOp(id: number, patch: Partial<Omit<ChangeOp, 'id'>>): Promise<void> {
  await db.changeOps.update(id, { ...patch, heartbeatAt: Date.now() });
}

export const getOp = (id: number) => db.changeOps.get(id);

export async function opCalls(opId: number): Promise<ChangeCall[]> {
  return db.changeCalls.where('opId').equals(opId).sortBy('seq');
}

/** Logs the writes of one action: each one before it is sent, then its outcome. */
export function writeLogger(opId: number, now: () => number = Date.now): WriteLogger {
  return {
    async begin(req: DescribedRequest): Promise<number> {
      return db.transaction('rw', db.changeOps, db.changeCalls, async () => {
        const seq = (await db.changeCalls.where('opId').equals(opId).count()) + 1;
        await db.changeCalls.add({ opId, seq, at: now(), method: req.method, url: req.url, ...(req.headers ? { headers: req.headers } : {}), body: req.body, outcome: 'sent' });
        await db.changeOps.update(opId, { calls: seq, heartbeatAt: now() });
        return seq;
      });
    },
    async end(seq: number, o: WriteOutcome): Promise<void> {
      await db.transaction('rw', db.changeOps, db.changeCalls, async () => {
        await db.changeCalls.update([opId, seq], {
          outcome: o.outcome,
          status: o.status,
          durationMs: o.durationMs,
          response: o.response,
          error: o.error,
          as: o.as ?? null,
        });
        if (o.outcome === 'unknown') {
          const op = await db.changeOps.get(opId);
          if (op) await db.changeOps.update(opId, { unknownCalls: (op.unknownCalls ?? 0) + 1 });
        }
      });
    },
  };
}

/**
 * On worker start: an action still marked running died with the previous worker. It is never
 * resumed; a write it had sent without an answer gets an unknown outcome. One still queued never
 * started: nothing was sent.
 */
export async function markStaleOps(now = Date.now()): Promise<void> {
  await db.transaction('rw', db.changeOps, db.changeCalls, async () => {
    for (const op of await db.changeOps.where('status').equals('queued').toArray()) {
      await db.changeOps.update(op.id!, {
        status: 'interrupted',
        finishedAt: now,
        phase: undefined,
        error: 'Not started: Tithies was closed, reloaded or updated before its turn. Nothing was changed.',
      });
    }
    for (const op of await db.changeOps.where('status').equals('running').toArray()) {
      const sent = await db.changeCalls.where('opId').equals(op.id!).filter((c) => c.outcome === 'sent').toArray();
      for (const c of sent) await db.changeCalls.update([c.opId, c.seq], { outcome: 'unknown', error: 'Tithies stopped before the answer came' });
      await db.changeOps.update(op.id!, {
        status: 'interrupted',
        finishedAt: now,
        unknownCalls: (op.unknownCalls ?? 0) + sent.length,
        error: 'Interrupted: Tithies was closed, reloaded or updated while this was running. It is not resumed; see which changes were made below.',
      });
    }
  });
}

/** Every action, newest first (for the log page; use inside a live query). */
export const listOps = (): Promise<ChangeOp[]> => db.changeOps.orderBy('startedAt').reverse().toArray();
/** The `limit` newest actions that pass `keep`. */
export const latestOps = (keep: (op: ChangeOp) => boolean, limit: number): Promise<ChangeOp[]> =>
  db.changeOps.orderBy('startedAt').reverse().filter(keep).limit(limit).toArray();

/** Counts for Settings → Stored data (use inside a live query). `running`: running or waiting for their turn. */
export async function changeLogCounts(): Promise<{ ops: number; calls: number; running: number }> {
  const [ops, calls, running] = await Promise.all([db.changeOps.count(), db.changeCalls.count(), db.changeOps.where('status').anyOf('running', 'queued').count()]);
  return { ops, calls, running };
}

export async function clearChangeLog(): Promise<void> {
  await db.transaction('rw', db.changeOps, db.changeCalls, async () => {
    await db.changeOps.clear();
    await db.changeCalls.clear();
  });
}

/** Forgetting an account deletes the log of its changes too. */
export async function clearChangeLogOf(accountKey: AccountKey): Promise<void> {
  await db.transaction('rw', db.changeOps, db.changeCalls, async () => {
    const ids = (await db.changeOps.where('accountKey').equals(accountKey).primaryKeys()) as number[];
    if (!ids.length) return;
    await db.changeCalls.where('opId').anyOf(ids).delete();
    await db.changeOps.bulkDelete(ids);
  });
}

export async function measureChangeLog(): Promise<{ ops: number; calls: number; bytes: number }> {
  let bytes = 0;
  await db.changeOps.each((r) => (bytes += JSON.stringify(r).length));
  await db.changeCalls.each((r) => (bytes += JSON.stringify(r).length));
  return { ops: await db.changeOps.count(), calls: await db.changeCalls.count(), bytes };
}
