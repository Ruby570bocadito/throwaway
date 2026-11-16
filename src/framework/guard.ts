// Run-time taint tracking for private data.
// Text: 8-word shingles of every private string. Binary (images): a content hash.
// Anything about to leave the device is checked; a hit throws PrivacyViolation.

const SHINGLE = 8;
const textShingles = new Set<string>();
const binaryHashes = new Set<string>();

export class PrivacyViolation extends Error {
  readonly where: string;
  readonly evidence: string;
  constructor(where: string, evidence: string) {
    super(`Blocked: private data was about to leave the device (${where}). Matched: “${evidence}”`);
    this.name = 'PrivacyViolation';
    this.where = where;
    this.evidence = evidence;
  }
}

const words = (s: string) => s.toLowerCase().replace(/[’']/g, "'").split(/[^a-z0-9']+/).filter(Boolean);

function shingles(s: string): string[] {
  const w = words(s);
  const out: string[] = [];
  for (let i = 0; i + SHINGLE <= w.length; i++) out.push(w.slice(i, i + SHINGLE).join(' '));
  return out;
}

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

export function registerTaint(value: unknown) {
  if (typeof value === 'string') for (const s of shingles(value)) textShingles.add(s);
  else if (value instanceof Uint8Array) binaryHashes.add(hashBytes(value));
  else if (value && typeof value === 'object') for (const v of Object.values(value)) registerTaint(v);
}

/** Throws if `value` contains a private 8-word span or a private binary. */
export function assertUntainted(value: unknown, where: string) {
  if (typeof value === 'string') {
    for (const s of shingles(value)) if (textShingles.has(s)) throw new PrivacyViolation(where, s);
  } else if (value instanceof Uint8Array) {
    if (binaryHashes.has(hashBytes(value))) throw new PrivacyViolation(where, `${value.length} bytes of a private image`);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) assertUntainted(v, where);
  }
}

/** For tests and demo resets. */
export function clearTaint() {
  textShingles.clear();
  binaryHashes.clear();
}
