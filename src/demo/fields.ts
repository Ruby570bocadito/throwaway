// The fields a lineup can come from. Small enough for the app bundle; the writers themselves (decoys.ts, about 35 KB of
// text) load only when a lineup needs them.

export type DecoyPackId = 'design' | 'technology' | 'healthcare' | 'finance' | 'education';

export const FIELD_IDS: DecoyPackId[] = ['design', 'technology', 'healthcare', 'finance', 'education'];

/** Written to read inside a sentence ("The other nine write about healthcare"). */
export const FIELD_LABELS: Record<DecoyPackId, string> = {
  design: 'design and product',
  technology: 'software and technology',
  healthcare: 'healthcare',
  finance: 'finance and accounting',
  education: 'teaching and education',
};
