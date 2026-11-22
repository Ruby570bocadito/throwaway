/**
 * The app's language, English or Spanish, picked like the landing page's (public/boot.js): `?lang=` in the address, then the
 * choice remembered on this device, then the browser's own language. Read once, at load: switching reloads the page, so no
 * component has to re-render in the other language halfway through a check (Rafa, 22-nov: the app in Spanish before Thursday).
 *
 * The words go side by side where they are used, `tr('English', 'Español')`, as on the landing page (src/landing/landing.ts):
 * nothing to keep in sync between a key file and the screen. What the models read (their prompts) and the recorded demo's
 * texts stay in English.
 */
export type Lang = 'en' | 'es';

function pick(): Lang {
  // Tests and any code run outside a browser read English.
  if (typeof location === 'undefined' || typeof navigator === 'undefined') return 'en';
  const asked = new URLSearchParams(location.search).get('lang');
  if (asked === 'en' || asked === 'es') {
    try {
      localStorage.setItem('lang', asked);
    } catch {
      /* storage blocked: the address still decides this time */
    }
    return asked;
  }
  try {
    const kept = localStorage.getItem('lang');
    if (kept === 'en' || kept === 'es') return kept;
  } catch {
    /* storage blocked */
  }
  const first = (navigator.languages && navigator.languages[0]) || navigator.language || '';
  return /^es\b/i.test(first) ? 'es' : 'en';
}

export const lang: Lang = pick();
if (typeof document !== 'undefined') document.documentElement.lang = lang;

/** The same words in English and in Spanish. */
export const tr = (en: string, es: string): string => (lang === 'es' ? es : en);

/** A number as the reader writes it: 10,559 in English, 10.559 in Spanish. */
export const num = (n: number, digits?: number): string =>
  n.toLocaleString(lang === 'es' ? 'es-ES' : 'en-US', digits === undefined ? undefined : { maximumFractionDigits: digits });

/** A number and its noun, singular or plural, in the reader's language: "1 habit", "3 hábitos". */
export const count = (n: number, en: [string, string], es: [string, string]): string =>
  `${num(n)} ${lang === 'es' ? (n === 1 ? es[0] : es[1]) : n === 1 ? en[0] : en[1]}`;

/** Switches language, remembered on this device, and reloads the page as it is (a recorded run stays recorded). */
export function setLang(next: Lang) {
  try {
    localStorage.setItem('lang', next);
  } catch {
    /* storage blocked: the address carries it instead */
  }
  const url = new URL(location.href);
  if (next === 'es') url.searchParams.set('lang', 'es');
  else url.searchParams.delete('lang');
  location.replace(url.toString());
}
