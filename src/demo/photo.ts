// Illustrated demo scene for the photo threat (fictional street; no real person or address).
// The scene is set in Palma (Mallorca), a Catalan-speaking city, which matches its signs.
// 960×720, laid out on the 4×4 grid so each clue sits in a known cell:
//   2, 4: Mediterranean balconies (architecture)   3: street-name plaque   7: house number
//   8: bakery sign in Valencian                      11–12: orange tree       9, 10, 13, 14: the person

export const SCENE_W = 960;
export const SCENE_H = 720;

const balcony = (x: number) => `
  <rect x="${x}" y="70" width="130" height="100" fill="#f3e2c4"/>
  <rect x="${x + 12}" y="78" width="48" height="92" fill="#3f6b4f"/>
  <rect x="${x + 70}" y="78" width="48" height="92" fill="#3f6b4f"/>
  ${[0, 1, 2, 3, 4, 5].map((i) => `<line x1="${x + 14 + i * 7}" y1="84" x2="${x + 14 + i * 7}" y2="166" stroke="#2f5340" stroke-width="2"/>`).join('')}
  ${[0, 1, 2, 3, 4, 5].map((i) => `<line x1="${x + 72 + i * 7}" y1="84" x2="${x + 72 + i * 7}" y2="166" stroke="#2f5340" stroke-width="2"/>`).join('')}
  <rect x="${x - 10}" y="168" width="150" height="8" fill="#6b4b33"/>
  <g stroke="#1d1d1d" stroke-width="3" fill="none">
    <line x1="${x - 8}" y1="140" x2="${x + 138}" y2="140"/>
    ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => `<line x1="${x - 6 + i * 14}" y1="140" x2="${x - 6 + i * 14}" y2="168"/>`).join('')}
    ${[0, 1, 2, 3, 4].map((i) => `<circle cx="${x + 8 + i * 28}" cy="154" r="6"/>`).join('')}
  </g>`;

const oranges = [
  [668, 420], [700, 395], [742, 410], [770, 440], [690, 455], [730, 470], [760, 480], [705, 430], [655, 470], [782, 465],
]
  .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="8" fill="#f39a1e"/>`)
  .join('');

export const SCENE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${SCENE_W}" height="${SCENE_H}" viewBox="0 0 ${SCENE_W} ${SCENE_H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9fd3f0"/><stop offset="1" stop-color="#e3f3fb"/></linearGradient>
    <linearGradient id="wall" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#efe3cf"/><stop offset="1" stop-color="#e2d2b8"/></linearGradient>
    <linearGradient id="facade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#e2ab6e"/><stop offset="1" stop-color="#cf9259"/></linearGradient>
  </defs>
  <rect width="960" height="720" fill="url(#wall)"/>

  <!-- outside, seen through the window -->
  <rect x="200" y="20" width="740" height="540" fill="url(#sky)"/>
  <rect x="200" y="48" width="740" height="430" fill="url(#facade)"/>
  <rect x="200" y="44" width="740" height="12" fill="#b77a45"/>
  ${balcony(280)}
  ${balcony(775)}

  <!-- cell 3: street-name plaque, Valencian ceramic tiles -->
  <g>
    <rect x="522" y="72" width="186" height="74" rx="4" fill="#fbfaf5" stroke="#1f4e9c" stroke-width="5"/>
    <line x1="584" y1="74" x2="584" y2="144" stroke="#d6dbe6" stroke-width="1.5"/>
    <line x1="646" y1="74" x2="646" y2="144" stroke="#d6dbe6" stroke-width="1.5"/>
    <text x="615" y="98" font-family="Georgia, serif" font-size="15" fill="#1f4e9c" text-anchor="middle" letter-spacing="2">CARRER DE</text>
    <text x="615" y="132" font-family="Georgia, serif" font-size="30" font-weight="700" fill="#1f4e9c" text-anchor="middle">LA LLUM</text>
  </g>

  <!-- cell 6: shuttered window -->
  <rect x="300" y="215" width="120" height="120" fill="#f3e2c4"/>
  <rect x="310" y="222" width="100" height="108" fill="#3f6b4f"/>
  ${[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => `<line x1="312" y1="${228 + i * 9}" x2="408" y2="${228 + i * 9}" stroke="#2f5340" stroke-width="2"/>`).join('')}

  <!-- cell 7: doorway with house number -->
  <path d="M545 360 V265 Q610 215 675 265 V360 Z" fill="#5a3a22"/>
  <path d="M553 360 V270 Q610 228 667 270 V360 Z" fill="#6e4a2d"/>
  <line x1="610" y1="250" x2="610" y2="360" stroke="#4a2f1b" stroke-width="3"/>
  <ellipse cx="610" cy="205" rx="34" ry="22" fill="#fbfaf5" stroke="#1f4e9c" stroke-width="3"/>
  <text x="610" y="216" font-family="Georgia, serif" font-size="28" font-weight="700" fill="#1f4e9c" text-anchor="middle">23</text>

  <!-- cell 8: bakery -->
  <g>
    ${[0, 1, 2, 3, 4, 5, 6].map((i) => `<rect x="${730 + i * 30}" y="200" width="30" height="40" fill="${i % 2 ? '#fbfaf5' : '#c8372d'}"/>`).join('')}
    <path d="M730 240 ${Array(7).fill('q15 14 30 0').join(' ')}" fill="#c8372d"/>
    <rect x="742" y="262" width="186" height="44" rx="3" fill="#2b2b2b"/>
    <text x="835" y="290" font-family="Georgia, serif" font-size="22" font-weight="700" fill="#f2d39b" text-anchor="middle" letter-spacing="3">FORN</text>
    <text x="835" y="302" font-family="Arial, sans-serif" font-size="9" fill="#f2d39b" text-anchor="middle" letter-spacing="2">PASTISSERIA</text>
    <rect x="748" y="312" width="174" height="48" fill="#cfe6ef" stroke="#6b4b33" stroke-width="4"/>
    <ellipse cx="785" cy="345" rx="22" ry="9" fill="#d69a4f"/><ellipse cx="835" cy="347" rx="18" ry="8" fill="#c9873e"/><ellipse cx="880" cy="345" rx="20" ry="9" fill="#d69a4f"/>
  </g>

  <!-- street level -->
  <rect x="200" y="478" width="740" height="82" fill="#bdb6aa"/>
  <rect x="200" y="478" width="740" height="6" fill="#9e968a"/>

  <!-- cells 11–12: orange tree -->
  <rect x="712" y="470" width="16" height="70" fill="#6b4b33"/>
  <circle cx="720" cy="440" r="78" fill="#3c7d3a"/>
  <circle cx="676" cy="452" r="42" fill="#468a40"/>
  <circle cx="760" cy="420" r="44" fill="#367233"/>
  ${oranges}

  <!-- window frame and sill -->
  <rect x="200" y="20" width="740" height="540" fill="none" stroke="#8a5a32" stroke-width="22"/>
  <rect x="180" y="556" width="780" height="26" fill="#7a4e2b"/>

  <!-- interior: poster and table with mug -->
  <rect x="34" y="80" width="128" height="170" fill="#fbfaf5" stroke="#2b2b2b" stroke-width="5"/>
  <circle cx="98" cy="150" r="38" fill="#e86a4a"/><rect x="60" y="196" width="76" height="10" fill="#2b2b2b"/><rect x="60" y="214" width="50" height="8" fill="#2b2b2b"/>
  <rect x="440" y="640" width="520" height="80" fill="#a47148"/>
  <rect x="820" y="596" width="54" height="56" rx="6" fill="#fbfaf5"/><path d="M874 610 q22 4 0 30" stroke="#fbfaf5" stroke-width="8" fill="none"/>

  <!-- the person taking the selfie -->
  <path d="M60 720 Q80 590 250 575 Q420 590 440 720 Z" fill="#2f5d8a"/>
  <path d="M215 560 h70 v40 q-35 18 -70 0 Z" fill="#e7b493"/>
  <ellipse cx="250" cy="470" rx="78" ry="92" fill="#f1c6a5"/>
  <path d="M170 470 Q160 365 250 360 Q345 362 332 470 Q320 410 250 404 Q190 410 170 470 Z" fill="#2b2118"/>
  <ellipse cx="222" cy="478" rx="7" ry="9" fill="#2b2118"/><ellipse cx="280" cy="478" rx="7" ry="9" fill="#2b2118"/>
  <path d="M220 520 Q250 545 282 520" stroke="#9c4a3a" stroke-width="6" fill="none" stroke-linecap="round"/>
  <path d="M60 720 Q20 600 0 560 L0 720 Z" fill="#2f5d8a"/>
</svg>`;

/** Where the demo scene "is": Palma old town. Only used on the device to score the attack. */
export const DEMO_TRUTH = { lat: 39.5712, lon: 2.6488 };

/**
 * REAL Gemini Nano answer, on-device in the author's Chrome (15-nov-2026), for this scene with the numbered grid.
 * Note cell 1: Nano reads the abstract poster as a "Japanese flag" — a false clue, but masking it is the safe choice.
 */
export const PHOTO_CLUES = [
  { cell: 3, kind: 'text', what: 'Carrer de La Llum' },
  { cell: 7, kind: 'number', what: '23' },
  { cell: 8, kind: 'landmark', what: 'Forn Pastisseria' },
  { cell: 12, kind: 'vegetation', what: 'Tree with orange leaves' },
  { cell: 1, kind: 'text', what: 'Japanese flag' },
];

export type GeoAnswer = {
  place: string;
  lat: number;
  lon: number;
  radiusKm: number;
  confidence: string;
  clues: { cell: number; kind: string; what: string }[];
};

/**
 * REAL cloud answers recorded on 15/16-nov-2026 from gemini-3.5-flash-lite through Firebase AI Logic on this scene,
 * keyed by the exact cells that were masked (kinds normalised to our list).
 */
export const GEO_ATTACKS: Record<string, GeoAnswer> = {
  // The union of two Gemini Nano scans in the author's Chrome (16-nov): balcony, both halves of the tree and the poster too.
  '1,2,3,7,8,11,12': {
    place: 'Rome, Italy',
    lat: 41.9028,
    lon: 12.4964,
    radiusKm: 5,
    confidence: 'low',
    clues: [
      { cell: 4, kind: 'architecture', what: 'Italian style balcony with green shutters' },
      { cell: 16, kind: 'other', what: 'Coffee cup on a table typical of an Italian cafe' },
    ],
  },
  none: {
    place: 'Carrer de la Llum, 23, Palma, Mallorca, Spain',
    lat: 39.5696,
    lon: 2.6502,
    radiusKm: 0.5,
    confidence: 'high',
    clues: [
      { cell: 3, kind: 'text', what: 'CARRER DE LA LLUM text indicating the street name in Catalan' },
      { cell: 7, kind: 'number', what: 'Number 23 house number plate' },
      { cell: 8, kind: 'text', what: 'Forn / Pastisseria sign indicating a traditional bakery in Catalan-speaking regions' },
    ],
  },
  // The cells Gemini Nano flagged (above).
  '1,3,7,8,12': {
    place: 'Rome, Italy',
    lat: 41.9028,
    lon: 12.4964,
    radiusKm: 5,
    confidence: 'low',
    clues: [
      { cell: 5, kind: 'other', what: 'Medical cross symbol on wall' },
      { cell: 11, kind: 'vegetation', what: 'Citrus or orange tree' },
    ],
  },
  // Recorded with other manual selections (degraded mode).
  '3,7,8,11': {
    place: 'Tokyo, Japan',
    lat: 35.6762,
    lon: 139.6503,
    radiusKm: 10,
    confidence: 'low',
    clues: [{ cell: 1, kind: 'other', what: 'Minimalist poster with a red circle resembling the Japanese flag.' }],
  },
  '2,3,7,8,11,12': {
    place: 'Tokyo, Japan',
    lat: 35.6762,
    lon: 139.6503,
    radiusKm: 10,
    confidence: 'low',
    clues: [
      { cell: 1, kind: 'other', what: 'Poster with a red circle resembling the flag of Japan.' },
      { cell: 4, kind: 'architecture', what: 'Building facade style with balconies.' },
    ],
  },
};

/** The recording for a set of masked cells: exact match, else the recording with the closest number of masked cells. */
export function recordedGeo(masked: number[]): GeoAnswer {
  const key = masked.length ? [...masked].sort((x, y) => x - y).join(',') : 'none';
  if (GEO_ATTACKS[key]) return GEO_ATTACKS[key];
  const size = (k: string) => (k === 'none' ? 0 : k.split(',').length);
  const best = Object.keys(GEO_ATTACKS).sort((x, y) => Math.abs(size(x) - masked.length) - Math.abs(size(y) - masked.length))[0];
  return GEO_ATTACKS[best];
}
