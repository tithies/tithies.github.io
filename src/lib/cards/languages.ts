/**
 * Card languages, by the codes Scryfall uses (and Moxfield reports): "en", "fr", "ja", "zhs"…
 *
 * Two languages exist for a collection copy. The site's card object (the print) has its own one:
 * Moxfield has one card object per print *and* language, e.g. a French MH2 #68 Suspend, image and
 * printed name included. The collection entry also has a Language field, which the user sets and
 * the site never checks against the print (verified 2026-11-18: an FBB print, only printed in
 * French there, with Language "English"). Tithies trusts the Language field (`CollectionEntry.lang`)
 * and warns when the print is in another language. Deck cards have no Language field: their
 * language is their print's.
 */
import type { CardPrint } from './types';

/** Language names, by code (Moxfield's own list, 2026-11-18). */
export const LANGUAGE_LABELS: Readonly<Record<string, string>> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  ru: 'Russian',
  zhs: 'Simplified Chinese',
  zht: 'Traditional Chinese',
  he: 'Hebrew',
  la: 'Latin',
  grc: 'Ancient Greek',
  ar: 'Arabic',
  sa: 'Sanskrit',
  ph: 'Phyrexian',
  qya: 'Quenya',
  dw: 'Dwarvish',
  tlh: 'Klingon',
};

/** A row's language; rows saved before languages were kept are English. */
export const langOf = (x: { lang?: string | null }): string => (x.lang || 'en').toLowerCase();

export const isEnglish = (lang: string | null | undefined): boolean => !lang || lang.toLowerCase() === 'en';

/** "French"; an unknown code is shown as is. */
export const langLabel = (lang: string | null | undefined): string => LANGUAGE_LABELS[(lang || 'en').toLowerCase()] ?? (lang || 'en');

/** "FR", "ZHS". */
export const langBadge = (lang: string | null | undefined): string => (lang || 'en').toUpperCase();

/**
 * The print's language when it differs from the copy's (its Language field), else null. Prints
 * read before Tithies kept their language have none, and never differ.
 */
export function printLangMismatch(copy: { lang: string; card: Pick<CardPrint, 'lang'> }): string | null {
  const print = copy.card.lang?.toLowerCase();
  return print && print !== langOf(copy) ? print : null;
}

/**
 * "Moxfield's Language says French, but this print is English (1 of 3 copies)". `copies` of `qty`
 * disagree (all of them when not given); `siteLabel` = the site's name.
 */
export function mismatchText(lang: string, printLang: string, copies?: number, qty?: number, siteLabel = 'Moxfield'): string {
  const part = copies != null && qty != null && copies < qty ? ` (${copies} of ${qty} copies)` : '';
  return `${siteLabel}'s Language says ${langLabel(lang)}, but this print is ${langLabel(printLang)}${part}`;
}

/** Languages in display order: English first, then by name. */
export function sortLangs(langs: Iterable<string>): string[] {
  return [...new Set(langs)].sort((a, b) => (isEnglish(a) ? -1 : isEnglish(b) ? 1 : langLabel(a).localeCompare(langLabel(b))));
}
