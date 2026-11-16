// Threat: "who wrote this?" — stylometric de-anonymisation of a text you want to post anonymously.
// Local: fingerprint (Burrows' Delta), identifying details and rewrite (Gemini Nano).
// Cloud: a lineup attack. The attacker gets the published text and ten PUBLIC writers, shuffled and unlabeled;
// it is never told which one is the user.

import { parseModelJson, PrivacyViolation, Private, Public, release, secret, type JsonSchema, type Kit, type Publishable, type Threat } from '../framework';

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
const TIME_ONE = `(?:${DAY_NUM}\\s+(?:of\\s+)?)?(?:${MONTH})(?:\\s+${DAY_NUM}(?!\\d))?|(?:${WEEKDAY})|(?:19|20)\\d{2}|Q[1-4]`;
/** A date: "March", "3 March", "March 2023", "Monday, March 3", "Q3 2024"… */
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

/** Whole-word, case-insensitive search ("two" is not found inside "network"); any whitespace matches a space. */
function phraseRe(phrase: string, flags = 'i'): RegExp {
  const p = phrase.trim();
  return new RegExp(`${/^\w/.test(p) ? '(?<!\\w)' : ''}${escapeRe(p).replace(/\s+/g, '\\s+')}${/\w$/.test(p) ? '(?!\\w)' : ''}`, flags);
}
export const hasPhrase = (text: string, phrase: string) => phrase.trim() !== '' && phraseRe(phrase).test(text);

/** A capitalised word that also appears capitalised mid-sentence ("Lisbon"), not one that only starts a sentence ("The"). */
const isProperNoun = (word: string, text: string) => new RegExp(`[^.!?\\s]\\s+${word}\\b`).test(text);
const nextWord = (rest: string) => rest.match(/^\s+([A-Za-z][\w'’-]*)/)?.[1];
/** A lowercase content word after a date or a name means it was a modifier: "the March reorg", "a Figma migration". */
const isContentWord = (w: string | undefined) => !!w && /^[a-z]/.test(w) && !FUNCTION_WORDS.has(w);

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
  const g = span
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
      k ? 'many' : (vagueNumber(n) ?? m),
    )
    // Proper nouns: "the Lisbon office" → "the office", "Anna's team" → "the team".
    .replace(/\b([A-Z][a-zA-Z]+)(['’]s)?(?![\w'’-])/g, (m: string, word: string, poss: string | undefined, offset: number, str: string) => {
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

/**
 * Specific tokens in `text` (numbers, dates, proper nouns) that do not occur in `source`: things a model added.
 * Deterministic, so a rewrite is checked without asking a model.
 */
export function newSpecifics(text: string, source: string): string[] {
  const found = new Set<string>();
  const add = (s: string) => {
    const p = s.trim();
    if (p && !hasPhrase(source, p)) found.add(p);
  };
  for (const m of text.matchAll(new RegExp(`\\b(?:${TIME})\\b`, 'gi'))) add(m[0]);
  for (const m of text.matchAll(new RegExp(`(?<![\\w\\-/.])(?:${NUM})(?![\\w\\-/])`, 'gi'))) if (!/^one$/i.test(m[0])) add(m[0]);
  for (const m of text.matchAll(/\b[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*/g)) {
    const names = m[0].split(/\s+/).filter((w) => isProperNoun(w, text));
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
  for (const m of phrase.matchAll(/\b[A-Z][a-zA-Z]+/g)) if (isProperNoun(m[0], text)) return true;
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
import { exposure, styleMarkers, type Candidate, type Marker } from '../engine/stylometry';

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

  /** On-device: identifying details (dates, places, team sizes, project names, tenure) in a text. */
  async function detectDetails(text: string | Private<string>, kit: Kit, op: string) {
    const res = await kit.local.generate(
      [
        'List details in this text that could identify its author: exact dates, places, team sizes, internal project names, tenure. ' +
          'Return JSON {"details":[{"phrase":"exact substring","why":"short reason"}]}.\n\nTEXT:\n',
        text,
      ],
      { json: true, schema: DETAILS_SCHEMA, op },
    );
    const plain = typeof text === 'string' ? text : Private.openLocally(text);
    const found = parseModelJson<{ details?: { phrase: string; why: string }[] }>(res.text).details ?? [];
    // Keep only phrases that really occur in the text (small models sometimes paraphrase) and that are specific.
    return found.filter((d) => d.phrase && hasPhrase(plain, d.phrase) && isSpecific(d.phrase, plain));
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
      const t0 = performance.now();
      const style: Marker[] = styleMarkers(draft, o.self.value, o.decoys.map((d) => d.text.value));
      kit.ledger.add({ op: 'Fingerprint (Burrows’ Delta)', route: 'local-js', ms: Math.round(performance.now() - t0), bytesOut: 0 });
      const details = await detectDetails(input, kit, 'Find identifying details');
      return [
        ...style.map((m) => ({ phrase: m.phrase, kind: 'style' as const, why: m.why })),
        ...details.map((d) => ({ ...d, kind: 'content' as const })),
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
      const details = clues.filter((c) => c.kind === 'content');
      const t0 = performance.now();
      const ruled = deterministicGeneralise(draft, details.map((d) => d.phrase));
      const generalised: RewriteInfo['generalised'] = ruled.done.map((d) => ({ ...d, by: 'rule' as const }));
      if (ruled.done.length) {
        kit.ledger.add({ op: `Fixed rules generalised ${count(ruled.done.length, 'detail')}`, route: 'local-js', ms: Math.round(performance.now() - t0), bytesOut: 0, note: 'no model' });
      }
      // What the rules cannot rewrite (codes such as "24/7") is left to the model, and stays reported if it remains.
      const unhandled = details.filter((d) => hasPhrase(ruled.text, d.phrase));

      const res = await kit.local.generate(
        [
          'Rewrite the DRAFT so its author cannot be identified by writing style. ' +
            `Remove these habits: ${clues.filter((c) => c.kind === 'style').map((c) => c.phrase).join(', ')}. ` +
            (unhandled.length ? `Generalise these details: ${unhandled.map((d) => d.phrase).join(', ')}. ` : '') +
            (feedback?.reasons.length ? `An attacker still recognised the author because: ${feedback.reasons.join('; ')}. ` : '') +
            'Keep every claim and opinion. Do not add names, places, dates or numbers. Use a neutral, plain register. ' +
            'Return JSON {"rewrite":"..."}.\n\nDRAFT:\n',
          secret(ruled.text, 'draft, details generalised'),
        ],
        { json: true, schema: REWRITE_SCHEMA, op: 'Rewrite on-device' },
      );
      const parsed = parseModelJson<{ rewrite?: string }>(res.text);
      if (!parsed.rewrite) throw new Error('The local model returned no rewrite.');
      let text = String(parsed.rewrite).trim();
      if (looksBroken(text, ruled.text)) throw new Error('The local model repeated the same phrase over and over. Run the rewrite again.');
      for (const d of unhandled) if (!hasPhrase(text, d.phrase)) generalised.push({ phrase: d.phrase, generic: '', by: 'nano' });

      // Deterministic check of the final text, no model: no detail left, and nothing specific that the model added
      // (a number, a date or a name that was not in the draft it saw).
      const t1 = performance.now();
      const added = newSpecifics(text, ruled.text);
      const fix = deterministicGeneralise(text, [...details.map((d) => d.phrase), ...added]);
      text = fix.text;
      generalised.push(...fix.done.map((d) => ({ ...d, by: 'rule' as const })));
      const left = [
        ...details.filter((d) => hasPhrase(text, d.phrase)).map((d) => ({ phrase: d.phrase, why: d.why })),
        ...added.filter((p) => hasPhrase(text, p)).map((phrase) => ({ phrase, why: 'Added by the rewrite.' })),
      ];
      kit.ledger.add({
        op: 'Check the final text for details',
        route: 'local-js',
        ms: Math.round(performance.now() - t1),
        bytesOut: 0,
        note: added.length ? `no model · ${count(added.length, 'detail')} added by the rewrite` : 'no model',
      });

      // Meaning check on the device: the original never leaves; the claims are listed in generic words.
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
      const claims = (parseModelJson<{ claims?: { claim: string; kept: boolean }[] }>(m.text).claims ?? []).filter((c) => c.claim && c.claim.trim());

      threat.lastRewrite = { claims, generalised, detailsLeft: left };
      // release() refuses the rewrite if it still contains 8+ word spans of the private draft.
      return release(text, 'rewritten on-device');
    },

    async attack(published: Publishable<string>, kit: Kit): Promise<AuthorshipVerdict> {
      const picks: string[] = [];
      let reasons: string[] = [];
      let answered = 0;
      let lastError: unknown = null;
      for (let i = 0; i < attempts; i++) {
        const order = [...lineup].sort(() => Math.random() - 0.5);
        let pickId = 'none';
        try {
          const res = await kit.cloud.generate(
            [
              'You are a forensic stylometry expert. Which writer most likely wrote the ANONYMOUS TEXT? ' +
                'Return JSON {"pick":"<letter>","confidence":"low|medium|high","reasons":["up to 3 short reasons about style"]}.\n\nANONYMOUS TEXT:\n',
              published,
              '\n\nLINEUP:',
              ...order.flatMap((c, k) => [`\n\nWriter ${LETTERS[k]}:\n`, new Public(c.corpus.slice(0, 900), 'lineup')]),
            ],
            { json: true, schema: attackSchema(order.map((_, k) => LETTERS[k])), op: `Attack ${i + 1}/${attempts}` },
          );
          const parsed = parseModelJson<{ pick?: string; reasons?: string[] }>(res.text);
          const k = LETTERS.indexOf(String(parsed.pick ?? '').trim().toUpperCase().replace(/^WRITER\s+/, ''));
          if (order[k]) {
            pickId = order[k].id;
            answered++;
          }
          if (Array.isArray(parsed.reasons) && parsed.reasons.length) reasons = parsed.reasons;
        } catch (e) {
          // A privacy block is never swallowed. A busy or broken cloud answer costs one attempt, not the whole attack.
          if (e instanceof PrivacyViolation) throw e;
          lastError = e;
          kit.ledger.add({ op: `Attack ${i + 1}/${attempts}`, route: 'cloud', ms: 0, bytesOut: 0, note: 'no answer (model busy)' });
        }
        picks.push(pickId);
        o.onAttempt?.(pickId, i);
      }
      if (answered === 0 && lastError) throw lastError;
      return { picks, hits: picks.filter((p) => p === o.selfId).length, attempts, answered, reasons };
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
