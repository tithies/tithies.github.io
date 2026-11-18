/**
 * Moxfield writes: validation and the exact request each one makes. Pure (no extension APIs), so
 * the page hook builds the request it sends from it, and the background describes the very same
 * request in the change log before it is sent.
 *
 * Endpoints were read from Moxfield's own web app (2026-11-16): see the tithies-f2f-api memory.
 */
import type { BinderVisibility, DescribedRequest, ImportAnswer, SiteBinder, SiteMutation } from '@/lib/sites/types';
import { MOX_API_ORIGIN } from './constants';
import { MOX_CSV_HEADER } from './csv';
import { MOX_ENGLISH_ID, MOX_LANGUAGE_BY_ID } from './languages';

export { MOX_ENGLISH_ID };
/** Most entries removed in one bulk request. */
export const MAX_BULK_REMOVE = 1000;
/** Largest CSV sent in one import (characters). */
export const MAX_IMPORT_CSV = 2_000_000;

/** Most copies added in one addCard. */
export const MAX_ADD_QUANTITY = 10_000;

const VISIBILITIES: readonly BinderVisibility[] = ['private', 'unlisted', 'public'];
const FINISHES = new Set(['nonFoil', 'foil', 'etched']);
const isId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);

/** What the page sends: a JSON body, a CSV file (multipart form, field "file"), or nothing. */
export interface BuiltMutation {
  method: 'POST' | 'PUT' | 'DELETE';
  url: string;
  json?: unknown;
  file?: { field: 'file'; name: string; type: 'text/csv'; text: string };
}

/** Validates a write (it crosses the page boundary) and builds its request; null when it is not one Tithies makes. */
export function buildMoxMutation(raw: unknown): BuiltMutation | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.site !== 'moxfield') return null;
  switch (m.op) {
    case 'createBinder': {
      const name = typeof m.name === 'string' ? m.name.trim() : '';
      if (!name || name.length > 100 || !VISIBILITIES.includes(m.visibility as BinderVisibility)) return null;
      return { method: 'POST', url: `${MOX_API_ORIGIN}/v1/trade-binders`, json: { name, description: '', visibility: m.visibility } };
    }
    case 'bulkRemove': {
      const ids = m.entryIds;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_BULK_REMOVE || !ids.every(isId)) return null;
      return { method: 'POST', url: `${MOX_API_ORIGIN}/v1/collections/bulk/remove`, json: { collectionCardIds: ids } };
    }
    case 'deleteCollection':
      return { method: 'DELETE', url: `${MOX_API_ORIGIN}/v1/collections` };
    case 'importCsv': {
      const csv = m.csv;
      if (typeof csv !== 'string' || csv.length > MAX_IMPORT_CSV || !csv.startsWith(MOX_CSV_HEADER)) return null;
      if (m.binderId !== undefined && !isId(m.binderId)) return null;
      const u = new URL(`${MOX_API_ORIGIN}/v1/collections/import-file`);
      const params: [string, string][] = [
        ['game', 'paper'],
        ['defaultCondition', 'nearMint'],
        ['defaultCardLanguageId', MOX_ENGLISH_ID],
        ['defaultQuantity', '1'],
        ['pricingProvider', 'tcgplayer'],
        ['format', 'moxfield'],
      ];
      if (m.binderId) params.push(['tradeBinderId', m.binderId as string]);
      for (const [k, v] of params) u.searchParams.append(k, v);
      return { method: 'POST', url: u.toString(), file: { field: 'file', name: 'tithies-export.csv', type: 'text/csv', text: csv } };
    }
    case 'addCard': {
      // Moxfield's own ADD_CARD_TO_COLLECTION (read from its web app, 2026-11-18): the same body, nothing else.
      const q = m.quantity;
      if (!isId(m.cardId) || !Number.isInteger(q) || (q as number) < 1 || (q as number) > MAX_ADD_QUANTITY) return null;
      if (!FINISHES.has(m.finish as string) || typeof m.languageId !== 'string' || !MOX_LANGUAGE_BY_ID.has(m.languageId)) return null;
      if (m.binderId !== undefined && !isId(m.binderId)) return null;
      return {
        method: 'POST',
        url: `${MOX_API_ORIGIN}/v1/collections`,
        json: {
          cardId: m.cardId,
          quantity: q,
          condition: 'nearMint',
          game: 'paper',
          cardLanguageId: m.languageId,
          finish: m.finish,
          isAlter: false,
          isProxy: false,
          ...(m.binderId ? { tradeBinderId: m.binderId } : {}),
        },
      };
    }
    default:
      return null;
  }
}

/** The request as the change log shows it (same URL and body as sent; auth stays in the page). */
export function describeMoxMutation(op: SiteMutation): DescribedRequest | null {
  const b = buildMoxMutation(op);
  if (!b) return null;
  const body = b.file ? b.file.text : b.json !== undefined ? JSON.stringify(b.json, null, 2) : '';
  return { method: b.method, url: b.url, body };
}

/** The binder a createBinder answer describes (tolerant: Moxfield's answer shape isn't documented). */
export function binderFromAnswer(raw: unknown): SiteBinder | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  const b = r && typeof r.tradeBinder === 'object' && r.tradeBinder ? (r.tradeBinder as Record<string, unknown>) : r;
  if (!b || !isId(b.id)) return null;
  return {
    id: b.id as string,
    publicId: isId(b.publicId) ? (b.publicId as string) : (b.id as string),
    name: typeof b.name === 'string' ? b.name : '',
    visibility: typeof b.visibility === 'string' ? b.visibility : '',
  };
}

/** import-file's answer: `{"isSuccessful":true,"totalImportedCount":57,"errors":[]}` (verified 2026-11-16). */
export function importAnswer(raw: unknown): ImportAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.isSuccessful !== 'boolean') return null;
  const errors = Array.isArray(r.errors) ? r.errors.slice(0, 200).map((e) => (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 300)) : [];
  return { ok: r.isSuccessful, count: typeof r.totalImportedCount === 'number' ? r.totalImportedCount : 0, errors };
}

/** GET /v1/trade-binders → binders (an array, or `{ data: [...] }`). */
export function normalizeBinderList(raw: unknown): SiteBinder[] {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data) ? (raw as { data: unknown[] }).data : [];
  const out: SiteBinder[] = [];
  for (const item of list) {
    const b = binderFromAnswer(item);
    if (b && !out.some((x) => x.id === b.id)) out.push(b);
  }
  return out;
}
