/**
 * Moxfield's languages, as its web app defines them (read from its bundle, 2026-11-18): the id its
 * API uses (`cardLanguageId`, `language.id`), the code (Scryfall's, as in `language.code` and
 * `card.lang`), and the name its CSV export and import use. Pure constants (the page hook imports it).
 */
export interface MoxLanguage {
  id: string;
  code: string;
  name: string;
}

export const MOX_LANGUAGES: readonly MoxLanguage[] = [
  { id: 'LD58x', code: 'en', name: 'English' },
  { id: 'YxlpG', code: 'es', name: 'Spanish' },
  { id: 'kAVXO', code: 'fr', name: 'French' },
  { id: 'YnWyB', code: 'de', name: 'German' },
  { id: 'EJ5yA', code: 'it', name: 'Italian' },
  { id: 'YdK6v', code: 'pt', name: 'Portuguese' },
  { id: 'EP6jq', code: 'ja', name: 'Japanese' },
  { id: 'LmyKq', code: 'ko', name: 'Korean' },
  { id: 'k71wl', code: 'ru', name: 'Russian' },
  { id: 'YlgbQ', code: 'zhs', name: 'Simplified Chinese' },
  { id: 'LVN4j', code: 'zht', name: 'Traditional Chinese' },
  { id: 'Y2P4X', code: 'he', name: 'Hebrew' },
  { id: 'ErnAR', code: 'la', name: 'Latin' },
  { id: 'E53lZ', code: 'grc', name: 'Ancient Greek' },
  { id: 'YoDab', code: 'ar', name: 'Arabic' },
  { id: 'Yjn7Z', code: 'sa', name: 'Sanskrit' },
  { id: 'E6QRq', code: 'ph', name: 'Phyrexian' },
  { id: 'L3Mxq', code: 'qya', name: 'Quenya' },
  { id: 'E0N4v', code: 'dw', name: 'Dwarvish' },
  { id: 'YvdKx', code: 'tlh', name: 'Klingon' },
];

/** Moxfield's language id for English (its default everywhere). */
export const MOX_ENGLISH_ID = 'LD58x';

/** Language codes → Moxfield's CSV names ("French", "Simplified Chinese"). */
export const MOX_LANGUAGE_NAMES: Readonly<Record<string, string>> = Object.fromEntries(MOX_LANGUAGES.map((l) => [l.code, l.name]));

/** Moxfield's language ids → language. */
export const MOX_LANGUAGE_BY_ID: ReadonlyMap<string, MoxLanguage> = new Map(MOX_LANGUAGES.map((l) => [l.id, l]));
