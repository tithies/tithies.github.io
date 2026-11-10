/**
 * Moxfield deck API (`/v3/decks` list and `/v3/decks/all/{publicId}`) → compact deck data.
 * Pure functions: they run inside the Moxfield page (MAIN world), so only trimmed data crosses the bridge.
 */
import { normalizeEntry, type MoxCard, type MoxFinish } from './normalize';

/** Bump when DeckCard's shape or the normaliser changes, so cached decks are fetched again. */
export const DECK_CARDS_VERSION = 2; // 2: per-copy finishes/prints from `printingData`

/** One deck from the deck list (no cards). */
export interface DeckSummary {
  /** Moxfield's internal deck id (stable key). */
  id: string;
  /** Id used in deck URLs and the deck API. */
  publicId: string;
  name: string;
  format: string;
  visibility: string;
  /** Full folder path, "/"-separated (e.g. "Collection/Final Fantasy"); '' when the deck has no folder. */
  folderPath: string;
  /** The list's `lastUpdatedAtUtc`, kept verbatim: it's what change detection compares. */
  lastUpdatedAt: string;
  createdAt: string;
  /** As reported by the list (mainboardCount includes commanders). */
  mainboardCount: number;
  sideboardCount: number;
  maybeboardCount: number;
  commanders: string[];
  publicUrl: string;
}

/** One card row of a deck board. */
export interface DeckCard {
  board: string;
  qty: number;
  finish: MoxFinish;
  isProxy: boolean;
  isAlter: boolean;
  card: MoxCard;
}

export interface BoardInfo {
  key: string;
  label: string;
}

/** Moxfield's deck boards, in display order. Unknown boards are still read (see boardLabel). */
export const BOARDS: BoardInfo[] = [
  { key: 'commanders', label: 'Commanders' },
  { key: 'companions', label: 'Companions' },
  { key: 'signatureSpells', label: 'Signature spells' },
  { key: 'mainboard', label: 'Mainboard' },
  { key: 'sideboard', label: 'Sideboard' },
  { key: 'maybeboard', label: 'Maybeboard' },
  { key: 'attractions', label: 'Attractions' },
  { key: 'stickers', label: 'Stickers' },
  { key: 'contraptions', label: 'Contraptions' },
  { key: 'planes', label: 'Planes' },
  { key: 'schemes', label: 'Schemes' },
  { key: 'tokens', label: 'Tokens' },
];

const BOARD_INDEX = new Map(BOARDS.map((b, i) => [b.key, i]));

export const boardLabel = (key: string): string =>
  BOARDS.find((b) => b.key === key)?.label ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

export const boardOrder = (key: string): number => BOARD_INDEX.get(key) ?? BOARDS.length;

const str = (v: unknown): string => (typeof v === 'string' ? v : v == null ? '' : String(v));
const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function normalizeDeckSummary(raw: any): DeckSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = str(raw.id);
  const publicId = str(raw.publicId);
  if (!id || !publicId) return null;
  return {
    id,
    publicId,
    name: str(raw.name) || '(unnamed deck)',
    format: str(raw.format),
    visibility: str(raw.visibility),
    folderPath: str(raw.folder?.name).trim(),
    lastUpdatedAt: str(raw.lastUpdatedAtUtc),
    createdAt: str(raw.createdAtUtc),
    mainboardCount: int(raw.mainboardCount),
    sideboardCount: int(raw.sideboardCount),
    maybeboardCount: int(raw.maybeboardCount),
    commanders: Array.isArray(raw.commanders) ? raw.commanders.map((c: any) => str(c?.name)).filter(Boolean) : [],
    publicUrl: str(raw.publicUrl) || `https://moxfield.com/decks/${publicId}`,
  };
}

/** `GET /v3/decks` → every deck of the logged-in user. */
export function normalizeDeckList(raw: any): DeckSummary[] {
  const decks = Array.isArray(raw?.decks) ? raw.decks : Array.isArray(raw) ? raw : [];
  return decks.map(normalizeDeckSummary).filter((d: DeckSummary | null): d is DeckSummary => d !== null);
}

/**
 * The copies behind one deck entry. An entry holding copies with different finishes or prints
 * ("3 Adventurer's Airship": 2 non-foil + 1 foil) keeps its first copy's finish at the top level
 * and lists every copy group in `printingData`, each with its own quantity, finish, print and
 * proxy/alter flags. Entries whose copies are all alike have no `printingData`.
 */
function entryCopies(row: any): any[] {
  const groups = Array.isArray(row?.printingData) ? row.printingData.filter((p: any) => p && Number(p.quantity) > 0) : [];
  if (!groups.length) return [row];
  const out = groups.map((p: any) => ({
    ...row,
    quantity: p.quantity,
    finish: p.finish,
    isFoil: p.isFoil,
    isAlter: p.isAlter ?? row.isAlter,
    isProxy: p.isProxy ?? row.isProxy,
    // The group's own card when given, else the entry's card moved to the group's print.
    card: p.card && typeof p.card === 'object' ? p.card : { ...row.card, set: p.set ?? row.card?.set, cn: p.cn ?? row.card?.cn, set_name: p.set_name ?? row.card?.set_name, rarity: p.rarity ?? row.card?.rarity },
  }));
  // Never lose copies if the groups don't add up to the entry's quantity.
  const rest = (Number(row.quantity) || 0) - groups.reduce((s: number, p: any) => s + Number(p.quantity), 0);
  if (rest > 0) out.push({ ...row, quantity: rest });
  return out;
}

/**
 * `GET /v3/decks/all/{publicId}` → every card of every board. Entries have the same shape as
 * collection rows, so `normalizeEntry` reads them. The top-level `tokens` list (tokens the deck's
 * cards make, added by Moxfield) is not a board and is ignored.
 */
export function normalizeDeckCards(raw: any): { lastUpdatedAt: string; cards: DeckCard[] } {
  const cards: DeckCard[] = [];
  const boards = raw?.boards && typeof raw.boards === 'object' ? raw.boards : {};
  for (const [board, data] of Object.entries<any>(boards)) {
    const rows = data?.cards && typeof data.cards === 'object' ? Object.values<any>(data.cards) : [];
    for (const row of rows) {
      for (const copy of entryCopies(row)) {
        const e = normalizeEntry(copy);
        if (!e || e.qty <= 0 || !e.card.set || !e.card.cn) continue;
        cards.push({ board, qty: e.qty, finish: e.finish, isProxy: e.isProxy, isAlter: e.isAlter, card: e.card });
      }
    }
  }
  return { lastUpdatedAt: str(raw?.lastUpdatedAtUtc), cards };
}
