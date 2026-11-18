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
  /**
   * The print's own language (Moxfield has one card object per print and language): "en", "fr"…
   * Unset for prints read before Tithies kept it. A collection copy's language is its entry's
   * Language field instead (`CollectionEntry.lang`), which can disagree (see lib/cards/languages).
   */
  lang?: string;
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
  /** The copy's language (Scryfall code): the site entry's Language field, else the print's. */
  lang: string;
  isProxy: boolean;
  isAlter: boolean;
  /** "paper", "mtgo" or "arena" when the site says (collection rows only). */
  game?: string;
  /** The site's language id (Moxfield: "LD58x" = English), when known. */
  langId?: string;
  /** The binder the entry is in (the site's binder id), if any. */
  binderId?: string;
  /** When the site last changed the entry (ISO), when it says. */
  updatedAt?: string;
  card: CardPrint;
}

/** Collection entries aggregated by exact print + finish + language (conditions merged, NM is always used). */
export interface PrintGroup {
  key: string;
  /** The copies' language (their Language field). */
  lang: string;
  qty: number;
  /** Copies whose print is in another language than their Language field, and that print language. */
  mismatchCopies: number;
  printLang?: string;
  entryIds: string[];
  conditions: Record<string, number>;
  alters: number;
  finish: Finish;
  card: CardPrint;
}
