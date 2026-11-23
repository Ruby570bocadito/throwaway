// The demo photo of the app since 23-nov: a made-up selfie in a made-up street of Palma (Muse Image, 22-nov; no real person,
// no real address), the one on the landing page and in the photo bench (window-palma). Its answers are REAL, replayed:
// Gemini Nano's in Rafa's Chrome (photo bench, 22-nov), the cloud's from the live preview (gemini-3.5-flash-lite, 22/23-nov).
// The drawn scene it replaces (src/demo/photo.ts) stays for the tests: its recorded runs pin the threat's rules.

import type { GeoAnswer } from './photo';

/** The photo: the bench's own file (1280 × 853), so what replays is what was measured. */
export const SELFIE_SRC = '/bench/window-palma.webp';
export const SELFIE_W = 1280;
export const SELFIE_H = 853;

/** Gemini Nano's two scans of the photo with its numbered grid, as they came (photo bench, Rafa's Chrome, 22-nov). */
export const SELFIE_SCANS = [
  [
    { cell: 3, kind: 'text', what: 'CARER DE LA LLUM (street sign)' },
    { cell: 4, kind: 'architecture', what: 'Stone building architecture, shutters' },
    { cell: 7, kind: 'architecture', what: 'Stone buildings, narrow street' },
    { cell: 8, kind: 'text', what: 'FORN PASTISSERIA (shop sign)' },
    { cell: 10, kind: 'text', what: 'No readable text' },
  ],
  [
    { cell: 3, kind: 'text', what: 'Carrer de la Llum - street name' },
    // The shop sign is in cell 8, just above the "12" of the grid: the read of cell 12 finds nothing, and it is dropped.
    { cell: 12, kind: 'text', what: 'FORN PASTITESSERIA - bakery name' },
    { cell: 1, kind: 'architecture', what: 'Window with wooden frame' },
    { cell: 4, kind: 'architecture', what: 'Wooden shutters' },
    { cell: 8, kind: 'architecture', what: 'Awning over a shop' },
    { cell: 10, kind: 'reflection', what: 'Reflection of the street' },
    { cell: 11, kind: 'architecture', what: 'Narrow street with stone buildings' },
    { cell: 15, kind: 'vegetation', what: 'Potted plant with green leaves' },
  ],
];

/** Its readings of single cells, up close, in the same run. */
export const SELFIE_READS: Record<number, string[]> = {
  3: ['CARRER DE LA LLUM'],
  8: ['FORN PASTISSERIA'],
  12: [],
};

/**
 * REAL cloud answers on this photo, keyed by the cells blurred, through Firebase AI Logic from the live preview.
 *  - none (22-nov): the original, sent as it is (a made-up photo: nothing private).
 *  - 3,8 (23-nov): cells 3 and 8 blurred with their edges (EDGE), as the app blurs them from the answers above: 16 % of the
 *    photo. The first answer is the one replayed. The same photo, three more times: Valletta again, then "Valldemossa,
 *    Mallorca" twice (medium, then low confidence), 16 km from the scene. No answer read a street name or a number.
 * Before the edges (22-nov), cells 3 and 8 left half of the house number sharp: "Alcúdia, Mallorca" (medium); with cell
 * 12 blurred too, "Palma de Mallorca" (low). Those photos are no longer what the app makes, so they are not replayed.
 */
export const SELFIE_ATTACKS: Record<string, GeoAnswer> = {
  none: {
    place: 'Carrer de la Llum, Alcúdia, Mallorca, Spain',
    lat: 39.8524,
    lon: 3.1189,
    radiusKm: 0.05,
    confidence: 'high',
    clues: [
      { cell: 3, kind: 'text', what: 'Street sign reading CARRER DE LA LLUM' },
      { cell: 12, kind: 'text', what: 'Shop sign reading FORN PASTISSERIA' },
    ],
  },
  '3,8': {
    place: 'Valletta, Malta',
    lat: 35.8989,
    lon: 14.5146,
    radiusKm: 1,
    confidence: 'medium',
    clues: [
      { cell: 7, kind: 'architecture', what: 'Narrow limestone street with traditional Mediterranean architecture, typical of Maltese towns.' },
      { cell: 12, kind: 'other', what: 'Bakery window display visible inside the building.' },
    ],
  },
};
