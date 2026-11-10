/** Formatting helpers shared by every dashboard feature. */
import type { MoxFinish } from '@/lib/moxfield/normalize';

export const dateTime = (t: number) => new Date(t).toLocaleString();

// English like the rest of the UI (the browser locale would mix in e.g. French).
const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
/** "5 minutes ago", "yesterday"… */
export function timeAgo(t: number, now = Date.now()): string {
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return rtf.format(0, 'second');
  if (abs < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), 'hour');
  return rtf.format(Math.round(s / 86_400), 'day');
}

/** "4 min 20 s", "35 s" */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

export const FINISH_LABEL: Record<MoxFinish, string> = { nonFoil: 'Non-foil', foil: 'Foil', etched: 'Etched' };
export const finishLabel = (f: MoxFinish) => FINISH_LABEL[f] ?? f;

/** Lower-case, accents removed: for forgiving text search. */
export const fold = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
