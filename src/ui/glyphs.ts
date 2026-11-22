import { useMemo } from 'react';
import { mostFrequentWords, profile } from '../engine/stylometry';

/** How many function words a writer's glyph shows (profile() adds five punctuation habits after them: dashes, brackets, !, …, ;). */
const GLYPH_WORDS = 12;

/**
 * Each writer's habit with the commonest function words ("the", "but", "I"…), next to the other nine: one bar per word, above
 * the line when they use it more than the others, below when less. It is what the fingerprint compares, drawn small, in place
 * of ten grey silhouettes that told nobody anything (21-nov plan).
 */
export function useGlyphs(corpora: string[]): number[][] {
  return useMemo(() => {
    if (!corpora.length) return [];
    const words = mostFrequentWords(corpora, GLYPH_WORDS);
    const rates = corpora.map((c) => profile(c, words));
    return rates.map((row) =>
      row.map((v, j) => {
        const column = rates.map((r) => r[j]);
        const mean = column.reduce((a, b) => a + b, 0) / column.length;
        const sd = Math.sqrt(column.reduce((a, b) => a + (b - mean) ** 2, 0) / column.length) || 1;
        return Math.max(-2, Math.min(2, (v - mean) / sd));
      }),
    );
  }, [corpora]);
}
