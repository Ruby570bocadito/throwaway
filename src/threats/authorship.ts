// Threat: "who wrote this?" — stylometric de-anonymisation of a text you want to post anonymously.
// Local: fingerprint (Burrows' Delta), identifying details and rewrite (Gemini Nano).
// Cloud: a lineup attack. The attacker gets the published text and ten PUBLIC writers, shuffled and unlabeled;
// it is never told which one is the user.

import {
  listAt, ModelJsonError, parseModelJson, parseModelJsonLenient, PrivacyViolation, Private, Public, release, secret,
  type JsonSchema, type Kit, type Publishable, type Threat,
} from '../framework';

const DETAILS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    details: {
      type: 'array',
      items: { type: 'object', properties: { phrase: { type: 'string' }, why: { type: 'string' } }, required: ['phrase', 'why'] },
    },
  },
  required: ['details'],
};

const REWRITE_SCHEMA: JsonSchema = { type: 'object', properties: { rewrite: { type: 'string' } }, required: ['rewrite'] };

const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

/** Rule-found details that no flagged detail already covers ("6 people" is inside "6 people to 2"). */
const notCovered = <T extends { phrase: string }>(rules: T[], flagged: { phrase: string }[]) =>
  rules.filter((r) => !flagged.some((d) => hasPhrase(d.phrase, r.phrase) || hasPhrase(r.phrase, d.phrase)));

/**
 * Deterministic guard: did a model write the same NEW 3-word phrase three or more times? Measured live (16-nov): Gemini
 * Nano copied a placeholder from our prompt ("what you wrote instead") into the text seven times.
 */
export function looksBroken(next: string, prev: string): boolean {
  const grams = (s: string) => {
    const w = s.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i + 2 < w.length; i++) out.push(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
    return out;
  };
  const before = new Set(grams(prev));
  const counts = new Map<string, number>();
  for (const g of grams(next)) if (!before.has(g)) counts.set(g, (counts.get(g) ?? 0) + 1);
  return [...counts.values()].some((n) => n >= 3);
}

// ── Deterministic generalisation: no model, the same result every time ─────────────────────────────────────────────

const NUM_VALUE: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, dozen: 12, hundred: 100, thousand: 1e3, million: 1e6,
  billion: 1e9,
};
const NUM_WORD = Object.keys(NUM_VALUE).sort((a, b) => b.length - a.length).join('|');
/** Digits ("6", "1,200", "3.5") or number words, also compound ones ("twenty-five", "two hundred"). */
const NUM = `\\d+(?:[.,]\\d+)*|(?:${NUM_WORD})(?:[\\s-]+(?:and\\s+)?(?:${NUM_WORD}))*`;
const MONTH = 'January|February|March|April|June|July|August|September|October|November|December'; // not "May": usually a verb
const WEEKDAY = 'Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday';
const DAY_NUM = '\\d{1,2}(?:st|nd|rd|th)?';
const TIME_ONE =
  `(?:${DAY_NUM}\\s+(?:of\\s+)?)?(?:${MONTH})(?:\\s+${DAY_NUM}(?!\\d))?|(?:${WEEKDAY})|` +
  `\\d{1,2}[./-]\\d{1,2}[./-](?:\\d{4}|\\d{2})(?![\\d./-])|\\d{4}-\\d{2}-\\d{2}(?!\\d)|(?:19|20)\\d{2}|Q[1-4]`;
/** A date: "March", "3 March", "March 2023", "Monday, March 3", "Q3 2024", "16/11/2023", "2023-11-16"… */
const TIME = `(?:${TIME_ONE})(?:,?\\s+(?:of\\s+)?(?:${TIME_ONE}))*`;
const TIME_PREP = 'in|on|at|during|since|after|by|from|last|this|early|late|around|of';
const FUNCTION_WORDS = new Set(
  (
    'a an the of in on at to for from by with into over under about during since after before until this that these those ' +
    'last next early late every each and or but so yet then than as if our my their his her its your we i they he she it you ' +
    'is was were are be been has had have will would can could may might must did do does not no when where which who while because'
  ).split(' '),
);
const DETERMINERS = new Set('a an the our my their his her its your this that these those'.split(' '));
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ── Identifiers anyone can look up: links, email addresses, usernames, phone numbers ───────────────────────────────
// They name you outright, so fixed rules replace them whole, before anything else (the count rules used to turn
// "+351 912 345 678" into "+many many many many", and "…/blog/2023" into "…/blog/at some point").

export type IdentifierKind = 'link' | 'email address' | 'username' | 'phone number';
const PLACEHOLDER: Record<IdentifierKind, string> = { link: '[link]', 'email address': '[email address]', username: '[username]', 'phone number': '[phone number]' };
const URL_WITH_SCHEME = /\b(?:https?:\/\/|ftp:\/\/|www\.)[^\s<>"'()[\]{}]+/gi;
const EMAIL = /(?<![\w.%+-])[\w.%+-]+(?:@|\s*[[({]at[\])}]\s*)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:(?:\.|\s*[[({]dot[\])}]\s*)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+/gi;
// A bare domain needs a TLD that is not also an English word ("left.it", "about.me" are left alone without "https://").
const BARE_DOMAIN = /(?<![\w@.-])[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.(?:com|net|org|io|dev|design|co|app|blog|xyz|info|ai|page|site|tech|studio|edu|gov|uk|pt|es|de|fr|nl|eu|ly|gg|tv)(?![\w-])(?:\/[^\s<>"'()[\]{}]*)?/g;
const HANDLE = /(?<![\w@./])@[A-Za-z0-9_](?:[A-Za-z0-9_.]*[A-Za-z0-9_])?|(?<![\w/])\/?u\/[A-Za-z0-9_-]{3,20}(?![\w-])/g;
const PHONE = /(?<![\w+.,/])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,5}\)[\s.-]?)?\d{2,5}(?:[\s-]\d{2,5}){1,4}(?![\w/]|[.,]\d)|(?<![\w+.,/])\+?\d{9,15}(?![\w/]|[.,]\d)/g;
const NUMERIC_DATE = /^(?:\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})|\d{4}-\d{2}-\d{2})$/;

/** 7–15 digits written like a phone number, not a list of years ("2019 2020 2021") or a date. */
function isPhone(s: string): boolean {
  const digits = s.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || NUMERIC_DATE.test(s.trim())) return false;
  const groups = s.split(/[\s().-]+/).filter(Boolean);
  return !(groups.length > 1 && groups.every((g) => /^(?:19|20)\d{2}$/.test(g)));
}

/** Every link, email address, username and phone number in `text`, in order, without overlaps. */
export function identifiers(text: string): { phrase: string; kind: IdentifierKind; start: number; end: number }[] {
  const out: { phrase: string; kind: IdentifierKind; start: number; end: number }[] = [];
  const add = (kind: IdentifierKind, start: number, raw: string) => {
    const phrase = raw.replace(/[.,;:!?'"’]+$/, '');
    const end = start + phrase.length;
    if (phrase && !out.some((o) => start < o.end && end > o.start)) out.push({ phrase, kind, start, end });
  };
  // A full URL first (it may hold an email), then emails (their domain is not a link of its own), then the rest.
  for (const m of text.matchAll(URL_WITH_SCHEME)) add('link', m.index ?? 0, m[0]);
  for (const m of text.matchAll(EMAIL)) add('email address', m.index ?? 0, m[0]);
  for (const m of text.matchAll(BARE_DOMAIN)) add('link', m.index ?? 0, m[0]);
  for (const m of text.matchAll(HANDLE)) add('username', m.index ?? 0, m[0]);
  for (const m of text.matchAll(PHONE)) if (isPhone(m[0])) add('phone number', m.index ?? 0, m[0]);
  return out.sort((a, b) => a.start - b.start);
}

/** Replaces every identifier in `text` with a placeholder ("[email address]"). */
function withoutIdentifiers(text: string): string {
  let out = text;
  for (const id of identifiers(text).reverse()) out = out.slice(0, id.start) + PLACEHOLDER[id.kind] + out.slice(id.end);
  return out;
}

/**
 * Whole-word, case-insensitive search ("two" is not found inside "network"); any whitespace matches a space, and any
 * apostrophe or dash matches any other (Gemini Nano returns "Anna's team" for "Anna’s team").
 */
function phraseRe(phrase: string, flags = 'i'): RegExp {
  const p = phrase.trim();
  const body = escapeRe(p)
    .replace(/\s+/g, '\\s+')
    .replace(/['’‘ʼ]/g, "['’‘ʼ]")
    .replace(/[-‐‑–—]/g, '[-‐‑–—]');
  return new RegExp(`${/^\w/.test(p) ? '(?<!\\w)' : ''}${body}${/\w$/.test(p) ? '(?!\\w)' : ''}`, flags);
}
export const hasPhrase = (text: string, phrase: string) => typeof phrase === 'string' && phrase.trim() !== '' && phraseRe(phrase).test(text);

/** A capitalised word that also appears capitalised mid-sentence ("Lisbon", "Zürich"), not one that only starts a sentence ("The"). */
const isProperNoun = (word: string, text: string) => new RegExp(`[^.!?\\s]\\s+${escapeRe(word)}(?![\\p{L}\\p{M}\\p{N}_])`, 'u').test(text);
/** Capitalised words, accented ones too ("São", "Łódź"). */
const CAPITALISED = /(?<![\p{L}\p{M}\p{N}_])\p{Lu}[\p{L}\p{M}]+/gu;
const nextWord = (rest: string) => rest.match(/^\s+([A-Za-z][\w'’-]*)/)?.[1];
/** A lowercase content word after a date or a name means it was a modifier: "the March reorg", "a Figma migration". */
const isContentWord = (w: string | undefined) => !!w && /^[a-z]/.test(w) && !FUNCTION_WORDS.has(w);

/** "1.2.3", "10.0.1": a version, not a count. "1.234.567" (thousands) is a count. */
const isVersion = (t: string) => /^\d+(?:[.,]\d+){2,}$/.test(t) && !/^\d{1,3}([.,])\d{3}(?:\1\d{3})*$/.test(t);

function numberValue(token: string): number {
  if (/^\d/.test(token)) return Number(token.replace(/,/g, ''));
  let total = 0;
  let current = 0;
  for (const w of token.toLowerCase().split(/[\s-]+/)) {
    const v = NUM_VALUE[w];
    if (v === undefined) continue; // "and"
    if (v === 100) current = (current || 1) * 100;
    else if (v >= 1000) {
      total += (current || 1) * v;
      current = 0;
    } else current += v;
  }
  return total + current;
}

/** "two" → "a few", "six" → "several", "200" → "many". The word "one" stays: on its own it rarely identifies anyone. */
function vagueNumber(token: string): string | null {
  const n = numberValue(token);
  if (n === 1) return /^\d/.test(token) ? 'one' : null;
  if (n === 0) return 'no';
  return n <= 2 ? 'a few' : n < 20 ? 'several' : 'many';
}

const timeUnit = (t: string) =>
  new RegExp(`\\b(${MONTH})\\b`, 'i').test(t) ? 'month' : /\b(19|20)\d{2}\b/.test(t) ? 'year' : /^Q/i.test(t) ? 'quarter' : 'day';

/** The generic version of one occurrence of a detail. `after` is the text that follows it in the document. */
function generalisePhrase(span: string, after: string, text: string): { g: string; properNounOnly: boolean } {
  let pn = false;
  const g = withoutIdentifiers(span)
    // Dates. As a modifier they just go ("the March reorg" → "the reorg"); otherwise they become vague.
    .replace(new RegExp(`\\bevery\\s+(?:${WEEKDAY})\\b`, 'gi'), 'every week')
    .replace(new RegExp(`\\bevery\\s+(?:${MONTH})\\b`, 'gi'), 'every year')
    .replace(new RegExp(`\\b(?:on\\s+)?(?:${WEEKDAY})s\\b`, 'gi'), 'every week')
    .replace(
      new RegExp(`(?:\\b(${TIME_PREP})\\s+|\\b(mid)-)?(the\\s+)?\\b(${TIME})\\b`, 'gi'),
      (m: string, prep: string | undefined, mid: string | undefined, the: string | undefined, time: string, offset: number, str: string) => {
        const rest = str.slice(offset + m.length) || after;
        const keep = `${prep ? `${prep} ` : ''}${the ?? ''}`;
        if (/^['’]s\b/.test(rest)) return `${keep}that ${timeUnit(time)}`; // "Monday's meeting" → "that day's meeting"
        // A modifier only without a preposition, or after "the": "the March reorg" → "the reorg", but
        // "on 14 February cut jobs" → "recently cut jobs" (probe, 16-nov: it became "on cut jobs").
        if (!mid && (the || !prep) && isContentWord(nextWord(rest))) return keep;
        const p = prep?.toLowerCase();
        if (p === 'of') return `of that ${timeUnit(time)}`; // "the end of March" → "the end of that month"
        if (p === 'since') return 'for a while';
        return /\b(19|20)\d{2}\b/.test(time) ? 'at some point' : 'recently';
      },
    )
    // Numbers. Codes and versions ("COVID-19", "24/7", "v2") are left alone: they are not counts.
    .replace(new RegExp(`\\b(${NUM})-(year|month|week|day|hour|person|people|member)s?\\b`, 'gi'), (m: string, n: string, unit: string) =>
      numberValue(n) === 1 ? m : `multi-${unit}`,
    )
    .replace(new RegExp(`\\b(?:${NUM})\\s?(?:%|percent\\b|per\\s+cent\\b)`, 'gi'), 'a portion')
    .replace(/[$€£]\s?\d+(?:[.,]\d+)*\s?(?:k|m|bn|million|billion|thousand)?\b/gi, 'an amount')
    .replace(new RegExp(`\\b(?:${NUM})\\s?(?:k|m|bn|million|billion|thousand)?\\s+(?:dollars|euros|pounds)\\b`, 'gi'), 'an amount')
    .replace(/\b(?:one|1)\s+(year|month|week|day|hour|decade)\b/gi, (_m: string, unit: string) => `about ${/^h/i.test(unit) ? 'an' : 'a'} ${unit}`)
    .replace(/\ba\s+(dozen|hundred|thousand)\b/gi, (_m: string, w: string) => (w.toLowerCase() === 'dozen' ? 'several' : 'many'))
    .replace(new RegExp(`(?<![\\w\\-/.])(${NUM})(k)?(?![\\w\\-/])`, 'gi'), (m: string, n: string, k: string | undefined) =>
      isVersion(n) ? m : k ? 'many' : (vagueNumber(n) ?? m),
    )
    // Proper nouns: "the Lisbon office" → "the office", "Anna's team" → "the team", accented ones too ("São Paulo").
    .replace(/(?<![\p{L}\p{M}\p{N}_])(\p{Lu}[\p{L}\p{M}]+)(['’]s)?(?![\p{L}\p{M}\p{N}_'’-])/gu, (m: string, word: string, poss: string | undefined, offset: number, str: string) => {
      if (!isProperNoun(word, text)) return m;
      pn = true;
      if (!poss) return '';
      return /^\s+[A-Za-z]/.test(str.slice(offset + m.length) || after) ? 'the' : `someone${poss}`;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
  const onlyFunctionWords = g.split(/\s+/).every((w) => !w || FUNCTION_WORDS.has(w.toLowerCase()));
  return { g, properNounOnly: pn && onlyFunctionWords };
}

/** A count with the word it counts: "six individuals", "6 people", or the number alone ("to 2"). One is skipped. */
const COUNT = new RegExp(`(?<![\\w\\-/.])(${NUM})(?![\\w\\-/])(?:\\s+([a-z][a-z-]*))?`, 'gi');
/** A range: "6 people to 2", "6 to 2 people", "fourteen to nine" (the words checked by the caller). */
const RANGE = new RegExp(`(?<![\\w\\-/.])(${NUM})(?:\\s+([a-z][a-z-]*))?\\s+to\\s+(${NUM})(?![\\w\\-/])(?:\\s+([a-z][a-z-]*))?`, 'gi');
function countPhrase(m: RegExpMatchArray): string | null {
  if (numberValue(m[1]) === 1 || isVersion(m[1])) return null;
  return m[2] && !FUNCTION_WORDS.has(m[2].toLowerCase()) ? `${m[1]} ${m[2]}` : m[1];
}

/**
 * Counts and dates in a draft, found without a model: fixed rules generalise them all, whether or not the local model
 * flags them. Measured live (16-nov, public URL): Gemini Nano did not flag "6 people to 2" in one run, and the final
 * text still said "six individuals" while the app called it safe. "one" alone is not a count worth hiding; "one year" is.
 */
export function ruleDetails(text: string): { phrase: string; why: string }[] {
  const found: { phrase: string; why: string; start: number; end: number }[] = [];
  const free = (start: number, end: number) => !found.some((f) => start < f.end && end > f.start);
  const push = (m: RegExpMatchArray, phrase: string, why: string) => {
    const start = m.index ?? 0;
    if (free(start, start + phrase.length) && !found.some((f) => f.phrase.toLowerCase() === phrase.toLowerCase())) {
      found.push({ phrase, why, start, end: start + phrase.length });
    }
  };
  const WHY: Record<IdentifierKind, string> = {
    link: 'A link: fixed rule, no AI.',
    'email address': 'An email address: fixed rule, no AI.',
    username: 'A username: fixed rule, no AI.',
    'phone number': 'A phone number: fixed rule, no AI.',
  };
  for (const id of identifiers(text)) {
    if (free(id.start, id.end)) found.push({ phrase: id.phrase, why: WHY[id.kind], start: id.start, end: id.end });
  }
  for (const m of text.matchAll(new RegExp(`\\b(?:${TIME})\\b`, 'gi'))) push(m, m[0], 'A date: fixed rule, no AI.');
  for (const m of text.matchAll(/\bone\s+(?:year|month|week|day|hour|decade)\b/gi)) push(m, m[0], 'A count: fixed rule, no AI.');
  // A range with the word it counts is one detail: "6 people to 2" generalises to "several people to a few", while in two
  // parts the bare "2" is left (a judge, 17-nov). A range of bare numbers ("fourteen to nine") stays in parts.
  for (const m of text.matchAll(RANGE)) {
    const [whole, n1, w1, n2, w2] = m;
    if (numberValue(n1) === 1 || numberValue(n2) === 1) continue;
    const noun = (w?: string) => !!w && !FUNCTION_WORDS.has(w.toLowerCase());
    if (w1 && !noun(w1)) continue;
    if (!noun(w1) && !noun(w2)) continue;
    push(m, noun(w2) ? whole : whole.slice(0, whole.length - (w2 ? w2.length : 0)).trimEnd(), 'A count: fixed rule, no AI.');
  }
  for (const m of text.matchAll(COUNT)) {
    const phrase = countPhrase(m);
    if (phrase) push(m, phrase, 'A count: fixed rule, no AI.');
  }
  return found.map(({ phrase, why }) => ({ phrase, why }));
}

/**
 * The rule-found details the fixed rules may generalise in a person's own edit, where no model smooths the result: counts
 * with the word they count, and dates. A bare number carries no meaning the rules can keep ("11 of them under 21" became
 * "several of them under many" for a tester, 17-nov), so it stays listed for the person to change.
 */
export const generalisableByHand = (phrases: string[]) => phrases.filter((p) => !BARE_NUMBER.test(p.trim()) || A_DATE.test(p.trim()));
// A number on its own, in digits or words ("46", "fourteen": "from fourteen to nine" became "from several to several"), but
// not a year, which is a date.
const BARE_NUMBER = new RegExp(`^(?:${NUM})$`, 'i');
const A_DATE = new RegExp(`^(?:${TIME})$`, 'i');

/**
 * Names used before a noun ("the Lisbon office", "a Figma migration", "our Brindley Road store"): the fixed rules drop them
 * cleanly ("the office", "a migration"), so a person's own edit can have them generalised too. A name on its own ("Dave",
 * "at Kelly") stays with the person: "shouted at Kelly" would become "shouted somewhere". Every use must be before a noun.
 */
export function modifierNames(text: string, names: string[]): string[] {
  return names.filter((n) => {
    const uses = [...text.matchAll(new RegExp(`(?<![\\p{L}\\p{M}\\p{N}_])${escapeRe(n)}(?![\\p{L}\\p{M}\\p{N}_'’-])`, 'gu'))];
    return uses.length > 0 && uses.every((m) => isContentWord(nextWord(text.slice((m.index ?? 0) + m[0].length))));
  });
}

/** Capitalised words that are not names: roles, departments and everyday abbreviations. */
const NOT_NAMES = new Set(['OK', 'AI', 'TV', 'PC', 'FYI', 'ASAP', 'CEO', 'CFO', 'CTO', 'COO', 'HR', 'IT', 'PR', 'PS']);
const DATE_WORD = new RegExp(`^(?:${MONTH}|${WEEKDAY})$`);

/**
 * Capitalised words in the middle of a sentence ("Dave", "Kelly", "the Lisbon office"): without a local model, the only
 * pointer to names, places and companies. Two test users' names and towns went unflagged without Gemini Nano (17-nov).
 * Flagged for the user to change, not generalised: the fixed rules would turn "shouted at Kelly" into "shouted somewhere".
 * A guess, and said as one: it also flags "English" or "Easter", and misses a name that only ever opens a sentence.
 */
export function nameDetails(text: string): { phrase: string; why: string }[] {
  const out: { phrase: string; why: string }[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{M}\p{N}_])\p{Lu}[\p{L}\p{M}]+(?:\s+\p{Lu}[\p{L}\p{M}]+)*/gu)) {
    // A run of capitalised words is one name ("Forn Pastisseria"); the word that opens a sentence is not part of it.
    const phrase = m[0]
      .split(/\s+/)
      .filter((w) => !NOT_NAMES.has(w) && !DATE_WORD.test(w) && isProperNoun(w, text))
      .join(' ');
    if (phrase && !out.some((o) => o.phrase.toLowerCase() === phrase.toLowerCase())) {
      out.push({ phrase, why: 'Capital letter: maybe a name, place or company. Fixed rule, no AI.' });
    }
  }
  return out;
}

/**
 * Specific tokens in `text` (numbers, dates, proper nouns) that do not occur in `source`: things a model added.
 * A count is compared with the word it counts, so "six individuals" is new even if the source said "six months".
 * Deterministic, so a rewrite is checked without asking a model.
 */
export function newSpecifics(text: string, source: string): string[] {
  const found = new Set<string>();
  const add = (s: string) => {
    const p = s.trim();
    if (p && !hasPhrase(source, p)) found.add(p);
  };
  const ids = identifiers(text);
  for (const id of ids) add(id.phrase);
  // Numbers, dates and names inside a link or an address are part of it, not details of their own.
  const rest = ids.reduceRight((t, id) => t.slice(0, id.start) + ' '.repeat(id.end - id.start) + t.slice(id.end), text);
  for (const m of rest.matchAll(new RegExp(`\\b(?:${TIME})\\b`, 'gi'))) add(m[0]);
  for (const m of rest.matchAll(COUNT)) {
    const phrase = countPhrase(m);
    if (phrase) add(phrase);
  }
  for (const m of rest.matchAll(/(?<![\p{L}\p{M}\p{N}_])\p{Lu}[\p{L}\p{M}]+(?:\s+\p{Lu}[\p{L}\p{M}]+)*/gu)) {
    const names = m[0].split(/\s+/).filter((w) => isProperNoun(w, rest));
    if (names.length) add(names.join(' '));
  }
  return [...found];
}

/**
 * Fixed rules that generalise the details the local model found, before the model rewrites anything (measured live,
 * 16-nov: Gemini Nano kept the details, or copied our prompt's examples into the text). It removes exactly what makes
 * a detail specific and keeps the rest:
 *   "three years" → "several years" · "implemented in March" → "implemented recently" · "the Lisbon office" → "the office".
 * Not elegant prose, but predictable, testable, and it always converges. The small model decides WHAT identifies you;
 * this code makes sure it is gone.
 */
export function deterministicGeneralise(text: string, phrases: string[]): { text: string; done: { phrase: string; generic: string }[] } {
  let out = text;
  const done: { phrase: string; generic: string }[] = [];
  const unique = [...new Set(phrases.map((p) => p.trim()).filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const phrase of unique) {
    const re = phraseRe(phrase, 'gi');
    let from = 0;
    for (let guard = 0; guard < 20; guard++) {
      re.lastIndex = from;
      const m = re.exec(out);
      if (!m) break;
      const original = m[0];
      const end = m.index + original.length;
      let start = m.index;
      let before = out.slice(0, start);
      let after = out.slice(end);

      // A date takes its preposition with it: "implemented in March" → "implemented recently".
      if (new RegExp(`^(?:the\\s+)?\\b(?:${TIME})\\b`, 'i').test(original)) {
        start -= before.match(new RegExp(`\\b(?:${TIME_PREP})\\s+$|\\bmid-$`, 'i'))?.[0].length ?? 0;
        before = out.slice(0, start);
      }
      const r = generalisePhrase(out.slice(start, end), after, text);
      if (r.g === out.slice(start, end)) {
        from = end; // nothing the rules can do ("24/7", "COVID-19"): it stays, and stays reported
        continue;
      }
      let g = r.g;
      if (r.properNounOnly) {
        // Only a name was there. After an article it is a modifier and just goes ("a Figma migration" → "a migration");
        // a place at the end of a clause becomes "somewhere" ("based in Lisbon." → "based somewhere."); anything else
        // is redacted ("at Google shipped" → "at [redacted] shipped", probe 16-nov: it became "at shipped").
        const prev = before.match(/([A-Za-z]+)\s+$/)?.[1]?.toLowerCase() ?? '';
        const nextContent = isContentWord(nextWord(after));
        if (nextContent && (DETERMINERS.has(prev) || /^the$/i.test(g))) {
          // keep g ("" or "the")
        } else if (!nextContent && /^(?:in|at|near|inside)(?:\s+the)?$/i.test(g)) g = 'somewhere';
        else {
          const place = !nextContent && (!g || /^the$/i.test(g)) ? before.match(/\b(?:in|at|near|inside)\s+(?:the\s+)?$/i) : null;
          if (place) {
            start -= place[0].length;
            before = out.slice(0, start);
            g = 'somewhere';
          } else g = g ? `${g} [redacted]` : '[redacted]';
        }
      }

      // Articles: "an" before a vowel, and no "a" before "several" or before another article.
      const art = before.match(/\b([Aa])n?\s+$/);
      if (art) {
        const head = before.slice(0, before.length - art[0].length);
        before = /^(?:a|an|the|several|many|no|some)\b/i.test(g) ? head : `${head}${art[1]}${/^[aeiou]/i.test(g || after.trimStart()) ? 'n' : ''} `;
      }
      const generic = g;
      if (/(?:^|[.!?]["')\]]?\s+)$/.test(before)) {
        if (g) g = g[0].toUpperCase() + g.slice(1);
        else after = after.replace(/^\s*([a-z])/, (_x: string, c: string) => c.toUpperCase());
      }

      out = before + g + after;
      if (!done.some((d) => d.phrase.toLowerCase() === original.toLowerCase())) done.push({ phrase: original, generic });
      from = before.length + g.length;
    }
  }
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/([,;:])(?:[ \t]*[,;:])+/g, '$1');
  return { text: out, done };
}

const MEANING_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: { type: 'object', properties: { claim: { type: 'string' }, kept: { type: 'boolean' } }, required: ['claim', 'kept'] },
    },
  },
  required: ['claims'],
};

const MONTHS = /\b(january|february|march|april|june|july|august|september|october|november|december)\b/i; // "may" is usually a verb
const WEEKDAYS = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
// "one" alone is not a count worth hiding ("one of the offices" is our own generic wording); "one year" is.
const NUMBER_WORDS = new RegExp(`\\b(${Object.keys(NUM_VALUE).filter((w) => w !== 'one').join('|')})\\b`, 'i');
const ONE_UNIT = /\bone\s+(year|month|week|day|hour|decade)\b/i;

/**
 * Deterministic: is a flagged phrase SPECIFIC (a number, a date, a proper noun) rather than generic wording?
 * Measured live: re-checking a rewrite, Gemini Nano also flags "team", "transition" or "design roles"; chasing those
 * degraded the text and never converged. A proper noun is a capitalised word that also appears capitalised
 * mid-sentence in the text (so "My" or "The" at the start of a sentence do not count).
 */
export function isSpecific(phrase: string, text: string): boolean {
  if (/\d/.test(phrase) || NUMBER_WORDS.test(phrase) || ONE_UNIT.test(phrase) || MONTHS.test(phrase) || WEEKDAYS.test(phrase)) return true;
  if (identifiers(phrase).length) return true; // "marta@acme.pt", "@marta_designs", "marta.design"
  for (const m of phrase.matchAll(CAPITALISED)) if (isProperNoun(m[0], text)) return true;
  return false;
}

const attackSchema = (letters: string[]): JsonSchema => ({
  type: 'object',
  properties: {
    pick: { type: 'string', enum: letters },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasons: { type: 'array', items: { type: 'string' } },
  },
  required: ['pick', 'confidence', 'reasons'],
});
import { exposure, singular, styleMarkers, tokenize, type Candidate, type Marker } from '../engine/stylometry';
import { canonicalLetters } from '../framework/guard';

/**
 * The phrases an attacker's reason quotes that are not in the text it attacked. It sometimes cites a decoy's words or
 * invents them ('organisation' for a text that says "organization", in the recorded run). Compared on the letters only:
 * case, accents and punctuation aside. Apostrophes inside words ("Writer C's") are not quotes.
 */
export function quotesNotIn(reason: string, text: string): string[] {
  const quoted = [
    ...reason.matchAll(/[“"‘]([^”"’]{2,80})[”"’]/g),
    ...reason.matchAll(/(?:^|[\s([{,;:])'([^']{2,80})'(?=[\s.,;:!?)\]}]|$)/g),
  ]
    .map((m) => m[1].trim())
    .filter(Boolean);
  const haystack = canonicalLetters(text);
  return [...new Set(quoted)].filter((q) => {
    const needle = canonicalLetters(q);
    return needle.length > 0 && !haystack.includes(needle);
  });
}

/** Field words that also name habits of style ("a close match", "sentence flow", "a clinical tone", "type-token ratio"…). */
const STYLE_SENSES = new Set(['flow', 'visual', 'creative', 'layout', 'persona', 'ratio', 'token', 'clinical', 'close', 'term', 'delivery', 'risk', 'agency']);

/**
 * Whether a reason is about what the text says rather than how it is written ("Mentions retail/store management
 * context", "Focus on employee morale"), or names a word of a field (`fieldWords`, singular) that the attacked text uses:
 * "shares the exact same cafe/rota narrative details" found a café worker 10/10 among finance writers, and the phrases
 * alone missed it (17-nov). When the attacker finds the user by subject, the decoys may be from another field, and no
 * rewrite of the style can fix that (a test user went from 7/10 to 8/10 after rewriting, 17-nov).
 */
export function aboutSubject(reason: string, fieldWords?: ReadonlySet<string>, attacked = ''): boolean {
  if (/\b(topics?|subject(?: matter)?|themes?|industry|sector|domain|context|focus(?:es|ed)? on|mentions?|discuss(?:es|ing)?|talks? about|writes? about)\b/i.test(reason)) return true;
  if (!fieldWords || !attacked) return false;
  const inText = new Set(tokenize(attacked).map(singular));
  return tokenize(reason)
    .map(singular)
    .some((w) => fieldWords.has(w) && !STYLE_SENSES.has(w) && inText.has(w));
}

export interface Clue {
  phrase: string;
  kind: 'style' | 'content';
  why: string;
}

export interface AuthorshipVerdict {
  picks: string[]; // candidate id per attempt ('none' when the cloud gave no usable answer)
  hits: number;
  attempts: number;
  /** Attempts that got a usable answer. Scoring is a rate over these, never an absolute count. */
  answered: number;
  reasons: string[];
  /** Whom the reasons are about: the pick of the last attempt that gave reasons ('none' if there were none). */
  reasonsPick?: string;
  /**
   * The lineup of that attempt, by letter (candidate ids): the reasons say "Writer H" in the attempt's own shuffle, while
   * the screen seats every writer at a fixed letter. A reason named the user "Writer H" while the user sat at C (17-nov).
   */
  reasonsOrder?: string[];
}

/** Below this many answers the lineup result is not meaningful. */
export const MIN_ANSWERS = 5;

export interface RewriteInfo {
  /** Meaning check, on the device: each claim of the original (in generic words) and whether the final text keeps it. */
  claims: { claim: string; kept: boolean }[];
  /** Specific details generalised on the device after the rewrite (Nano tends to keep them). */
  generalised: { phrase: string; generic: string; by: 'nano' | 'rule' }[];
  /** Identifying details a fresh on-device check still finds in the final text. Not safe to publish while non-empty. */
  detailsLeft: { phrase: string; why: string }[];
  /** 'failed': the meaning check gave no readable answer, so `claims` is empty and the user must read the text. */
  meaningCheck?: 'done' | 'failed';
}

/** The rewrite in Nano's answer ({"rewrite": "..."} or the bare string), or '' if there is none. */
function readRewrite(answer: string): string {
  try {
    const parsed = parseModelJson<unknown>(answer);
    const v = typeof parsed === 'string' ? parsed : parsed && typeof parsed === 'object' ? (parsed as { rewrite?: unknown }).rewrite : '';
    return typeof v === 'string' ? v.trim() : '';
  } catch (e) {
    if (e instanceof ModelJsonError) return '';
    throw e;
  }
}

/** The meaning check's claims, keeping only complete ones: a claim in words, and kept true or false. */
function readClaims(answer: string): RewriteInfo['claims'] {
  return listAt(parseModelJsonLenient(answer).value, 'claims').flatMap((c) => {
    const { claim, kept } = (c && typeof c === 'object' ? c : {}) as { claim?: unknown; kept?: unknown };
    const k = kept === true || kept === 'true' ? true : kept === false || kept === 'false' ? false : null;
    return typeof claim === 'string' && claim.trim() && k !== null ? [{ claim: claim.trim(), kept: k }] : [];
  });
}

export interface AuthorshipOptions {
  selfId: string;
  /** The user's own public writing (already public: their blog, their main account). */
  self: Public<string>;
  /** Public decoy writers. */
  decoys: { id: string; text: Public<string> }[];
  attempts?: number;
  /** Exposed if the attacker picks the user more often than this many times out of `attempts`. */
  maxHits?: number;
  /** Called after each attack attempt, for live UI. */
  onAttempt?: (pickId: string, i: number) => void;
}

const LETTERS = 'ABCDEFGHIJKLMNOP';

/**
 * Fisher–Yates with crypto randomness. `sort(() => Math.random() - 0.5)` is biased: items stay near where they started,
 * and the user is first in the list, where language models' position bias already favours a pick.
 */
export function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  const r = new Uint32Array(out.length);
  globalThis.crypto.getRandomValues(r);
  for (let i = out.length - 1; i > 0; i--) {
    const j = r[i] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** "C", "c", "Writer C", "(C)", "C." → 2. Anything else → -1. */
export function letterIndex(pick: unknown): number {
  const m = String(pick ?? '').trim().toUpperCase().match(/^(?:WRITER\s+)?\(?([A-P])\)?[.:]?$/);
  return m ? LETTERS.indexOf(m[1]) : -1;
}

/**
 * Deterministic: did the model decline, or drop most of the post? A refusal released as "the rewrite" would be attacked,
 * score 0/10 and look safe. Short drafts are not judged by length.
 */
export function looksLikeRefusal(next: string, prev: string): boolean {
  const n = next.trim();
  if (/^(?:i['’]?m sorry|sorry[,!.]|i (?:can(?:no|['’])t|cannot|am (?:not able|unable)|won['’]t)|as an ai\b|i['’]m (?:not able|unable))/i.test(n)) return true;
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  return words(prev) >= 30 && words(n) < 0.2 * words(prev);
}

/** What fits in one Gemini Nano prompt with room to spare (the meaning check holds the post twice). */
export const MAX_DRAFT_WORDS = 1500;
const MAX_DRAFT_CHARS = 10_000; // scripts without spaces (Chinese, Japanese) are counted by characters

function assertFitsOnDevice(draft: string) {
  const words = draft.split(/\s+/).filter(Boolean).length;
  if (words > MAX_DRAFT_WORDS || draft.length > MAX_DRAFT_CHARS) {
    throw new Error(`This post is too long for Gemini Nano on this device (${words.toLocaleString('en-US')} words; up to ${MAX_DRAFT_WORDS.toLocaleString('en-US')} fit). Check it in parts`);
  }
}

const hasWords = (s: string) => /[\p{L}\p{N}]/u.test(s);

/** At most `max` characters, cut at a word boundary (never mid-word or inside a surrogate pair). */
export function sample(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const at = cut.search(/\s\S*$/);
  return (at > max * 0.6 ? cut.slice(0, at) : Array.from(text).slice(0, max).join('')).trimEnd();
}

export function authorshipThreat(o: AuthorshipOptions): Threat<string, Clue, AuthorshipVerdict> & {
  lastRewrite: RewriteInfo | null;
  fingerprint(text: string): ReturnType<typeof exposure>;
  inconclusive(v: AuthorshipVerdict): boolean;
} {
  const attempts = o.attempts ?? 10;
  const maxHits = o.maxHits ?? 2;
  const lineup: Candidate[] = [
    { id: o.selfId, label: 'self', corpus: o.self.value },
    ...o.decoys.map((d) => ({ id: d.id, label: 'decoy', corpus: d.text.value })),
  ];

  /**
   * On-device: identifying details (dates, places, team sizes, project names, tenure) in a text. Nano's answer is data, not
   * trusted structure: anything that is not a phrase of the text is dropped, and an unreadable answer gets one more try
   * (it does not answer the same way twice). `readable: false` means the fixed rules are all there is.
   */
  async function detectDetails(text: string | Private<string>, kit: Kit, op: string) {
    const plain = typeof text === 'string' ? text : Private.openLocally(text);
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await kit.local.generate(
        [
          'List details in this text that could identify its author: exact dates, places, team sizes, internal project names, tenure. ' +
            'Return JSON {"details":[{"phrase":"exact substring","why":"short reason"}]}.\n\nTEXT:\n',
          text,
        ],
        { json: true, schema: DETAILS_SCHEMA, op: attempt ? `${op} (again: unreadable answer)` : op },
      );
      let parsed: unknown;
      try {
        parsed = parseModelJsonLenient(res.text).value;
      } catch (e) {
        if (e instanceof ModelJsonError) continue;
        throw e;
      }
      const seen = new Set<string>();
      const details = listAt(parsed, 'details').flatMap((d) => {
        const item = (typeof d === 'string' ? { phrase: d } : d && typeof d === 'object' ? d : {}) as { phrase?: unknown; why?: unknown };
        const phrase = typeof item.phrase === 'string' ? item.phrase.trim() : '';
        const why = typeof item.why === 'string' && item.why.trim() ? item.why.trim() : 'Flagged by Gemini Nano.';
        // Keep only phrases that really occur in the text (small models sometimes paraphrase) and that are specific.
        if (!phrase || seen.has(phrase.toLowerCase()) || !hasPhrase(plain, phrase) || !isSpecific(phrase, plain)) return [];
        seen.add(phrase.toLowerCase());
        return [{ phrase, why }];
      });
      return { details, readable: true };
    }
    return { details: [] as { phrase: string; why: string }[], readable: false };
  }

  const threat = {
    id: 'authorship',
    question: 'Who wrote this?',
    lastRewrite: null as RewriteInfo | null,

    /** Deterministic, local, no model: Burrows' Delta rank of the user in the lineup. */
    fingerprint(text: string) {
      return exposure(text, lineup, o.selfId);
    },

    async findClues(input: Private<string>, kit: Kit): Promise<Clue[]> {
      const draft = Private.openLocally(input); // plain JS on the device
      assertFitsOnDevice(draft);
      const t0 = performance.now();
      const style: Marker[] = styleMarkers(draft, o.self.value, o.decoys.map((d) => d.text.value));
      kit.ledger.add({ op: 'Fingerprint (Burrows’ Delta)', route: 'local-js', ms: Math.round(performance.now() - t0), bytesOut: 0 });
      // An empty post has nothing for the model to read.
      const scan = hasWords(draft) ? await detectDetails(input, kit, 'Find identifying details') : { details: [], readable: true };
      const details = scan.details;
      const t1 = performance.now();
      const extra = notCovered(ruleDetails(draft), details);
      kit.ledger.add({
        op: 'Find counts and dates (fixed rules)',
        route: 'local-js',
        ms: Math.round(performance.now() - t1),
        bytesOut: 0,
        note: scan.readable ? `no model · found ${extra.length} that Nano missed` : `no model · Nano's answer was unreadable, the rules found ${extra.length}`,
      });
      return [
        ...style.map((m) => ({ phrase: m.phrase, kind: 'style' as const, why: m.why })),
        ...[...details, ...extra].map((d) => ({ ...d, kind: 'content' as const })),
      ];
    },

    async sanitize(input: Private<string>, clues: Clue[], feedback: AuthorshipVerdict | null, kit: Kit): Promise<Publishable<string>> {
      // Measured live (16-nov), letting Gemini Nano generalise the details failed five ways:
      //  1. its rewrite removed the style but kept "Lisbon office", "three years", "Figma migration";
      //  2. pasted phrase-by-phrase replacements broke the grammar ("the most recent a period");
      //  3. a whole-text rewrite copied a placeholder from our prompt ("what you wrote instead") seven times;
      //  4. sentence by sentence, it kept all five details;
      //  5. when it did generalise them, it copied our prompt's examples into the wrong sentences ("This was an internal
      //     project involving a much smaller team"), garbled a claim, and its own meaning check passed it.
      // So the details never reach the model: fixed rules generalise them in the draft first, the model only rewrites
      // the style, and a deterministic check (no model) verifies the final text.
      const draft = Private.openLocally(input); // plain JS on the device
      if (!hasWords(draft)) throw new Error('There is nothing to rewrite: the post is empty');
      assertFitsOnDevice(draft);
      const flagged = clues.filter((c) => c.kind === 'content');
      // Every count and date goes too, flagged or not (see ruleDetails).
      const details = [...flagged, ...notCovered(ruleDetails(draft), flagged)];
      const t0 = performance.now();
      const ruled = deterministicGeneralise(draft, details.map((d) => d.phrase));
      const generalised: RewriteInfo['generalised'] = ruled.done.map((d) => ({ ...d, by: 'rule' as const }));
      if (ruled.done.length) {
        kit.ledger.add({ op: `Fixed rules generalised ${count(ruled.done.length, 'detail')}`, route: 'local-js', ms: Math.round(performance.now() - t0), bytesOut: 0, note: 'no model' });
      }
      // What the rules cannot rewrite (codes such as "24/7") is left to the model, and stays reported if it remains.
      const unhandled = details.filter((d) => hasPhrase(ruled.text, d.phrase));

      const habits = clues.filter((c) => c.kind === 'style').map((c) => c.phrase);
      const prompt =
        'Rewrite the DRAFT so its author cannot be identified by writing style. ' +
        (habits.length ? `Remove these habits: ${habits.join(', ')}. ` : '') +
        (unhandled.length ? `Generalise these details: ${unhandled.map((d) => d.phrase).join(', ')}. ` : '') +
        (feedback?.reasons.length ? `An attacker still recognised the author because: ${feedback.reasons.join('; ')}. ` : '') +
        'Keep every claim and opinion. Do not add names, places, dates or numbers. Use a neutral, plain register. ' +
        'Return JSON {"rewrite":"..."}.\n\nDRAFT:\n';
      const ruledDraft = secret(ruled.text, 'draft, details generalised');
      // Gemini Nano does not answer the same way twice: an unreadable, looping or refused rewrite gets one more try.
      let text = '';
      let problem: 'unreadable' | 'repeated' | 'refused' | null = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await kit.local.generate([prompt, ruledDraft], {
          json: true,
          schema: REWRITE_SCHEMA,
          op: attempt ? `Rewrite on-device (again: ${problem} answer)` : 'Rewrite on-device',
        });
        text = readRewrite(res.text);
        problem = !text ? 'unreadable' : looksBroken(text, ruled.text) ? 'repeated' : looksLikeRefusal(text, ruled.text) ? 'refused' : null;
        if (!problem) break;
      }
      // No "run it again" here: the UI's friendlyError already ends every message with "Try again."
      if (problem === 'unreadable') throw new Error('The local model returned no rewrite it could read');
      if (problem === 'repeated') throw new Error('The local model repeated the same phrase over and over');
      if (problem === 'refused') throw new Error('The local model declined, or dropped most of the post');
      for (const d of unhandled) if (!hasPhrase(text, d.phrase)) generalised.push({ phrase: d.phrase, generic: '', by: 'nano' });

      // Deterministic check of the final text, no model: no detail left, and nothing specific that the model added
      // (a number, a date or a name that was not in the draft it saw).
      const t1 = performance.now();
      const added = newSpecifics(text, ruled.text);
      const fix = deterministicGeneralise(text, [...details.map((d) => d.phrase), ...added]);
      text = fix.text;
      const listed = (p: string) => generalised.some((g) => g.phrase.toLowerCase() === p.toLowerCase());
      generalised.push(...fix.done.filter((d) => !listed(d.phrase)).map((d) => ({ ...d, by: 'rule' as const })));
      const left = [
        ...details.filter((d) => hasPhrase(text, d.phrase)).map((d) => ({ phrase: d.phrase, why: d.why })),
        ...added.filter((p) => hasPhrase(text, p)).map((phrase) => ({ phrase, why: 'Added by the rewrite.' })),
      ];
      kit.ledger.add({
        op: 'Check the final text for details',
        route: 'local-js',
        ms: Math.round(performance.now() - t1),
        bytesOut: 0,
        note: added.length ? `no model · generalised ${count(added.length, 'detail')} the rewrite added` : 'no model',
      });

      // Meaning check on the device: the original never leaves; the claims are listed in generic words. It is advice, so
      // a failed check does not throw the finished rewrite away: it says the check is missing.
      let claims: RewriteInfo['claims'] = [];
      let meaningCheck: RewriteInfo['meaningCheck'] = 'done';
      try {
        const m = await kit.local.generate(
          [
            'Compare the ORIGINAL and the FINAL text. List each claim or opinion of the ORIGINAL, in generic words (no names, ' +
              'places or numbers), and whether the FINAL text still makes it. Return JSON {"claims":[{"claim":"...","kept":true}]}.\n\nORIGINAL:\n',
            input,
            '\n\nFINAL:\n',
            text,
          ],
          { json: true, schema: MEANING_SCHEMA, op: 'Meaning check' },
        );
        claims = readClaims(m.text);
      } catch (e) {
        if (e instanceof PrivacyViolation) throw e;
        meaningCheck = 'failed';
        if (e instanceof ModelJsonError) kit.ledger.add({ op: 'Meaning check', route: 'local-js', ms: 0, bytesOut: 0, note: 'unreadable answer · read the final text yourself' });
      }

      threat.lastRewrite = { claims, generalised, detailsLeft: left, meaningCheck };
      // release() refuses the rewrite if it still carries spans of the private draft (about 7–8 words).
      return release(text, 'rewritten on-device');
    },

    async attack(published: Publishable<string>, kit: Kit): Promise<AuthorshipVerdict> {
      const picks: string[] = [];
      let reasons: string[] = [];
      let reasonsPick = 'none';
      let reasonsOrder: string[] = [];
      let answered = 0;
      let lastError: unknown = null;
      let failedInARow = 0;
      for (let i = 0; i < attempts; i++) {
        // The cloud stopped answering (each attempt already retried for up to 45 s): the rest would only make the user
        // wait. Twice in a row before any answer, or three times in a row at any point. The skipped attempts count as no
        // answer, so the verdict stays a rate over the answers and the UI still gets one callback per attempt.
        if (failedInARow >= (answered ? 3 : 2)) {
          for (let k = i; k < attempts; k++) {
            picks.push('none');
            o.onAttempt?.('none', k);
          }
          kit.ledger.add({ op: `Attack attempts ${i + 1}–${attempts} skipped`, route: 'local-js', ms: 0, bytesOut: 0, note: 'the cloud model is not answering' });
          break;
        }
        const order = shuffled(lineup);
        let pickId = 'none';
        try {
          const res = await kit.cloud.generate(
            [
              'You are a forensic stylometry expert. Which writer most likely wrote the ANONYMOUS TEXT? ' +
                'Return JSON {"pick":"<letter>","confidence":"low|medium|high","reasons":["up to 3 short reasons about style"]}.\n\nANONYMOUS TEXT:\n',
              published,
              '\n\nLINEUP:',
              ...order.flatMap((c, k) => [`\n\nWriter ${LETTERS[k]}:\n`, new Public(sample(c.corpus, 900), 'lineup')]),
            ],
            { json: true, schema: attackSchema(order.map((_, k) => LETTERS[k])), op: `Attack attempt ${i + 1} of ${attempts}` },
          );
          // A cut-off answer still says which writer it picked: read what is complete.
          const parsed = parseModelJsonLenient<{ pick?: unknown; reasons?: unknown }>(res.text).value ?? {};
          const k = letterIndex(parsed.pick);
          if (order[k]) {
            pickId = order[k].id;
            answered++;
            failedInARow = 0;
          } else failedInARow++;
          const why = Array.isArray(parsed.reasons) ? parsed.reasons.filter((r): r is string => typeof r === 'string' && r.trim() !== '') : [];
          if (why.length) {
            reasons = why.slice(0, 3);
            reasonsPick = pickId;
            reasonsOrder = order.map((c) => c.id);
          }
        } catch (e) {
          // A privacy block is never swallowed. A busy or broken cloud answer costs one attempt, not the whole attack
          // (the cloud model already wrote it in the ledger, with the bytes it may have sent).
          if (e instanceof PrivacyViolation) throw e;
          lastError = e;
          failedInARow++;
        }
        picks.push(pickId);
        o.onAttempt?.(pickId, i);
      }
      if (answered === 0 && lastError) throw lastError;
      return { picks, hits: picks.filter((p) => p === o.selfId).length, attempts, answered, reasons, reasonsPick, reasonsOrder };
    },

    /** Exposed if the attacker picks the user more often than `maxHits` out of `attempts`, as a rate over the answers. */
    exposed(v: AuthorshipVerdict) {
      const answered = v.answered ?? v.attempts;
      if (answered === 0) return true; // no evidence of safety
      return v.hits / answered > maxHits / v.attempts;
    },

    /** Too few answers to say anything (e.g. the cloud model was overloaded). */
    inconclusive(v: AuthorshipVerdict) {
      return (v.answered ?? v.attempts) < Math.min(MIN_ANSWERS, v.attempts);
    },
  };
  return threat;
}
