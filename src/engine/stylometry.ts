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

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .split(/[^a-z']+/)
    .filter(Boolean);
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

/** Burrows' Delta: mean absolute z-score difference between the query and each candidate. Lower = closer. */
export function burrowsDelta(query: string, candidates: Candidate[]): DeltaResult[] {
  const words = mostFrequentWords([query, ...candidates.map((c) => c.corpus)]);
  const profiles = candidates.map((c) => profile(c.corpus, words));
  const q = profile(query, words);
  const dims = q.length;
  const means = new Array(dims).fill(0);
  const sds = new Array(dims).fill(0);
  for (let d = 0; d < dims; d++) {
    const col = profiles.map((p) => p[d]);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    means[d] = m;
    sds[d] = Math.sqrt(col.reduce((a, b) => a + (b - m) ** 2, 0) / col.length) || 1;
  }
  // Only dimensions that vary across the lineup carry signal.
  const informative = [...Array(dims).keys()].filter((d) => sds[d] > 1e-6 && profiles.some((p) => p[d] > 0));
  return candidates
    .map((c, i) => {
      let sum = 0;
      for (const d of informative) sum += Math.abs((q[d] - means[d]) / sds[d] - (profiles[i][d] - means[d]) / sds[d]);
      return { id: c.id, delta: sum / Math.max(informative.length, 1) };
    })
    .sort((a, b) => a.delta - b.delta);
}

/** Rank of the target in the lineup (1 = most similar) and a 0–1 "exposure" score. */
export function exposure(query: string, candidates: Candidate[], targetId: string) {
  const ranked = burrowsDelta(query, candidates);
  const rank = ranked.findIndex((r) => r.id === targetId) + 1;
  const best = ranked[0].delta;
  const worst = ranked[ranked.length - 1].delta;
  const mine = ranked.find((r) => r.id === targetId)!.delta;
  const score = worst === best ? 0 : 1 - (mine - best) / (worst - best);
  return { rank, score, ranked };
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
  const grams = (text: string) => {
    const t = tokenize(text);
    const g = new Set<string>();
    for (let i = 0; i + 2 < t.length; i++) g.add(`${t[i]} ${t[i + 1]} ${t[i + 2]}`);
    return g;
  };
  const selfGrams = grams(self);
  const decoyGrams = decoys.map(grams);
  for (const g of grams(draft)) {
    if (selfGrams.has(g) && !decoyGrams.some((d) => d.has(g)) && !out.some((m) => g.includes(m.phrase) && m.phrase.includes(' '))) {
      out.push({ phrase: g, kind: 'style', why: 'Exact phrase from your public posts' });
    }
  }
  if (/—/.test(draft) && (self.match(/—/g)?.length ?? 0) > 3) {
    out.push({ phrase: '—', kind: 'style', why: 'Heavy em-dash habit, same as your public posts' });
  }
  return out.slice(0, 8);
}
