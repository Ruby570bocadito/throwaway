// Deterministic stylometry that runs entirely in the browser.
// Burrows' Delta over function-word frequencies, plus simple habit markers.
// No model, no network: this is the honest, checkable metric.

export const FUNCTION_WORDS = [
  'the', 'a', 'an', 'and', 'but', 'or', 'so', 'because', 'if', 'then', 'that', 'which', 'who', 'this', 'these',
  'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'they', 'them', 'he', 'she', 'of', 'in', 'on', 'at', 'to',
  'for', 'with', 'about', 'from', 'by', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'have', 'has', 'had',
  'do', 'did', 'not', 'no', 'just', 'really', 'very', 'honestly', 'basically', 'like', 'actually', 'kind', 'of',
  'all', 'some', 'there', 'here', 'when', 'what', 'how', 'also', 'still', 'even', 'though', 'anyway', 'however',
  'therefore', 'moreover', 'one', 'would', 'could', 'should', 'will', 'can', 'more', 'most', 'quite', 'rather',
];

const UNIQUE_FW = Array.from(new Set(FUNCTION_WORDS));

/** Words, lower-cased. Letters of any script count ("café" is one word, not "caf"); digits and punctuation do not. */
export function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, "'")
    .split(/[^\p{L}\p{M}']+/u)
    .filter((w) => w && w !== "'");
}

export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The "most frequent words" (MFW) of the whole lineup, restricted to function words, as in classic Burrows' Delta.
 * Content words (team, design...) are deliberately excluded: they say what you write about, not how you write.
 */
export function mostFrequentWords(texts: string[], n = 30): string[] {
  const counts = new Map<string, number>();
  const fw = new Set(UNIQUE_FW);
  for (const t of texts) for (const w of tokenize(t)) if (fw.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

/** Relative frequency (per 1000 tokens) of each MFW, plus punctuation habits. */
export function profile(text: string, words: string[] = UNIQUE_FW): number[] {
  const toks = tokenize(text);
  const n = Math.max(toks.length, 1);
  const counts = new Map<string, number>();
  for (const t of toks) counts.set(t, (counts.get(t) ?? 0) + 1);
  const fw = words.map((w) => ((counts.get(w) ?? 0) / n) * 1000);
  const chars = Math.max(text.length, 1);
  const punct = [
    (text.match(/—|--/g)?.length ?? 0) / chars * 1000, // em dashes
    (text.match(/\(/g)?.length ?? 0) / chars * 1000, // parentheticals
    (text.match(/!/g)?.length ?? 0) / chars * 1000,
    (text.match(/\.\.\.|…/g)?.length ?? 0) / chars * 1000,
    (text.match(/;/g)?.length ?? 0) / chars * 1000,
  ];
  return [...fw, ...punct];
}

export interface Candidate {
  id: string;
  label: string;
  corpus: string;
}

export interface DeltaResult {
  id: string;
  delta: number;
}

/** Delta of the query profile to each candidate profile: z-scores over the candidates, mean absolute difference. */
function deltas(q: ArrayLike<number>, profiles: ArrayLike<number>[]): number[] {
  const dims = q.length;
  const means = new Array(dims).fill(0);
  const sds = new Array(dims).fill(0);
  for (let d = 0; d < dims; d++) {
    let m = 0;
    for (const p of profiles) m += p[d];
    m /= profiles.length;
    let v = 0;
    for (const p of profiles) v += (p[d] - m) ** 2;
    means[d] = m;
    sds[d] = Math.sqrt(v / profiles.length) || 1;
  }
  // Only dimensions that vary across the lineup carry signal.
  const informative = [...Array(dims).keys()].filter((d) => sds[d] > 1e-6 && profiles.some((p) => p[d] > 0));
  return profiles.map((p) => {
    let sum = 0;
    for (const d of informative) sum += Math.abs((q[d] - means[d]) / sds[d] - (p[d] - means[d]) / sds[d]);
    return sum / Math.max(informative.length, 1);
  });
}

/** Burrows' Delta: mean absolute z-score difference between the query and each candidate. Lower = closer. */
export function burrowsDelta(query: string, candidates: Candidate[]): DeltaResult[] {
  const words = mostFrequentWords([query, ...candidates.map((c) => c.corpus)]);
  const d = deltas(
    profile(query, words),
    candidates.map((c) => profile(c.corpus, words)),
  );
  return candidates.map((c, i) => ({ id: c.id, delta: d[i] })).sort((a, b) => a.delta - b.delta);
}

// ── How much a rank can be trusted ─────────────────────────────────────────────────────────────────────────────────

/** Below this many words the rank is noise (measured: 6 words of the author's own habits ranked her #10 of 10). */
export const MIN_WORDS = 50;
/** Below this, for the text or for the user's own writing, the rank is at best "medium". */
const SOLID_WORDS = 150;
const RESAMPLES = 100;

export interface Reliability {
  /** Words in the text being fingerprinted. */
  words: number;
  /** Words of the user's own public writing the comparison rests on. */
  selfWords: number;
  /**
   * 'too-short': below MIN_WORDS, do not present the rank as a finding. Otherwise how stable the rank is when the words of
   * every text are resampled (high: it moves by one place at most; medium: by up to three), capped for short or
   * non-English text.
   */
  level: 'too-short' | 'low' | 'medium' | 'high';
  /** Share of resamples in which the user keeps the rank found on the full text (0–1). */
  stability: number;
  /** The user's rank across 90% of the resamples, e.g. [1, 3]. */
  rankRange: [number, number];
  /** What limits the result, in plain words, for the UI. */
  notes: string[];
}

const PUNCT = [/—|--/g, /\(/g, /!/g, /\.\.\.|…/g, /;/g];
interface Unit {
  tokens: string[];
  punct: number[];
  chars: number;
}
/** A text as whitespace-separated pieces (a word with its punctuation): the unit the bootstrap resamples. Cached. */
const unitCache = new Map<string, Unit[]>();
function unitsOf(text: string): Unit[] {
  let units = unitCache.get(text);
  if (!units) {
    units = text
      .split(/\s+/)
      .filter(Boolean)
      .map((piece) => ({ tokens: tokenize(piece), punct: PUNCT.map((re) => piece.match(re)?.length ?? 0), chars: piece.length + 1 }));
    if (unitCache.size >= 64) unitCache.clear();
    unitCache.set(text, units);
  }
  return units;
}

/** Deterministic PRNG (mulberry32): the same text always gets the same reliability, so the UI does not flicker. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The profile of a resample of `units` (or of all of them), with the same features as `profile`. */
function unitProfile(units: Unit[], index: Map<string, number>, words: number, rand: (() => number) | null): Float64Array {
  const out = new Float64Array(words + PUNCT.length);
  let tokens = 0;
  let chars = 0;
  const n = units.length;
  for (let i = 0; i < n; i++) {
    const u = units[rand ? Math.floor(rand() * n) : i];
    tokens += u.tokens.length;
    chars += u.chars;
    for (const t of u.tokens) {
      const d = index.get(t);
      if (d !== undefined) out[d]++;
    }
    for (let k = 0; k < PUNCT.length; k++) out[words + k] += u.punct[k];
  }
  for (let d = 0; d < words; d++) out[d] = (out[d] / Math.max(tokens, 1)) * 1000;
  for (let k = 0; k < PUNCT.length; k++) out[words + k] = (out[words + k] / Math.max(chars, 1)) * 1000;
  return out;
}

/**
 * How far to trust the target's rank: a bootstrap that resamples the words of the text (with replacement) and recomputes
 * Delta against the same lineup each time. It answers "would another 80 words in the same style still rank you here?",
 * the noise of a short text. The lineup texts are fixed: the attacker sees exactly those. A tiny text can be *stably*
 * wrong (6 words of the author's habits stayed at #10 in 96% of resamples), hence the hard MIN_WORDS floor.
 */
export function reliability(query: string, candidates: Candidate[], targetId: string, observedRank: number): Reliability {
  const words = tokenize(query).length;
  const self = candidates.find((c) => c.id === targetId);
  const selfWords = self ? tokenize(self.corpus).length : 0;
  const notes: string[] = [];
  const fw = new Set(UNIQUE_FW);
  const toks = tokenize(query);
  const englishShare = toks.length ? toks.filter((t) => fw.has(t)).length / toks.length : 0;

  const mfw = mostFrequentWords([query, ...candidates.map((c) => c.corpus)]);
  const index = new Map(mfw.map((w, i) => [w, i]));
  const qUnits = unitsOf(query);
  const profiles = candidates.map((c) => unitProfile(unitsOf(c.corpus), index, mfw.length, null));
  const target = candidates.findIndex((c) => c.id === targetId);
  const rand = mulberry32(0x5eed);
  const ranks: number[] = [];
  for (let r = 0; r < RESAMPLES && qUnits.length && target >= 0; r++) {
    const d = deltas(unitProfile(qUnits, index, mfw.length, rand), profiles);
    // Ties go to the earlier candidate, as in the sorted ranking.
    ranks.push(1 + d.filter((x, i) => x < d[target] || (x === d[target] && i < target)).length);
  }
  ranks.sort((a, b) => a - b);
  const stability = ranks.length ? ranks.filter((x) => x === observedRank).length / ranks.length : 0;
  const rankRange: [number, number] = ranks.length
    ? [ranks[Math.floor(0.05 * ranks.length)], ranks[Math.ceil(0.95 * ranks.length) - 1]]
    : [1, candidates.length];

  const order = ['too-short', 'low', 'medium', 'high'] as const;
  const width = rankRange[1] - rankRange[0];
  let level: Reliability['level'] = width <= 1 ? 'high' : width <= 3 ? 'medium' : 'low';
  const cap = (max: Reliability['level']) => {
    if (order.indexOf(level) > order.indexOf(max)) level = max;
  };
  if (words < MIN_WORDS) {
    level = 'too-short';
    notes.push(`Only ${words} words: too short to tell. Writing style needs about ${MIN_WORDS} words to show, and a few hundred to show clearly.`);
  } else {
    if (words < SOLID_WORDS) {
      cap('medium');
      notes.push(`${words} words is a short sample: treat the rank as a hint.`);
    }
    if (englishShare < 0.15) {
      cap('low');
      notes.push('This does not read as English: the fingerprint counts English function words, so it says little here.');
    }
  }
  if (selfWords < SOLID_WORDS) {
    if (level !== 'too-short') cap('medium');
    notes.push(`Your public writing has only ${selfWords} words; with fewer than ${SOLID_WORDS} the comparison is rough.`);
  }
  const others = candidates.filter((c) => c.id !== targetId).map((c) => tokenize(c.corpus).length).sort((a, b) => a - b);
  const median = others.length ? others[Math.floor(others.length / 2)] : 0;
  if (median && selfWords > 5 * median) {
    notes.push('Your public writing is much longer than the other writers’ samples, so the comparison is uneven.');
  }
  return { words, selfWords, level, stability, rankRange, notes };
}

/** Rank of the target in the lineup (1 = most similar), a 0–1 "exposure" score, and how far to trust them. */
export function exposure(query: string, candidates: Candidate[], targetId: string) {
  const ranked = burrowsDelta(query, candidates);
  const rank = ranked.findIndex((r) => r.id === targetId) + 1;
  const best = ranked[0].delta;
  const worst = ranked[ranked.length - 1].delta;
  const mine = ranked.find((r) => r.id === targetId)!.delta;
  const score = worst === best ? 0 : 1 - (mine - best) / (worst - best);
  return { rank, score, ranked, reliability: reliability(query, candidates, targetId, rank) };
}

export interface Marker {
  phrase: string;
  kind: 'style' | 'content';
  why: string;
}

/** Habit markers: words over-represented in your own public writing vs. the decoys, present in the draft. */
export function styleMarkers(draft: string, self: string, decoys: string[]): Marker[] {
  const rate = (text: string) => {
    const toks = tokenize(text);
    const m = new Map<string, number>();
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1 / Math.max(toks.length, 1));
    return m;
  };
  const selfRate = rate(self);
  const decoyRates = decoys.map(rate);
  const draftToks = new Set(tokenize(draft));
  const habitWords = new Set([...UNIQUE_FW, 'sorry', 'literally', 'totally', 'super', 'tbh', 'ngl', 'lol']);
  const out: Marker[] = [];
  for (const w of draftToks) {
    if (w.length < 2 || !habitWords.has(w)) continue;
    const s = selfRate.get(w) ?? 0;
    const d = decoyRates.reduce((a, r) => a + (r.get(w) ?? 0), 0) / decoyRates.length;
    if (s > 0.008 && s > 4 * (d + 0.0005)) {
      out.push({ phrase: w, kind: 'style', why: `You use “${w}” ${Math.round(s / (d + 0.0005))}× more than other writers` });
    }
  }
  // Signature phrases: 3-word sequences you repeat verbatim from your public writing.
  const gramCounts = (text: string) => {
    const t = tokenize(text);
    const g = new Map<string, number>();
    for (let i = 0; i + 2 < t.length; i++) {
      const k = `${t[i]} ${t[i + 1]} ${t[i + 2]}`;
      g.set(k, (g.get(k) ?? 0) + 1);
    }
    return g;
  };
  const selfGrams = gramCounts(self);
  const decoyGrams = decoys.map(gramCounts);
  // In a long public text any common phrase ("one of the") shows up once by chance: there a signature must recur and carry
  // a word of its own. A short text (the demo's 170 words) cannot show recurrence, so one occurrence still counts.
  const fw = new Set(UNIQUE_FW);
  const long = tokenize(self).length >= 400;
  const signature = (g: string) => !long || ((selfGrams.get(g) ?? 0) >= 2 && g.split(' ').some((w) => !fw.has(w)));
  for (const g of gramCounts(draft).keys()) {
    if (selfGrams.has(g) && signature(g) && !decoyGrams.some((d) => d.has(g)) && !out.some((m) => g.includes(m.phrase) && m.phrase.includes(' '))) {
      out.push({ phrase: g, kind: 'style', why: 'Exact phrase from your public posts' });
    }
  }
  if (/—/.test(draft) && (self.match(/—/g)?.length ?? 0) > 3) {
    out.push({ phrase: '—', kind: 'style', why: 'Heavy em-dash habit, same as your public posts' });
  }
  return out.slice(0, 8);
}
