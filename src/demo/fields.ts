// The fields a lineup can come from. Small enough for the app bundle; the writers themselves (decoys.ts, about 35 KB of
// text) load only when a lineup needs them.

export type DecoyPackId = 'design' | 'technology' | 'healthcare' | 'finance' | 'education' | 'retail';

export const FIELD_IDS: DecoyPackId[] = ['design', 'technology', 'healthcare', 'finance', 'education', 'retail'];

/** Written to read inside a sentence ("The other nine write about healthcare"). */
export const FIELD_LABELS: Record<DecoyPackId, string> = {
  design: 'design and product',
  technology: 'software and technology',
  healthcare: 'healthcare',
  finance: 'finance and accounting',
  education: 'teaching and education',
  retail: 'retail and hospitality',
};

/** The same, in Spanish ("Las otras nueve escriben sobre sanidad"): the app speaks Spanish since 22-nov. */
export const FIELD_LABELS_ES: Record<DecoyPackId, string> = {
  design: 'diseño y producto',
  technology: 'software y tecnología',
  healthcare: 'sanidad',
  finance: 'finanzas y contabilidad',
  education: 'docencia y educación',
  retail: 'comercio y hostelería',
};
