/**
 * F2F's languages (verified 2026-11-18): the values of its search's `Language` facet (the docs'
 * `General_Card_Language`), the language codes in its SKUs (`SIN-MTG-{SET}-{CN}-{LANG}-…`), and the
 * language its titles end the card name with ("Swords to Plowshares - French [41] […]").
 *
 * F2F lists regular prints in English only. Other languages are listed only for prints that exist
 * in one language, often in sets of their own ("Foreign Black Border: French", SKU set FBBf;
 * "Renaissance French", RENf), plus some promos, box toppers and scanned single copies.
 */

/** Language code (Scryfall's) → F2F's facet value. F2F spells it "Portugese", and has one Chinese. */
export const F2F_LANGUAGES: Readonly<Record<string, string>> = {
  en: 'English',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  es: 'Spanish',
  pt: 'Portugese',
  ja: 'Japanese',
  ko: 'Korean',
  zhs: 'Chinese',
  zht: 'Chinese',
  ru: 'Russian',
  ph: 'Phyrexian',
  he: 'Hebrew',
  la: 'Latin',
  ar: 'Arabic',
  sa: 'Sanskrit',
  grc: 'Greek',
  dw: 'Dwarvish',
  tlh: 'Klingon',
};

/** SKU language code → F2F language name. */
export const F2F_SKU_LANGUAGES: Readonly<Record<string, string>> = {
  ENG: 'English',
  FRA: 'French',
  DEU: 'German',
  ITA: 'Italian',
  SPA: 'Spanish',
  POR: 'Portugese',
  JPN: 'Japanese',
  KOR: 'Korean',
  ZHO: 'Chinese',
  CHI: 'Chinese',
  RUS: 'Russian',
  PHY: 'Phyrexian',
  ELL: 'Greek',
  DWA: 'Dwarvish',
  KLI: 'Klingon',
};

/** F2F's name for a language code; null when F2F lists no card in it (e.g. Quenya). */
export const f2fLanguage = (lang: string | null | undefined): string | null => F2F_LANGUAGES[(lang || 'en').toLowerCase()] ?? null;

/** One spelling per language: "Portuguese" = "Portugese", every Chinese = "chinese". */
export const normLanguage = (name: string | null | undefined): string => {
  const n = (name || 'English').trim().toLowerCase();
  if (n === 'portuguese') return 'portugese';
  if (n.startsWith('chinese')) return 'chinese';
  return n;
};

/** The doc's language (F2F's name; an empty one is English) is `lang`'s. */
export const docInLanguage = (doc: { language: string }, lang: string | null | undefined): boolean => {
  const want = f2fLanguage(lang);
  return want != null && normLanguage(doc.language) === normLanguage(want);
};

/** Names F2F titles end a non-English card name with (" - Japanese"). */
export const F2F_TITLE_LANGUAGES = [
  'Japanese',
  'French',
  'German',
  'Italian',
  'Spanish',
  'Portugese',
  'Portuguese',
  'Korean',
  'Russian',
  'Chinese Simplified',
  'Chinese Traditional',
  'Chinese',
  'Phyrexian',
  'Hebrew',
  'Latin',
  'Arabic',
  'Sanskrit',
  'Greek',
  'Dwarvish',
  'Klingon',
] as const;
