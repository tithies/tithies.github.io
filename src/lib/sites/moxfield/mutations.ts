/**
 * Moxfield writes: validation and the exact request each one makes. Pure (no extension APIs), so
 * the page hook builds the request it sends from it, and the background describes the very same
 * request in the change log before it is sent.
 *
 * Endpoints were read from Moxfield's own web app (2026-11-16): see the tithies-f2f-api memory.
 */
import type { DeckFolder } from '@/lib/decks/types';
import type { BinderVisibility, DeckAnswer, DescribedRequest, ImportAnswer, SiteBinder, SiteMutation } from '@/lib/sites/types';
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

/** Most copies of a card added to a deck in one addDeckCard (Moxfield's own "add card" caps it at 99). */
export const MAX_DECK_ADD_QUANTITY = 99;
/** Largest deck import text sent in one request (characters; a deck shows at most 1,000 cards). */
export const MAX_DECK_TEXT = 200_000;
/** Longest deck name Tithies sends. */
export const MAX_DECK_NAME = 200;
/** Longest folder path Tithies sends. */
export const MAX_FOLDER_PATH = 200;

/**
 * One folder name: letters, numbers, spaces and hyphens, as Moxfield's own folder form accepts
 * (`/^[a-zA-Z0-9\s-]+$/`, read from its web app 2026-11-24; Tithies takes plain spaces only). A
 * path joins names with "/" (a folder in a folder).
 */
export const FOLDER_NAME = /^[a-zA-Z0-9 -]+$/;
export const validFolderPath = (path: string) => {
  const t = path.trim();
  return t.length > 0 && t.length <= MAX_FOLDER_PATH && t.split('/').every((seg) => seg.trim() !== '' && FOLDER_NAME.test(seg));
};
/** Deck names: any text but control characters. */
const validDeckName = (name: string) => name.trim().length > 0 && name.length <= MAX_DECK_NAME && !/[\u0000-\u001f\u007f]/.test(name);
const isVersion = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1e9;

const VISIBILITIES: readonly BinderVisibility[] = ['private', 'unlisted', 'public'];
const FINISHES = new Set(['nonFoil', 'foil', 'etched']);
const isId = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(s);

/**
 * What the page sends: a JSON body, a CSV file (multipart form, field "file"), or nothing.
 * `headers`: a deck change's own (Moxfield's `X-Public-Deck-ID` and `X-Deck-Version`, lowercase).
 */
export interface BuiltMutation {
  method: 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: { 'x-public-deck-id': string; 'x-deck-version': string };
  json?: unknown;
  file?: { field: 'file'; name: string; type: 'text/csv'; text: string };
}

/** The headers every change of a deck sends (as Moxfield's own deck editor does). */
const deckHeaders = (publicId: string, version: number) => ({ 'x-public-deck-id': publicId, 'x-deck-version': String(version) });

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
    case 'createDeckFolder': {
      // Moxfield's own CREATE_FOLDER (2026-11-24): the full path as the name.
      const name = typeof m.name === 'string' ? m.name.trim() : '';
      if (!validFolderPath(name)) return null;
      return { method: 'POST', url: `${MOX_API_ORIGIN}/v1/deck-folders`, json: { name: name.split('/').map((seg) => seg.trim()).join('/') } };
    }
    case 'createDeck': {
      // Moxfield's own CREATE_DECK (2026-11-24), with only what a plain deck needs.
      const name = typeof m.name === 'string' ? m.name.trim() : '';
      if (!validDeckName(name) || !VISIBILITIES.includes(m.visibility as BinderVisibility)) return null;
      if (typeof m.importText !== 'string' || m.importText.length > MAX_DECK_TEXT) return null;
      if (m.folderId !== undefined && !isId(m.folderId)) return null;
      return {
        method: 'POST',
        url: `${MOX_API_ORIGIN}/v3/decks`,
        json: {
          name,
          format: 'none',
          visibility: m.visibility,
          importText: m.importText,
          pricingProvider: 'tcgplayer',
          usePrefPrintings: false,
          ...(m.folderId ? { deckFolderId: m.folderId } : {}),
        },
      };
    }
    case 'importDeck': {
      // Moxfield's own IMPORT_TEXT (2026-11-24), keeping the exact prints asked for. It adds to what
      // is there; `replaceAll: true` would empty every board, not only the mainboard (verified 2026-11-24).
      if (!isId(m.deckId) || !isId(m.publicId) || !isVersion(m.version)) return null;
      if (typeof m.importText !== 'string' || m.importText.length > MAX_DECK_TEXT) return null;
      return {
        method: 'POST',
        url: `${MOX_API_ORIGIN}/v3/decks/${m.deckId}/import`,
        headers: deckHeaders(m.publicId, m.version),
        json: { importText: m.importText, replaceAll: false, pricingProvider: 'tcgplayer', usePrefPrintings: false },
      };
    }
    case 'addDeckCard': {
      // Moxfield's own ADD_CARD_TO_BOARD (2026-11-24), into the mainboard.
      const q = m.quantity;
      if (!isId(m.deckId) || !isId(m.publicId) || !isVersion(m.version) || !isId(m.cardId)) return null;
      if (!Number.isInteger(q) || (q as number) < 1 || (q as number) > MAX_DECK_ADD_QUANTITY || !FINISHES.has(m.finish as string)) return null;
      return {
        method: 'POST',
        url: `${MOX_API_ORIGIN}/v2/decks/${m.deckId}/cards/mainboard`,
        headers: deckHeaders(m.publicId, m.version),
        json: { cardId: m.cardId, quantity: q, finish: m.finish, usePrefPrinting: false },
      };
    }
    default:
      return null;
  }
}

/** The request as the change log shows it (same URL, headers of its own and body as sent; auth stays in the page). */
export function describeMoxMutation(op: SiteMutation): DescribedRequest | null {
  const b = buildMoxMutation(op);
  if (!b) return null;
  const body = b.file ? b.file.text : b.json !== undefined ? JSON.stringify(b.json, null, 2) : '';
  return { method: b.method, url: b.url, ...(b.headers ? { headers: { ...b.headers } } : {}), body };
}

/** A createDeckFolder answer: `{ id, name }` (Moxfield's own folder form reads `data.id`, `data.name`). */
export function folderFromAnswer(raw: unknown): DeckFolder | null {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null;
  if (!r || !isId(r.id)) return null;
  return { id: r.id as string, path: typeof r.name === 'string' ? r.name.trim() : '' };
}

/**
 * What a deck write's answer says about the deck (tolerant: `{ isSuccessful, publicId, errors }`
 * for a create, read from Moxfield's app; the deck itself, or `{ deck }`, for the other changes).
 * `failed`: the site said it didn't make it (`isSuccessful: false`), with its errors.
 */
export function deckFromAnswer(raw: unknown): { deck: DeckAnswer; failed: boolean; errors: string[] } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const inner = r.deck && typeof r.deck === 'object' ? (r.deck as Record<string, unknown>) : null;
  const pick = (k: string) => r[k] ?? inner?.[k];
  const deck: DeckAnswer = {};
  if (isId(pick('id'))) deck.id = pick('id') as string;
  if (isId(pick('publicId'))) deck.publicId = pick('publicId') as string;
  if (isVersion(pick('version'))) deck.version = pick('version') as number;
  const errors = Array.isArray(r.errors) ? r.errors.slice(0, 200).map((e) => (typeof e === 'string' ? e : JSON.stringify(e)).slice(0, 300)) : [];
  return { deck, failed: r.isSuccessful === false, errors };
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
