/**
 * Site-neutral card data: what every collection site (Moxfield today, others later) is read into.
 * Prints are identified the Scryfall way (set code + collector number + finish), so features can
 * compare and price cards without knowing which site they came from.
 */

export type Finish = 'nonFoil' | 'foil' | 'etched';

/** One printing of a card, trimmed to what Tithies needs. */
export interface CardPrint {
  /** The site's own card id. */
  id: string;
  scryfallId: string;
  set: string;
  setName: string;
  setType: string;
  name: string;
  /** Face names (front first). Single-faced cards have one entry. */
  faces: string[];
  /** Alternate printed name (Universes Beyond / Godzilla-style flavor name), e.g. "The Imperial City of Archades". */
  flavorName: string;
  cn: string;
  rarity: string;
  typeLine: string;
  isToken: boolean;
  /** USD market price for each finish as the site reports it (Moxfield: TCGplayer), null when unknown. */
  usd: { nonFoil: number | null; foil: number | null; etched: number | null };
}

/** One row of a user's collection. */
export interface CollectionEntry {
  id: string;
  qty: number;
  condition: string;
  finish: Finish;
  lang: string;
  isProxy: boolean;
  isAlter: boolean;
  /** "paper", "mtgo" or "arena" when the site says (collection rows only). */
  game?: string;
  card: CardPrint;
}

/** Collection entries aggregated by exact print + finish (conditions merged, NM is always used). */
export interface PrintGroup {
  key: string;
  qty: number;
  entryIds: string[];
  conditions: Record<string, number>;
  alters: number;
  finish: Finish;
  card: CardPrint;
}
