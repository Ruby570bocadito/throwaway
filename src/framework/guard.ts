// Run-time taint tracking for private data.
// Text: windows of a canonical letter stream. Case, accents, look-alike letters, invisible characters, spacing and
// punctuation are dropped, and HTML entities, %-encoding, JSON escapes and base64 are decoded first, so a careless copy
// (a slugified, escaped, URL-encoded or base64 draft, or one split into parts) is still the draft. 32 letters is about
// 7–8 words of English; measured on the real rewrites (16-nov), legitimate text shares at most 21 letters with the draft.
// Binary (images): a content hash, also of base64, data: URL and binary-string copies. Coordinates: their decimal forms.
// Anything about to leave the device is checked; a hit throws PrivacyViolation.

const WINDOW = 32;
const textWindows = new Set<number>();
const binaryHashes = new Set<string>();
const numberForms = new Set<string>();

export class PrivacyViolation extends Error {
  readonly where: string;
  readonly evidence: string;
  constructor(where: string, evidence: string) {
    // `evidence` can be a span of the private original: it stays on the error for debugging, never in the message,
    // which ends up in the route ledger and on screen (review, 16-nov: a ledger note showed a private fragment).
    super(`Blocked: private data was about to leave the device (${where}).`);
    this.name = 'PrivacyViolation';
    this.where = where;
    this.evidence = evidence;
  }
}

// ── Canonical text ─────────────────────────────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '-', mdash: '-', hellip: '.' };

/** Undoes the encodings a developer applies without thinking: HTML entities, JSON/JS escapes, %-encoding. */
export function decodeEscapes(s: string): string {
  const cp = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ');
  return s
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e: string) =>
      e[0] !== '#' ? (ENTITIES[e.toLowerCase()] ?? m) : cp(/^#x/i.test(e) ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)),
    )
    .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})/gi, (_m, a: string | undefined, b: string | undefined) => cp(parseInt(a ?? b ?? '', 16)))
    .replace(/\\x([0-9a-f]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrtbfv0]/g, ' ')
    .replace(/(?:%[0-9a-f]{2})+/gi, (m) => {
      try {
        return decodeURIComponent(m);
      } catch {
        return m.replace(/%([0-9a-f]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
      }
    });
}

/** Latin look-alikes (after lower-casing) that NFKD does not fold. Applied to both sides, so real Cyrillic/Greek still match. */
const LOOKALIKE: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's',
  ԁ: 'd', һ: 'h', ӏ: 'l', ԛ: 'q', ԝ: 'w', ү: 'y', α: 'a', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u',
  χ: 'x', ς: 'σ', ı: 'i', ɑ: 'a', ɡ: 'g', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', þ: 'th',
};
const LOOKALIKE_RE = new RegExp(`[${Object.keys(LOOKALIKE).join('')}]`, 'g');

/**
 * The letters and digits of `s`, without case, accents, look-alikes or anything invisible. Hangul is recomposed into
 * syllables. Two copies of the same text that differ only in how they are written give the same stream.
 */
export function canonicalLetters(s: string): string {
  // Lower-case after NFKD: "𝐂" (mathematical bold) has no lower case until it becomes "C". NFKD again for "İ" → "i̇".
  return decodeEscapes(s)
    .normalize('NFKD')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, '')
    .replace(LOOKALIKE_RE, (c) => LOOKALIKE[c])
    .replace(/[^\p{L}\p{N}]/gu, '')
    .normalize('NFC');
}

/**
 * Where a window the guard matched sits in `text`, as written: the stretch of `text`, widened to whole words, whose
 * canonical letters hold `evidence`. It lets the user see which passage of their own edit still matches their original
 * (on their screen only; the message of the error never carries it). Plain text only: escapes and base64 are not mapped
 * back. Null when it cannot be placed.
 */
export function locateEvidence(text: string, evidence: string): string | null {
  const want = Array.from(evidence);
  if (!want.length) return null;
  const chars = Array.from(text);
  const stream: string[] = [];
  const owner: number[] = [];
  chars.forEach((c, i) => {
    for (const l of Array.from(canonicalLetters(c))) {
      stream.push(l);
      owner.push(i);
    }
  });
  for (let s = 0; s + want.length <= stream.length; s++) {
    let k = 0;
    while (k < want.length && stream[s + k] === want[k]) k++;
    if (k < want.length) continue;
    let a = owner[s];
    let b = owner[s + want.length - 1];
    while (a > 0 && /\S/u.test(chars[a - 1])) a--;
    while (b < chars.length - 1 && /\S/u.test(chars[b + 1])) b++;
    return chars.slice(a, b + 1).join('').trim();
  }
  return null;
}

/** How many Latin letters a character is worth: a Chinese character carries about a word, a kana or Hangul syllable less. */
function weightOf(c: number): number {
  if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0x20000 && c <= 0x3134f)) return 3;
  if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff) || (c >= 0xac00 && c <= 0xd7af)) return 2;
  return 1;
}

/**
 * Every window of `WINDOW` letters (weighted) in the canonical stream, as a 53-bit rolling hash (two polynomial hashes
 * mod 2^32). O(n), so a long prompt is cheap. Returns the hash and the window, lazily, for evidence.
 */
function* windows(s: string): Generator<{ key: number; text: () => string }> {
  const chars = Array.from(canonicalLetters(s));
  const code = chars.map((c) => c.codePointAt(0) ?? 0);
  const w = code.map(weightOf);
  const B1 = 1000003;
  const B2 = 0x01000193;
  const p1 = [1];
  const p2 = [1];
  for (let k = 1; k <= WINDOW; k++) {
    p1.push(Math.imul(p1[k - 1], B1) >>> 0);
    p2.push(Math.imul(p2[k - 1], B2) >>> 0);
  }
  let h1 = 0;
  let h2 = 0;
  let weight = 0;
  let j = 0;
  for (let i = 0; i < chars.length; i++) {
    while (j < chars.length && weight < WINDOW) {
      h1 = (Math.imul(h1, B1) + code[j]) >>> 0;
      h2 = (Math.imul(h2, B2) + code[j]) >>> 0;
      weight += w[j++];
    }
    if (weight < WINDOW) return;
    const start = i;
    const end = j;
    yield { key: h1 + (h2 & 0x1fffff) * 4294967296, text: () => chars.slice(start, end).join('') };
    const len = j - i;
    h1 = (h1 - Math.imul(code[i], p1[len - 1])) >>> 0;
    h2 = (h2 - Math.imul(code[i], p2[len - 1])) >>> 0;
    weight -= w[i];
  }
}

// ── Binary ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function hashBytes(bytes: Uint8Array): string {
  // FNV-1a 64-bit (as two 32-bit halves). Enough to recognise the same image; not a security primitive.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ bytes[(i * 7) % bytes.length], 0x811c9dc5) >>> 0;
  }
  return `${h1.toString(16)}${h2.toString(16)}:${bytes.length}`;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const asText = (bytes: Uint8Array): string | null => {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
};

/** Base64 / base64url runs (a data: URL, `btoa(draft)`), decoded at each of the four alignments. */
function* base64Payloads(s: string): Generator<Uint8Array> {
  for (const m of s.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
    const run = m[0].replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
    for (let off = 0; off < 4; off++) {
      let body = run.slice(off);
      if (body.length % 4 === 1) body = body.slice(0, -1);
      try {
        const bin = atob(body + '='.repeat((4 - (body.length % 4)) % 4));
        yield Uint8Array.from(bin, (c) => c.charCodeAt(0));
      } catch {
        /* not base64 */
      }
    }
  }
}

/** `String.fromCharCode(...bytes)`: a string of byte values with control or high characters in it. */
// Control characters are exactly what this looks for, so the lint rule against them does not apply here.
// eslint-disable-next-line no-control-regex
const binaryString = (s: string) => /^[\x00-\xff]*$/.test(s) && /[\x00-\x08\x0e-\x1f\x7f-\xff]/.test(s);
const bytesOf = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

// ── Numbers (the user's real location) ────────────────────────────────────────────────────────────────────────────

/** A coordinate is private to 3 decimals (about 100 m). Fewer decimals are left alone: prices and versions look alike. */
function numberKeys(n: number): string[] {
  const abs = Math.abs(n);
  const s = String(abs);
  const dot = s.indexOf('.');
  if (!Number.isFinite(n) || Number.isInteger(n) || dot === -1 || s.length - dot - 1 < 3) return [];
  return [abs.toFixed(3), s.slice(0, dot + 4)];
}
const numbersIn = (s: string) => [...s.matchAll(/(?<![\d.,])\d{1,3}[.,]\d{3,}(?![\d])/g)].flatMap((m) => numberKeys(Number(m[0].replace(',', '.'))));

// ── Registry ───────────────────────────────────────────────────────────────────────────────────────────────────────

export function registerTaint(value: unknown, seen = new Set<unknown>()) {
  if (typeof value === 'string') {
    for (const { key } of windows(value)) textWindows.add(key);
  } else if (typeof value === 'number') {
    for (const k of numberKeys(value)) numberForms.add(k);
  } else if (value instanceof Uint8Array) {
    binaryHashes.add(hashBytes(value));
  } else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const v of Object.values(value)) registerTaint(v, seen);
  }
}

/**
 * `layers`: how many base64 decodings deep we are (three is more than any careless code does). `fromBytes`: the text
 * was decoded from bytes that were just checked, so it is not read back as a binary string.
 */
function checkText(s: string, where: string, layers: number, fromBytes = false) {
  for (const win of windows(s)) if (textWindows.has(win.key)) throw new PrivacyViolation(where, win.text());
  const decoded = decodeEscapes(s);
  for (const k of numbersIn(decoded)) if (numberForms.has(k)) throw new PrivacyViolation(where, 'a private coordinate');
  if (!fromBytes && binaryString(s)) checkBytes(bytesOf(s), where, layers);
  if (layers >= 3) return;
  for (const bytes of base64Payloads(decoded)) checkBytes(bytes, where, layers + 1);
}

function checkBytes(bytes: Uint8Array, where: string, layers: number) {
  if (binaryHashes.has(hashBytes(bytes))) throw new PrivacyViolation(where, `${bytes.length} bytes of a private image`);
  // Text smuggled as bytes (TextEncoder, base64 of a draft). An image is never valid UTF-8, so this costs one byte.
  const text = asText(bytes);
  if (text && text.trim()) checkText(text, where, layers, true);
}

/** Throws if `value` (a string, bytes, a number or anything holding them) carries private data. */
export function assertUntainted(value: unknown, where: string, seen = new Set<unknown>()) {
  if (typeof value === 'string') checkText(value, where, 0);
  else if (typeof value === 'number') {
    for (const k of numberKeys(value)) if (numberForms.has(k)) throw new PrivacyViolation(where, 'a private coordinate');
  } else if (value instanceof Uint8Array) checkBytes(value, where, 0);
  else if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const v of Object.values(value)) assertUntainted(v, where, seen);
  }
}

/** Non-throwing check, for UIs that want to warn before the user sends something. */
export function isTainted(value: unknown): boolean {
  try {
    assertUntainted(value, 'check');
    return false;
  } catch (e) {
    if (e instanceof PrivacyViolation) return true;
    throw e;
  }
}

/** For tests and demo resets. */
export function clearTaint() {
  textWindows.clear();
  binaryHashes.clear();
  numberForms.clear();
}
