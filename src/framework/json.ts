// Small models often wrap JSON in markdown fences, add a sentence around it, leave a trailing comma, or stop mid-answer.
// Parse defensively, and never put the model's answer in an error message: a local answer can echo the private draft,
// and error messages reach the screen.

export class ModelJsonError extends Error {
  /** The model's raw answer, for debugging only. */
  readonly raw: string;
  constructor(raw: string, message = 'The model did not return valid JSON.') {
    super(message);
    this.name = 'ModelJsonError';
    this.raw = raw;
  }
}

const CLOSE: Record<string, string> = { '{': '}', '[': ']' };

interface Scan {
  /** Index just past the value's closing bracket, or -1 if the text ends first (a cut-off answer) or it is not JSON. */
  end: number;
  /** A closing bracket of the wrong kind: prose such as "{name]", not a value. */
  mismatch: boolean;
  /** Where a cut-off answer can be closed: just past the last complete item, with the brackets still open there. */
  safe: { at: number; open: string[] } | null;
}

/** Walks one JSON value from `start` (a `{` or `[`), respecting strings and escapes. */
function scan(s: string, start: number): Scan {
  const open: string[] = [];
  let safe: Scan['safe'] = null;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') open.push(c);
    else if (c === '}' || c === ']') {
      if (CLOSE[open.pop() ?? ''] !== c) return { end: -1, mismatch: true, safe: null };
      if (!open.length) return { end: i + 1, mismatch: false, safe };
      safe = { at: i + 1, open: [...open] };
    } else if (c === ',' && (open[open.length - 1] === '[' || open.length === 1)) {
      // Between list items, or between the answer's own fields. Not inside an item: half a claim is worse than none.
      safe = { at: i, open: [...open] };
    }
  }
  return { end: -1, mismatch: false, safe };
}

/** Removes commas right before a closing bracket, outside strings: `{"a":1,}`. */
function dropTrailingCommas(s: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      out += c;
      if (c === '\\') out += s[++i] ?? '';
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    if (c === ',' && /^\s*[}\]]/.test(s.slice(i + 1))) continue;
    out += c;
  }
  return out;
}

/** A JSON string that holds JSON (the answer was encoded twice): read the inner value. */
function unwrap(v: unknown): unknown {
  if (typeof v !== 'string' || !/^\s*[[{]/.test(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  for (const candidate of [s, dropTrailingCommas(s), s.replace(/[“”]/g, '"')]) {
    try {
      return { ok: true, value: unwrap(JSON.parse(candidate)) };
    } catch {
      /* next */
    }
  }
  return { ok: false };
}

/** The texts worth trying: fenced blocks first (closed or cut off), then the whole answer. */
function candidates(text: string): string[] {
  const s = text.replace(/^\uFEFF/, '').trim();
  const out: string[] = [];
  for (const m of s.matchAll(/```[a-zA-Z]*\s*([\s\S]*?)```/g)) out.push(m[1].trim());
  const unclosed = s.match(/```[a-zA-Z]*\s*([\s\S]*)$/);
  if (unclosed && !out.length) out.push(unclosed[1].trim());
  out.push(s);
  return out;
}

/**
 * JSON objects or arrays in each candidate, scanned bracket by bracket (prose with braces around them is fine). A value
 * cut off by the end of the text ends the search: what is inside it is part of it, never the answer on its own.
 */
function* values(text: string): Generator<{ text: string; scan: Scan; start: number }> {
  for (const c of candidates(text)) {
    let tries = 0;
    for (let i = 0; i < c.length && tries < 8; i++) {
      if (c[i] !== '{' && c[i] !== '[') continue;
      tries++;
      const r = scan(c, i);
      yield { text: c, scan: r, start: i };
      if (r.end !== -1) i = r.end - 1;
      else if (!r.mismatch) break;
    }
  }
}

export function parseModelJson<T = unknown>(text: string): T {
  if (typeof text !== 'string' || !text.trim()) throw new ModelJsonError(String(text ?? ''), 'The model returned an empty answer.');
  for (const c of candidates(text)) {
    const whole = tryParse(c);
    if (whole.ok) return whole.value as T;
  }
  for (const v of values(text)) {
    if (v.scan.end === -1) continue;
    const r = tryParse(v.text.slice(v.start, v.scan.end));
    if (r.ok) return r.value as T;
  }
  throw new ModelJsonError(text);
}

/**
 * Like parseModelJson, but an answer cut off mid-list is closed after its last complete item ("repaired"). Use it where a
 * partial list is still worth having (details, clues, claims), never for a single text such as a rewrite.
 */
export function parseModelJsonLenient<T = unknown>(text: string): { value: T; repaired: boolean } {
  try {
    return { value: parseModelJson<T>(text), repaired: false };
  } catch (e) {
    for (const v of values(String(text ?? ''))) {
      if (v.scan.end !== -1 || !v.scan.safe) continue;
      const { at, open } = v.scan.safe;
      const closed = v.text.slice(v.start, at).replace(/,\s*$/, '') + open.reverse().map((b) => CLOSE[b]).join('');
      const r = tryParse(closed);
      if (r.ok) return { value: r.value as T, repaired: true };
    }
    throw e;
  }
}

/** The array at `key` of a parsed answer, or the answer itself if the model returned a bare array. Anything else: []. */
export function listAt(parsed: unknown, key: string): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  const v = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[key] : undefined;
  return Array.isArray(v) ? v : [];
}

/** JSON Schema subset accepted by both Chrome's Prompt API (responseConstraint) and Gemini (responseJsonSchema). */
export type JsonSchema = Record<string, unknown>;
