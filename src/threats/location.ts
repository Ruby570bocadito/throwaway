// Threat: "where was this photo taken?" — visual geolocation of a photo you want to post.
// Local: Gemini Nano looks at the private photo (with a numbered grid drawn on it) and lists the cells that give your
// location away; the cells are blurred on the device, around the faces.
// Cloud: a geolocation attacker gets ONLY the released (masked) photo and estimates where it was taken and how precisely.
// If it can still narrow you down, it says which cells helped, and the loop masks those too.

import { listAt, ModelJsonError, parseModelJson, parseModelJsonLenient, Private, release, type JsonSchema, type Kit, type Publishable, type Threat } from '../framework';

export const GRID = 4; // 4×4 cells, numbered 1–16 left to right, top to bottom

/** A rectangle of the photo, in pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A part of the photo to hide: a solid box over what can be read, a blur over the rest (a landmark, a reflection). */
export interface MaskRegion {
  rect: Rect;
  style: 'box' | 'blur';
  /** The grid cell whose clue it hides, and what the clue was. */
  cell: number;
  what: string;
}

export interface ImageOps {
  /** Draws the numbered grid on a copy (set-of-mark prompting), so models can point at cells: PNG, or JPEG for the cloud. */
  withGrid(png: Uint8Array, n: number, type?: 'image/png' | 'image/jpeg'): Promise<Uint8Array>;
  /** The photo's size in pixels. */
  size(png: Uint8Array): Promise<{ width: number; height: number }>;
  /** A part of the photo, as PNG: one cell, for Gemini Nano to read. */
  crop(png: Uint8Array, r: Rect): Promise<Uint8Array>;
  /** The faces in the photo (whole heads), found on the device: never hidden. */
  faces(png: Uint8Array): Promise<Rect[]>;
  /** Hides the regions: a solid box over what can be read, a strong blur over the rest. */
  paint(png: Uint8Array, regions: MaskRegion[]): Promise<Uint8Array>;
}

export interface PhotoClue {
  cell: number;
  kind: string;
  what: string;
  /**
   * Whether Gemini Nano, reading the cell alone, read the text this clue names: true, false, or absent when not checked
   * (a landmark has nothing to read). On the bench it put a house number in two wrong cells and a plate over a whole car.
   */
  read?: boolean;
  /** What Gemini Nano read in the cell, up close. */
  seen?: string[];
}

export interface LocationVerdict {
  place: string;
  lat: number | null;
  lon: number | null;
  /** The attacker's own uncertainty. */
  radiusKm: number;
  confidence: string;
  clues: PhotoClue[]; // cells the attacker used
  /** How far the guess landed from where the user really is. Computed on the device; null if the user gave no location. */
  errorKm: number | null;
}

export interface LocationOptions {
  ops: ImageOps;
  /**
   * Where the user really is. Private: it is only used on the device to score the attack, never sent.
   * Without it, the attacker's self-reported radius is used, which over-trusts a confident wrong guess.
   */
  truth?: Private<{ lat: number; lon: number }>;
  /** Beyond this distance from the truth (or claimed precision) the guess is the wrong place: green. */
  safeRadiusKm?: number;
  /** Within this distance it found your street: red. Between the two it knows your city, not your street: amber. */
  streetRadiusKm?: number;
  /**
   * How many times to ask the local model for clues; the answers are merged. Gemini Nano is not deterministic (the same
   * photo gave 5 clue cells, then 4), and on-device calls are free, so asking twice buys recall at no cost and no egress.
   */
  scans?: number;
  /**
   * How much of the photo masking may cover (default a quarter), so it stays worth posting. Identifiers (street names,
   * house numbers, plates) are masked even beyond it. Live (16-nov): on a Paris street Gemini Nano flagged facades in
   * every cell and the union of its clues and the attacker's pixelated the whole photo.
   */
  maxMaskedShare?: number;
  /** Blur the faces too (default off). Testers asked for it (22-nov); the threat's own switch can change it later. */
  blurFaces?: boolean;
  /**
   * Blur only the part of a cell where the text is (default off, until the photo bench says it covers every identifier).
   * A street name, house number or plate read in its cell is read again in four overlapping quarters of that cell; the
   * quarters that still read it, padded, are blurred instead of the whole cell. Nowhere or everywhere: the whole cell, as
   * before. Four more Gemini Nano calls per identifier (Rafa, 22-nov: "more detail in the blurring").
   */
  tight?: boolean;
}

/** Clues that point at one spot; the rest (architecture, vegetation, "other") mostly say which city, not where in it. */
const SPECIFIC = new Set(['text', 'number', 'plate', 'landmark', 'reflection']);

const KINDS = ['text', 'number', 'landmark', 'plate', 'vegetation', 'architecture', 'reflection', 'other'];

const CLUE_ITEM: JsonSchema = {
  type: 'object',
  properties: { cell: { type: 'integer' }, kind: { type: 'string', enum: KINDS }, what: { type: 'string' } },
  required: ['cell', 'kind', 'what'],
};

const CLUES_SCHEMA: JsonSchema = { type: 'object', properties: { clues: { type: 'array', items: CLUE_ITEM } }, required: ['clues'] };

const GEO_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    place: { type: 'string' },
    lat: { type: 'number' },
    lon: { type: 'number' },
    radiusKm: { type: 'number' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    clues: { type: 'array', items: CLUE_ITEM },
  },
  required: ['place', 'lat', 'lon', 'radiusKm', 'confidence', 'clues'],
};

/** Great-circle distance in km (haversine). */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  // Rounding can push h a hair above 1 for antipodal points; asin would return NaN, and NaN scores as "safe".
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const validCell = (c: unknown): c is number => Number.isInteger(c) && (c as number) >= 1 && (c as number) <= GRID * GRID;

/** A number from what a model wrote: 3, "3", "cell 3", "0.5 km". */
const toNumber = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.match(/-?\d+(?:\.\d+)?/)?.[0] ?? NaN) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Small models name kinds their own way ("street sign", "house number", "license plate", "tree"): map them to ours. */
const KIND_WORDS: [RegExp, string][] = [
  [/plate|registration/i, 'plate'],
  [/number|digit/i, 'number'],
  [/text|sign|plaque|writing|letter|word|banner|poster|graffiti|menu|label/i, 'text'],
  [/reflect|mirror/i, 'reflection'],
  [/landmark|monument|church|cathedral|tower|statue|bridge|temple|castle/i, 'landmark'],
  [/vegetation|tree|plant|flora|palm|garden|flower|bush/i, 'vegetation'],
  [/architect|facade|façade|building|balcon|window|roof|door|house|street ?style/i, 'architecture'],
];

/** A clue from either model, checked and normalised; null if it does not point at a cell of the grid. */
export function normaliseClue(raw: unknown): PhotoClue | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { cell?: unknown; kind?: unknown; what?: unknown };
  const cell = toNumber(r.cell);
  if (cell === null || !validCell(cell)) return null;
  const kindText = String(r.kind ?? '').trim().toLowerCase();
  const kind = KINDS.includes(kindText) ? kindText : (KIND_WORDS.find(([re]) => re.test(kindText))?.[1] ?? 'other');
  return { cell, kind, what: typeof r.what === 'string' ? r.what : String(r.what ?? '') };
}

/** "High", "LOW", "very high", "0.9"… → low | medium | high. Unknown words count as sure: the safe direction. */
function normaliseConfidence(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s || /\blow\b|\bnone\b|\bunsure\b|\buncertain\b|\bnot (?:very )?(?:sure|certain|confident)\b/.test(s)) return 'low';
  return /high|certain|sure|confident/.test(s) ? 'high' : 'medium';
}

// People are never a location clue: masking a face would defeat the point of posting a selfie. Gemini Nano also says
// "woman", "man", "head" and "hair", which slipped through before (21-nov review).
// And what they have on them: on the photo bench it also listed "Tooth", "Earring" and "Glasses" (21-nov).
const PERSON =
  /\b(person|persons|people|man|men|woman|women|girl|girls|boy|boys|child|children|kid|kids|baby|face|faces|head|heads|hair|eyes|eyebrows?|nose|mouth|lips|tooth|teeth|beard|moustache|mustache|freckles|smile|smiling|body|bodies|shoulders?|selfie|human|humans|crowd|friends|couple|tourists?|pedestrians?|portrait|someone|glasses|sunglasses|spectacles|earrings?|necklace|jacket|shirt|t-shirt|hoodie|sweater|scarf|backpack)\b/i;

// What a small model writes when there is nothing there is not a clue: "text: None" in six cells of an empty park (bench).
// "No readable text" too: Gemini Nano gave it as a text clue on the Palma selfie (22-nov), and the app showed it as one.
const NOTHING = /^\s*(?:none|n\/?a|nothing(?: (?:readable|visible|legible))?|no (?:readable |visible |legible |clear )?(?:text|writing|signs?)(?: (?:visible|found|here))?|unknown|unclear|not visible|empty|-+)?\s*[.!]?\s*$/i;
const wordsOf = (s: string) => s.split(/[^\p{L}\p{N}'’-]+/u).filter(Boolean);

/**
 * Whether what a model wrote about a clue has something to read in it: digits, a word in capitals, quoted words, an
 * address word, or a name (a capitalised word after the first). On the bench, "text" clues also came as "Menu",
 * "Coffee cup" and "Door with a plaque": nothing anyone could read, so nothing to hide (21-nov).
 */
export function readsSomething(what: string): boolean {
  // An address word counts with a name: "Rua das Flores", not a landmark called "Street", which was read up close as a
  // made-up plate and hidden (bench, Paris, 21-nov).
  if (/\d/.test(what) || /["“][^"”]{2,}["”]/.test(what) || (ADDRESS.test(what) && namesIn(what).length > 0)) return true;
  const words = wordsOf(what);
  if (words.some((x) => x.length >= 2 && x === x.toUpperCase() && x !== x.toLowerCase())) return true;
  return words.slice(1).some((x) => /^\p{Lu}\p{Ll}/u.test(x));
}

/**
 * A landmark or a reflection that names something a person could look up ("Baker Street station"), not "a tram", "a path
 * through trees" or "station structure", which said only Tokyo and covered four cells of it (bench, 21-nov).
 */
const namesSomething = (what: string) => readsSomething(what);
/** A clue worth a look at all: something there, and not a person. */
const meaningful = (c: PhotoClue) => !NOTHING.test(c.what) && !PERSON.test(c.what);

/** The pixels of cell `cell` of an `n`×`n` grid laid over a `w`×`h` area at (x0, y0); edges rounded outwards, as cellRect does. */
export function gridSquare(cell: number, n: number, area: Rect): Rect {
  const r = Math.floor((cell - 1) / n);
  const k = (cell - 1) % n;
  const x = area.x + Math.floor((k * area.w) / n);
  const y = area.y + Math.floor((r * area.h) / n);
  return { x, y, w: area.x + Math.ceil(((k + 1) * area.w) / n) - x, h: area.y + Math.ceil(((r + 1) * area.h) / n) - y };
}

/**
 * How far a hidden cell reaches into the cells around it, as a share of a cell's short side. Text right at a cell's edge
 * runs on past it: on the Palma photo the house number sat on the line between two cells, and with its cell hidden the
 * lower half was left sharp (photo bench in Rafa's Chrome, 22-nov: 53 % of it covered). An eighth of a cell (about 26 px
 * at 1280 × 853) takes in such an edge; faces are still cut out of it.
 */
export const EDGE = 0.12;

/** The part of the photo that hiding a cell blurs: the cell, grown by `edge` of a cell on every side, inside the photo. */
export function cellArea(cell: number, n: number, area: Rect, edge = EDGE): Rect {
  const sq = gridSquare(cell, n, area);
  const m = Math.round(edge * Math.min(area.w / n, area.h / n));
  const x = Math.max(area.x, sq.x - m);
  const y = Math.max(area.y, sq.y - m);
  return { x, y, w: Math.min(area.x + area.w, sq.x + sq.w + m) - x, h: Math.min(area.y + area.h, sq.y + sq.h + m) - y };
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * The share of `within` (by default the whole photo) that the union of `rects` covers, measured on a grid of points:
 * overlapping boxes count once.
 */
export function coverage(rects: Rect[], within: Rect, steps = 96): number {
  if (!rects.length || within.w <= 0 || within.h <= 0) return 0;
  const near = rects.filter((r) => overlaps(r, within));
  if (!near.length) return 0;
  let hit = 0;
  for (let i = 0; i < steps; i++)
    for (let j = 0; j < steps; j++) {
      const px = within.x + ((i + 0.5) * within.w) / steps;
      const py = within.y + ((j + 0.5) * within.h) / steps;
      if (near.some((r) => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h)) hit++;
    }
  return hit / (steps * steps);
}

/** A face box grown by a tenth on each side (hair, ears, chin), kept inside the photo. */
export function grown(r: Rect, whole: Rect, by = 0.1): Rect {
  const x = Math.max(whole.x, r.x - r.w * by);
  const y = Math.max(whole.y, r.y - r.h * by);
  return { x, y, w: Math.min(whole.x + whole.w, r.x + r.w * (1 + by)) - x, h: Math.min(whole.y + whole.h, r.y + r.h * (1 + by)) - y };
}

/** A rectangle with holes cut out of it (faces), as the rectangles left: bands above and below each hole, and either side. */
export function cutAround(rect: Rect, holes: Rect[], min = 6): Rect[] {
  let pieces = [rect];
  for (const h of holes) {
    const next: Rect[] = [];
    for (const p of pieces) {
      if (!overlaps(p, h)) {
        next.push(p);
        continue;
      }
      const top = h.y - p.y;
      const bottom = p.y + p.h - (h.y + h.h);
      const y0 = Math.max(p.y, h.y);
      const y1 = Math.min(p.y + p.h, h.y + h.h);
      if (top > 0) next.push({ x: p.x, y: p.y, w: p.w, h: top });
      if (bottom > 0) next.push({ x: p.x, y: h.y + h.h, w: p.w, h: bottom });
      if (h.x > p.x) next.push({ x: p.x, y: y0, w: h.x - p.x, h: y1 - y0 });
      if (p.x + p.w > h.x + h.w) next.push({ x: h.x + h.w, y: y0, w: p.x + p.w - (h.x + h.w), h: y1 - y0 });
    }
    pieces = next;
  }
  return pieces.filter((r) => r.w >= min && r.h >= min);
}

const READ_SCHEMA: JsonSchema = { type: 'object', properties: { texts: { type: 'array', items: { type: 'string' } } }, required: ['texts'] };

/** Letters and digits only, upper case, accents dropped: "AB-123-CD" → "AB123CD", "Café" → "CAFE". */
const plain = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
// Words that say what kind of thing a clue is, not what it reads: "Street sign reading Rua Augusta" names RUA and AUGUSTA.
const GENERIC = new Set(
  'A AN THE OF AND WITH ON IN AT FOR TO FROM READING READS SAYS SAYING SHOWING TEXT SIGN SIGNS SIGNAGE STREET NAME SHOP STORE NUMBER HOUSE PLATE LICENSE LICENCE VEHICLE CAR PLAQUE BOARD WRITTEN VISIBLE PARTIALLY'.split(' '),
);
const keep = (t: string) => (t.length >= 2 || /\d/.test(t)) && !GENERIC.has(t);
/** Every word of a text that was read, plain. */
const tokensOf = (s: string) => s.split(/[^\p{L}\p{N}-]+/u).map(plain).filter(keep);
/**
 * The names, numbers and plates a clue says can be read, not the words that describe it: "Street sign reading Rua
 * Augusta" → RUA, AUGUSTA; "House number 27." → 27; "Underground station sign." → nothing.
 */
function namesIn(what: string): string[] {
  const quoted = [...what.matchAll(/["“]([^"”]{2,})["”]/g)].flatMap((m) => m[1].split(/\s+/));
  const words = what.split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
  const named = words.filter((w, i) => /\d/.test(w) || (w.length >= 2 && w === w.toUpperCase() && w !== w.toLowerCase()) || (i > 0 && /^\p{Lu}/u.test(w)));
  return [...quoted, ...named].map(plain).filter(keep);
}
/** At most `n` edits apart (Levenshtein), for words a small model misspells ("CARRETER" for "CARRER"). */
function near(a: string, b: string, n: number): boolean {
  if (Math.abs(a.length - b.length) > n) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length] <= n;
}

/**
 * Whether the text read in a cell is what the clue names: one of its words (a name, a number, a plate), as read or
 * nearly. A clue that names nothing to read ("Underground station sign") counts as read if anything was.
 */
export function readMatches(texts: string[], what: string): boolean {
  const got = texts.flatMap(tokensOf);
  // Any word of the clue: its first word too ("Boulangerie Martin" read as "BOULANGERIE" in the cell with that half of
  // the sign, bench 21-nov), as long as it is a word that says something (four letters or more) or has digits.
  const want = [...new Set([...namesIn(what), ...wordsIn(what)])];
  if (want.some((w) => got.some((g) => alike(g, w)))) return true;
  return !namesIn(what).length && got.some((g) => g.length >= 3);
}

/** The same word, read or written by a small model: equal, one inside the other, or a few letters apart. */
const alike = (g: string, w: string) =>
  g === w ||
  (w.length >= 4 && g.length >= 3 && (w.includes(g) || g.includes(w))) ||
  (w.length >= 5 && near(g, w, slack(g, w))) ||
  (w.length >= 6 && sameLetters(g, w));

/**
 * How many letters two spellings of a word can be apart: one, two from eight letters, and a third of a long word that
 * starts the same: "HARAKUJUKU" read up close, "HARAKUJO" in the scan (bench, Tokyo, 21-nov); not "ROTTERDAM" for "AMSTERDAM".
 */
const slack = (g: string, w: string) =>
  w.length < 8 ? 1 : g.slice(0, 3) === w.slice(0, 3) ? Math.max(2, Math.floor((g.length + w.length) / 6)) : 2;

/** The same letters, a couple out of place: HARAJUKU read up close, HARAKUJO in the scan (bench, 21-nov). */
function sameLetters(a: string, b: string): boolean {
  if (a.slice(0, 2) !== b.slice(0, 2) || Math.abs(a.length - b.length) > 1) return false;
  const count = new Map<string, number>();
  for (const ch of a) count.set(ch, (count.get(ch) ?? 0) + 1);
  for (const ch of b) count.set(ch, (count.get(ch) ?? 0) - 1);
  return [...count.values()].reduce((n, v) => n + Math.abs(v), 0) <= 2;
}

/** The words of a clue that say something: four letters or more, or with digits, and not "sign" or "street". */
const wordsIn = (what: string) => tokensOf(what).filter((t) => t.length >= 4 || /\d/.test(t));


/** Two clues that say the same: at least half of their words alike ("Carre de Verdi" and "Carrer de Verdi"). */
function similar(a: PhotoClue, b: PhotoClue): boolean {
  const wa = wordsIn(a.what);
  const wb = wordsIn(b.what);
  if (!wa.length || !wb.length) return false;
  const shared = wa.filter((x) => wb.some((y) => alike(x, y))).length;
  return shared >= Math.max(wa.length, wb.length) / 2;
}

/** Two clues about the same thing ("House number 27" in two cells): the same name, number or plate. */
const sameThing = (a: PhotoClue, b: PhotoClue) => readMatches([a.what], b.what) && readMatches([b.what], a.what);

/**
 * Clues to drop: one Gemini Nano could not read in its cell, when it read the same thing in another cell. On the bench it
 * put one house number in three cells and one plate over four (the whole car): the cell where it reads it is the one.
 */
const misplaced = (c: PhotoClue, all: PhotoClue[]) =>
  c.read === false && !continues(c, all) && all.some((v) => v.read === true && v.cell !== c.cell && sameThing(v, c));

/**
 * A cell that holds the rest of a sign read in the cell beside it, left or right (signs run sideways: a cell under a
 * sign was hidden in Tokyo as its "rest"): "Carrer de Verdi" was read in one cell, and the cell
 * beside it, where a sliver of the sign reads as nothing, was dropped, leaving a quarter of the name (bench, 21-nov). Only
 * text of two words or more, a sign that can be wide: a plate or a house number fits in one cell.
 */
const continues = (c: PhotoClue, all: PhotoClue[]) =>
  c.read === false && wide(c) &&
  all.some((v) => v.read === true && besides(v.cell).includes(c.cell) && similar(v, c)) &&
  !readWhole(c, all);

/** Capital letters standing alone, as on a sign: "W 4 St" → W. */
const capitals = (s: string) => (s.match(/(?<![\p{L}\p{N}])\p{Lu}(?![\p{L}\p{N}])/gu) ?? []).map(plain).filter((t) => !GENERIC.has(t));

/**
 * Every word of the sign was read in some cell that shows it (by default, a cell where the sign was read): nothing of it
 * is left for another cell. A lone capital counts: "4 St" read in one cell left the "W" in the cell beside it (bench, New
 * York, 21-nov).
 */
function readWhole(c: PhotoClue, all: PhotoClue[], shows = (v: PhotoClue) => v.read === true): boolean {
  const seen = all.filter((v) => shows(v) && similar(v, c)).flatMap((v) => (v.seen ?? []).flatMap((s) => [...tokensOf(s), ...capitals(s)]));
  const words = signWords(c.what);
  return words.length > 0 && words.every((w) => seen.some((g) => alike(g, w)));
}

/** Every name a clue says can be read was read in that cell (not just one word the two share, like "Verdi"). */
const namesReadIn = (c: PhotoClue, v: PhotoClue) => {
  const seen = (v.seen ?? []).flatMap(tokensOf);
  return namesIn(c.what).every((w) => seen.some((g) => alike(g, w)));
};

/** How many words of its clue were read in the cell: of two cells of one sign, the one that shows more is hidden first. */
const wordsRead = (c: PhotoClue) => {
  const seen = (c.seen ?? []).flatMap(tokensOf);
  return new Set([...wordsIn(c.what), ...namesIn(c.what)].filter((w) => seen.some((g) => alike(g, w)))).size;
};

/** A sign of two words or more: it can be wider than a cell (a plate or a house number fits in one). */
const wide = (c: PhotoClue) => (c.kind === 'text' || c.kind === 'landmark') && signWords(c.what).filter((w) => w.length > 1 || /\d/.test(w)).length >= 2;

/**
 * The words of a sign, as a person reads them: names, numbers, lone capitals, and short words too. "RUA DAS FLORES" read as
 * "RUA FLORES" in one cell and "DAS R" in the cell beside it is not read whole: its "DAS" is in the other cell, which was
 * dropped, and half the sign stayed sharp (photo bench, Lisbon, 23-nov).
 */
const signWords = (what: string) =>
  [...new Set([...wordsIn(what), ...namesIn(what), ...capitals(what), ...tokensOf(what).filter((t) => t.length === 3 && !/\d/.test(t))])];

/** At most this many cells are read up close in a photo (about 1–2 s each on a laptop's GPU). */
const MAX_READS = 10;
/** And at most this many more, around a clue the scans put in the wrong cell or a sign read in part. */
const MAX_EXTRA = 6;

/** The cells to the left and to the right of a cell, in its row. */
const besides = (cell: number) => {
  const k = (cell - 1) % GRID;
  return [k > 0 ? cell - 1 : 0, k < GRID - 1 ? cell + 1 : 0].filter(Boolean);
};

/** The cells around a cell: beside it, then above and below it. */
const neighbours = (cell: number) => [...besides(cell), cell - GRID, cell + GRID].filter((c) => c >= 1 && c <= GRID * GRID);

/** A number with nothing around it that says it is an address or a plate: "15" on a café table, "0" in a park (bench). */
const bareNumber = (c: PhotoClue) =>
  (c.kind === 'number' && !ADDRESS.test(c.what) && !/\b(house|door|building|plate|address|no\.?)\b/i.test(c.what)) ||
  // A "vehicle plate (partially obscured)" with no character given, where nothing like a plate was read (bench, Tokyo).
  (c.kind === 'plate' && !/\d/.test(c.what));

/** Kinds of clue that can carry an identifier a person can look up (an address, a plate), not just hints. */
const READABLE = new Set(['text', 'number', 'plate']);
// Text counts only when it is an address (or a phone number). Live (16-nov): Tokyo shop signs ("ramen", "sake shop")
// made the attacker "read your address" while it guessed Kyoto, 360 km off. A generic shop sign is a hint, not an address.
// "W 4 St" is an address too (bench, 21-nov): the short forms count.
const ADDRESS =
  /\b(street|st|road|rd|avenue|ave|boulevard|blvd|lane|alley|square|plaza|piazza|rua|rue|calle|carrer|avenida|avinguda|pla[cç]a|pra[cç]a|via|strasse|straße|platz|gracht|address|postcode|post code|zip code|postal|phone|chome|banchi)\b|丁目|番地/i;
// A number is a house number, a plate or a phone until the attacker says it is something else.
const NOT_AN_ID = /\b(price|bus|route|line|time|clock|date|year|speed|platform|floor|menu|table|seat|page|size|score|jersey|shirt|order|ticket|receipt|counter)\b/i;

/** Does this clue carry an identifier a person could look up anywhere: a street name, a house number, a plate? */
export function isIdentifier(c: PhotoClue): boolean {
  if (!READABLE.has(c.kind)) return false;
  const what = String(c.what ?? '');
  // A plate is one if it can be read, or is called a plate: a "plate" that is a tooth or an earring is not (bench).
  if (c.kind === 'plate') return readsSomething(what) || /\b(plate|registration)\b/i.test(what);
  if (c.kind === 'number') return (/\d/.test(what) || /\bnumber\b/i.test(what)) && (!NOT_AN_ID.test(what) || ADDRESS.test(what));
  return ADDRESS.test(what);
}

/**
 * 0: an identifier (always hidden); 1: a specific clue with something to read or a named place (hidden within the
 * budget); 2: the rest, which says the city at most (facades, trees, a tram, "a menu"), and is left alone.
 */
const rankOf = (c: PhotoClue) => {
  if (isIdentifier(c)) return 0;
  if (READABLE.has(c.kind)) return readsSomething(c.what) ? 1 : 2;
  if (SPECIFIC.has(c.kind)) return namesSomething(c.what) ? 1 : 2;
  return 2;
};

/**
 * Why a verdict counts as exposure:
 *  - 'readable': the attacker read an identifier (street name, house number, plate) and is not unsure. Even if it picked
 *    the wrong city, a human would search that address everywhere. This holds with or without ground truth.
 *  - 'near': with the user's real location, the guess landed within the safe distance.
 *  - 'precise': without ground truth, the attacker claims a small radius and is not unsure.
 */
export type ExposureReason = 'readable' | 'near' | 'precise';

/** Without your real location, a guess this tight (a city, a region) may be right, and nothing can check it. */
const UNCHECKED_CITY_KM = 250;

/**
 * Red, amber or green, for the user:
 *  - 'street' (red): an identifier anyone can look up, or a guess within `streetRadiusKm` of you.
 *  - 'city' (amber): it knows your city, not your street. Fine unless your city is the secret. Without your real
 *    location, also any city it names: it may be right, and nothing on the device can tell.
 *  - 'safe' (green): the wrong place, or too unsure to say.
 * Only red keeps the red-team loop going. Measured with realistic test photos (16-nov): masking cells took the attacker
 * from your address to your city, but a scene full of local cues still says "Lisbon" with half of it masked, and a
 * low-confidence "Tokyo" is a city of 14 million people, not where you are.
 */
export type LocationTier = 'street' | 'city' | 'safe';

export function locationThreat(o: LocationOptions): Threat<Uint8Array, PhotoClue, LocationVerdict> & {
  masked: number[];
  regions: MaskRegion[];
  maskedShare: number;
  clueShare: number;
  /** Flagged clues left visible: the budget was spent on more specific ones, or the clue's cell is all face. */
  leftVisible: PhotoClue[];
  maxShare: number;
  faces: Rect[];
  /** Blur the faces too (off unless you ask). */
  blurFaces: boolean;
  setBlurFaces(input: Private<Uint8Array>, on: boolean, kit: Kit): Promise<Publishable<Uint8Array> | null>;
  hideCells(input: Private<Uint8Array>, cells: number[], kit: Kit): Promise<Publishable<Uint8Array>>;
  toggleCells(input: Private<Uint8Array>, cells: number[], kit: Kit): Promise<Publishable<Uint8Array>>;
  exposureReason(v: LocationVerdict): ExposureReason | null;
  tier(v: LocationVerdict): LocationTier;
} {
  const safeRadiusKm = o.safeRadiusKm ?? 50;
  const streetRadiusKm = o.streetRadiusKm ?? 1;
  let photoSize: { width: number; height: number } | null = null;
  /** The faces of this photo, found once: the search starts with the scan, so blurring does not wait for it. */
  let faces: Promise<Rect[]> | null = null;
  /** Cells already hidden: hiding them again adds nothing. */
  const hiddenCells = new Set<number>();
  // Cells hidden only in part (the `tight` option): if the attacker still names one, the whole cell is hidden next time.
  const narrowedCells = new Set<number>();
  // What each hidden cell counts against the budget: the cell itself around the faces, not its edge (EDGE), which only
  // makes sure what sits on a cell's line is hidden whole. With the edge counted, Paris and Tokyo lost a clue to the budget.
  const cellCores = new Map<number, Rect[]>();
  const coresNow = () => [...cellCores.values()].flat();

  /**
   * The faces, from the on-device detector (MediaPipe). On the photo bench (21-nov) Gemini Nano's own idea of where people
   * were missed faces in 4 of 7 photos; the detector boxes each face. If it cannot run, the photo is still masked, and the
   * ledger says faces were not protected.
   */
  function facesIn(png: Uint8Array, kit: Kit): Promise<Rect[]> {
    faces ??= (async () => {
      const t0 = performance.now();
      const op = 'Find faces (MediaPipe, on the device)';
      try {
        const found = await o.ops.faces(png);
        threat.faces = found;
        const n = found.length;
        kit.ledger.add({ op, route: 'local-js', ms: Math.round(performance.now() - t0), bytesOut: 0, note: n ? `${n} ${n === 1 ? 'face' : 'faces'} · never hidden` : 'no face found' });
        return found;
      } catch (e) {
        const why = String((e as Error)?.message ?? e).slice(0, 80);
        kit.ledger.add({ op, route: 'local-js', ms: Math.round(performance.now() - t0), bytesOut: 0, note: `could not run (${why}) · faces not protected` });
        return [];
      }
    })();
    return faces;
  }

  /**
   * Gemini Nano reads one cell alone, close up: reading is what it does well, saying where things are is not (bench,
   * 21-nov). A cell where it reads nothing the clue names is most likely the wrong cell. Null when its answer is unreadable.
   */
  async function readCell(png: Uint8Array, cell: number, clue: PhotoClue, kit: Kit): Promise<{ read: boolean | null; seen: string[] }> {
    const square = gridSquare(cell, GRID, { x: 0, y: 0, w: photoSize!.width, h: photoSize!.height });
    const closeUp = new Private(await o.ops.crop(png, square), 'one cell of the photo');
    const res = await kit.local.generate(
      [
        `Write every piece of text you can read in this picture (cell ${cell} of a photo), exactly as it is written. ` +
          'If there is none, give an empty list.',
        { image: closeUp, mime: 'image/png' },
      ],
      { json: true, schema: READ_SCHEMA, op: `Read the text in cell ${cell}` },
    );
    try {
      const seen = listAt(parseModelJsonLenient(res.text).value, 'texts').map(String).filter((t) => t.trim());
      return { read: readMatches(seen, clue.what), seen };
    } catch (e) {
      if (e instanceof ModelJsonError) return { read: null, seen: [] };
      throw e;
    }
  }

  /**
   * Where in a cell the clue's text is (the `tight` option): the cell's four overlapping quarters (60% of its width and
   * height each), read close up; the quarters that read the clue, joined and padded by a quarter of their size, within the
   * cell. Null when no quarter reads it or all of them do (the recorded demo, which answers per cell): the whole cell then.
   */
  async function tighten(png: Uint8Array, cell: number, clue: PhotoClue, kit: Kit): Promise<Rect | null> {
    const square = gridSquare(cell, GRID, { x: 0, y: 0, w: photoSize!.width, h: photoSize!.height });
    const qw = Math.round(square.w * 0.6);
    const qh = Math.round(square.h * 0.6);
    const quarters: Rect[] = [
      { x: square.x, y: square.y, w: qw, h: qh },
      { x: square.x + square.w - qw, y: square.y, w: qw, h: qh },
      { x: square.x, y: square.y + square.h - qh, w: qw, h: qh },
      { x: square.x + square.w - qw, y: square.y + square.h - qh, w: qw, h: qh },
    ];
    const hits: Rect[] = [];
    for (const [i, q] of quarters.entries()) {
      const closeUp = new Private(await o.ops.crop(png, q), 'part of one cell of the photo');
      const res = await kit.local.generate(
        [
          `Write every piece of text you can read in this picture (part ${i + 1} of cell ${cell} of a photo), exactly as it is written. ` +
            'If there is none, give an empty list.',
          { image: closeUp, mime: 'image/png' },
        ],
        { json: true, schema: READ_SCHEMA, op: `Read part ${i + 1} of cell ${cell}` },
      );
      try {
        const seen = listAt(parseModelJsonLenient(res.text).value, 'texts').map(String).filter((t) => t.trim());
        if (readMatches(seen, clue.what)) hits.push(q);
      } catch (e) {
        if (!(e instanceof ModelJsonError)) throw e;
        return null; // an unreadable answer: the whole cell, to be safe
      }
    }
    if (hits.length === 0 || hits.length === quarters.length) return null;
    const x0 = Math.min(...hits.map((r) => r.x));
    const y0 = Math.min(...hits.map((r) => r.y));
    const x1 = Math.max(...hits.map((r) => r.x + r.w));
    const y1 = Math.max(...hits.map((r) => r.y + r.h));
    // Padded by a quarter of the box on every side, and kept inside the cell.
    const px = Math.round((x1 - x0) * 0.25);
    const py = Math.round((y1 - y0) * 0.25);
    const left = Math.max(square.x, x0 - px);
    const top = Math.max(square.y, y0 - py);
    const right = Math.min(square.x + square.w, x1 + px);
    const bottom = Math.min(square.y + square.h, y1 + py);
    return { x: left, y: top, w: right - left, h: bottom - top };
  }

  /** Adds what to hide, paints it on the photo, records it, and returns the masked photo, released. */
  async function hide(png: Uint8Array, fresh: MaskRegion[], left: PhotoClue[], kit: Kit, op: string): Promise<Publishable<Uint8Array>> {
    const whole = { x: 0, y: 0, w: photoSize!.width, h: photoSize!.height };
    const t0 = performance.now();
    threat.regions = [...threat.regions, ...fresh];
    // The faces, only if you asked: a layer of their own over the cells, never counted against the budget (22-nov).
    const faceLayer: MaskRegion[] = threat.blurFaces
      ? (await facesIn(png, kit)).map((rect) => ({ rect: grown(rect, whole), style: 'blur' as const, cell: 0, what: 'a face, by your choice' }))
      : [];
    const painted = [...threat.regions, ...faceLayer];
    threat.maskedShare = coverage(painted.map((g) => g.rect), whole);
    threat.clueShare = coverage(coresNow(), whole);
    // The cells hidden on purpose, not the cells around them that a hidden cell's edge (EDGE) reaches into.
    threat.masked = [...new Set(threat.regions.map((g) => g.cell).filter((c) => c > 0))].sort((a, b) => a - b);
    threat.leftVisible = left.sort((a, b) => a.cell - b.cell);
    const masked = await o.ops.paint(png, painted);
    const kept = left.length ? ` · kept ${left.length} ${left.length === 1 ? 'clue' : 'clues'} visible: all face, or past the budget` : '';
    const faced = faceLayer.length ? ` · ${faceLayer.length} ${faceLayer.length === 1 ? 'face' : 'faces'} blurred, by your choice` : '';
    kit.ledger.add({ op, route: 'local-js', ms: Math.round(performance.now() - t0), bytesOut: 0, note: `${Math.round(threat.maskedShare * 100)}% of the photo${kept}${faced}` });
    // release() refuses bytes identical to the private original.
    return release(masked, `masked cells ${threat.masked.join(',')}`);
  }

  /** How much of a cell is hidden. */
  const cellCovered = (cell: number) =>
    photoSize ? coverage(threat.regions.map((g) => g.rect), gridSquare(cell, GRID, { x: 0, y: 0, w: photoSize.width, h: photoSize.height })) : 0;

  const threat = {
    id: 'location',
    question: 'Where was this photo taken?',
    /** Cells with something hidden in them, so far (for the UI and the attacker's prompt). */
    masked: [] as number[],
    /** What is hidden, so far: every round adds to it. */
    regions: [] as MaskRegion[],
    /** The share of the photo hidden, 0–1, faces included when you blur them. */
    maskedShare: 0,
    /** The share hidden for clues only: what the budget counts (your faces never do). */
    clueShare: 0,
    leftVisible: [] as PhotoClue[],
    maxShare: o.maxMaskedShare ?? 0.25,
    /** The faces found in the photo (whole heads), once it has been masked. */
    faces: [] as Rect[],
    /** Blur the faces too: off unless you ask (the point is to post your photo, minus where it was taken). */
    blurFaces: o.blurFaces ?? false,

    async findClues(input: Private<Uint8Array>, kit: Kit): Promise<PhotoClue[]> {
      // The faces are looked for on the CPU while Gemini Nano scans on the GPU: blurring then does not wait for them.
      void facesIn(Private.openLocally(input), kit);
      // The grid copy is derived from the private photo, so it is private too.
      const gridded = new Private(await o.ops.withGrid(Private.openLocally(input), GRID), 'photo with grid');
      const scans = Math.max(1, o.scans ?? 2);
      const byCell = new Map<number, PhotoClue>();
      // How many scans flagged a cell with a clue worth reading: where they agree is read first.
      const votes = new Map<number, number>();
      let readable = 0;
      for (let i = 0; i < scans; i++) {
        const res = await kit.local.generate(
          [
            `This photo has a ${GRID}×${GRID} grid drawn on it, cells numbered 1–${GRID * GRID} from left to right, top to bottom. ` +
              'List every cell that could reveal where the photo was taken: readable text (street names, shop signs), house numbers, ' +
              'landmarks, vehicle plates, distinctive vegetation or architecture, reflections. ' +
              'Do not list people, faces or bodies: only things that reveal the place. ' +
              'Return JSON {"clues":[{"cell":<number>,"kind":"text|number|landmark|plate|vegetation|architecture|reflection","what":"short description"}]}.',
            { image: gridded, mime: 'image/png' },
          ],
          { json: true, schema: CLUES_SCHEMA, op: `Find location clues (scan ${i + 1}/${scans})` },
        );
        // An unreadable scan is skipped: the other scans still count (the answers are merged anyway).
        let parsed: unknown;
        try {
          parsed = parseModelJsonLenient(res.text).value;
          readable++;
        } catch (e) {
          if (e instanceof ModelJsonError) continue;
          throw e;
        }
        // Union of the scans: a cell flagged by any scan gets masked (the safe direction), with its most specific clue
        // (a "street sign" in a cell an earlier scan called "facade" must not be left visible by the budget). People are
        // not location clues: pixelating the user's own face would defeat the point of posting a selfie.
        const flagged = new Set<number>();
        for (const raw of listAt(parsed, 'clues')) {
          const c = normaliseClue(raw);
          if (!c || !meaningful(c)) continue;
          const prev = byCell.get(c.cell);
          if (!prev || rankOf(c) < rankOf(prev)) byCell.set(c.cell, c);
          if (rankOf(c) < 2) flagged.add(c.cell);
        }
        for (const cell of flagged) votes.set(cell, (votes.get(cell) ?? 0) + 1);
      }
      if (!readable) throw new Error('Gemini Nano gave no answer it could read about this photo. Scan it again');
      const png = Private.openLocally(input);
      photoSize ??= await o.ops.size(png);
      // Every clue that would be hidden is read up close first, a landmark with a name too: in one scan Gemini Nano put
      // "HARAKUJO STATION" as a landmark in all sixteen cells, and "Cafe Verdi storefront" in three wrong ones (bench).
      // Identifiers first, then the cells the scans agree on; at most MAX_READS, so a photo takes seconds, not minutes.
      const toRead = [...byCell.values()]
        .filter((c) => rankOf(c) < 2)
        .sort((a, b) => rankOf(a) - rankOf(b) || (votes.get(b.cell) ?? 0) - (votes.get(a.cell) ?? 0) || a.cell - b.cell)
        .slice(0, MAX_READS);
      const reads = new Map<number, { read: boolean | null; seen: string[] }>();
      for (const c of toRead) reads.set(c.cell, await readCell(png, c.cell, c, kit));
      // Not read (past the limit) counts as not read: an identifier is then hidden within the budget, the rest is left.
      const found: PhotoClue[] = [...byCell.values()].map((c) => {
        if (rankOf(c) === 2) return c;
        const r = reads.get(c.cell);
        if (!r) return { ...c, read: false };
        return r.read === null ? c : { ...c, read: r.read, seen: r.seen };
      });
      // The scans often put a clue a cell off: "27" a row below its sign and "Carrer de Verdi" beside its own, read nowhere;
      // and a sign read in part goes on in a cell around it: "HARAJUKU STATION" spans two cells, "BOULANGERIE MARTIN" was
      // put a row too low (bench, 21-nov). The cells around them are read up close until the clue is found or the sign read
      // whole: identifiers first, then signs read in part, then other text that names something to read.
      const shows = (v: PhotoClue) => v.read === true || continues(v, found);
      const done = new Set<PhotoClue>();
      // A clue read in another cell is found, unless only part of it was read there: "CAFE VERDI" and "Carrer de Verdi" share
      // "Verdi", and the café's own cell was never read (photo bench, Barcelona, 23-nov).
      const lost = (c: PhotoClue) =>
        c.read === false && READABLE.has(c.kind) && rankOf(c) < 2 && namesIn(c.what).length > 0 && !done.has(c) &&
        !found.some((v) => v.read === true && sameThing(v, c) && namesReadIn(c, v));
      const partial = (c: PhotoClue) => c.read === true && wide(c) && !readWhole(c, found, shows);
      const byVotes = (a: PhotoClue, b: PhotoClue) => (votes.get(b.cell) ?? 0) - (votes.get(a.cell) ?? 0) || a.cell - b.cell;
      const queue = [
        ...found.filter((c) => rankOf(c) === 0 && lost(c)).sort(byVotes),
        ...found.filter(partial),
        ...found.filter((c) => rankOf(c) === 1 && lost(c)).sort(byVotes),
      ];
      let extra = 0;
      for (let q = 0; q < queue.length && extra < MAX_EXTRA; q++) {
        const c = queue[q];
        for (const cell of neighbours(c.cell)) {
          if (extra >= MAX_EXTRA || !(lost(c) || partial(c))) break;
          // A cell where this sign was read already is done; one where another sign was read may hold this one too.
          // (Each clue is found in a cell once: two cells of one sign would otherwise send it back and forth.)
          if (found.some((k) => k.cell === cell && k.read === true && (k.what === c.what || namesReadIn(c, k)))) continue;
          let r = reads.get(cell);
          if (!r) {
            extra++;
            r = await readCell(png, cell, c, kit);
            reads.set(cell, r);
          } else if (r.read !== null) {
            // Read already, for another clue: it may show this one.
            r = { read: readMatches(r.seen, c.what), seen: r.seen };
          }
          if (r.read !== true) continue;
          // What was put in that cell and not read there goes; a sign read there stays (two signs can share a cell).
          const i = found.findIndex((k) => k.cell === cell && k.read !== true);
          if (i >= 0) found.splice(i, 1);
          const hit = { ...c, cell, read: true, seen: r.seen };
          found.push(hit);
          queue.push(hit);
          done.add(c);
          // The same sign, put in other cells by the scans, is found too: no more reads around them.
          for (const k of found) if (k !== c && k.read === false && sameThing(k, hit) && namesReadIn(k, hit)) done.add(k);
        }
      }
      // What Gemini Nano could not read in its cell goes, unless it is the rest of a sign read in the cell next to it, or
      // an address or a plate it read nowhere else (kept, and hidden within the budget: the attacker may read it better).
      return found.filter((c) => c.read !== false || continues(c, found) || (rankOf(c) === 0 && !misplaced(c, found) && !bareNumber(c)));
    },

    async sanitize(input: Private<Uint8Array>, clues: PhotoClue[], feedback: LocationVerdict | null, kit: Kit): Promise<Publishable<Uint8Array>> {
      const png = Private.openLocally(input);
      photoSize ??= await o.ops.size(png);
      const whole = { x: 0, y: 0, w: photoSize.width, h: photoSize.height };
      // What to hide: the scan's clues, and the clues the attacker says it used. Ranked: identifiers first (always hidden),
      // then specific clues (a shop sign, a landmark), the attacker's first within a rank. People are never a clue, and
      // facades or trees, which say the city and not the street, are left alone: masking them, and adding every cell the
      // attacker named round after round, covered whole photos (21-nov review).
      const best = new Map<number, { rank: number; cited: boolean; clue: PhotoClue }>();
      const consider = (raw: PhotoClue, cited: boolean) => {
        const c = normaliseClue(raw);
        if (!c || !meaningful(c) || rankOf(c) === 2) return;
        // What the scan read up close stays with the clue; the attacker's clues are read here, never taken on its word.
        if (!cited && typeof raw.read === 'boolean') {
          c.read = raw.read;
          c.seen = raw.seen;
        }
        if (hiddenCells.has(c.cell) && !(cited && narrowedCells.has(c.cell))) return;
        const prev = best.get(c.cell);
        const r = rankOf(c);
        if (!prev || r < prev.rank || (cited && !prev.cited)) best.set(c.cell, { rank: Math.min(r, prev?.rank ?? r), cited: cited || !!prev?.cited, clue: c });
      };
      for (const c of clues) consider(c, false);
      for (const c of feedback?.clues ?? []) consider(c, true);
      const facesToBlur = threat.blurFaces ? (await facesIn(png, kit)).length : 0;
      if (!best.size && !threat.regions.length && !facesToBlur) {
        // Masking nothing would re-encode the original, and release() would (rightly) refuse it as the private photo.
        throw new Error('Nothing to mask: no cell of this photo was flagged as a location clue. If you would post it as it is, attack it as it is');
      }
      for (const entry of best.values()) {
        if (entry.clue.read === undefined) {
          const r = await readCell(png, entry.clue.cell, entry.clue, kit);
          if (r.read !== null) entry.clue = { ...entry.clue, read: r.read, seen: r.seen };
        }
      }
      // Read (or nothing to read): identifiers always hidden (0), other clues within the budget (1). Not read: an identifier
      // within the budget, last (2), unless it was read in another cell; anything else is not hidden (3).
      const all = [...best.values()].map((e) => e.clue);
      const tier = ({ rank, clue }: { rank: number; clue: PhotoClue }) =>
        clue.read !== false || continues(clue, all) ? (rank === 0 ? 0 : 1) : rank === 0 && !misplaced(clue, all) && !bareNumber(clue) ? 2 : 3;
      const ranked = [...best.entries()]
        .filter(([, e]) => tier(e) < 3)
        .sort(([, a], [, b]) => tier(a) - tier(b) || a.rank - b.rank || Number(b.cited) - Number(a.cited) || wordsRead(b.clue) - wordsRead(a.clue));
      const around = await facesIn(png, kit);
      const left: PhotoClue[] = [];
      let fresh: MaskRegion[] = [];
      for (const [cell, entry] of ranked) {
        const { clue } = entry;
        const always = tier(entry) === 0;
        // The clue's cell and its edge (EDGE), cut around every face: a whole cell is what Gemini Nano can point at reliably. With `tight`,
        // an identifier read in its cell is narrowed to the part of the cell that reads it (see tighten).
        const narrowed = o.tight && clue.read === true && isIdentifier(clue) && !narrowedCells.has(cell) ? await tighten(png, cell, clue, kit) : null;
        const pieces = cutAround(narrowed ?? cellArea(cell, GRID, whole), around);
        const core = narrowed ? pieces : cutAround(gridSquare(cell, GRID, whole), around);
        if (!pieces.length || !core.length) {
          left.push(clue);
          continue;
        }
        const regions = pieces.map((rect) => ({ rect, style: 'blur' as const, cell, what: clue.what }));
        const share = coverage([...coresNow(), ...core], whole);
        if (!always && share > threat.maxShare + 1e-9) {
          left.push(clue);
          continue;
        }
        fresh = [...fresh, ...regions];
        cellCores.set(cell, core);
        hiddenCells.add(cell);
        if (narrowed) narrowedCells.add(cell);
        else narrowedCells.delete(cell);
      }
      if (!fresh.length && !threat.regions.length && !facesToBlur) {
        throw new Error('Nothing to mask: what was flagged in this photo is all face. If you would post it as it is, attack it as it is');
      }
      const count = new Set(fresh.map((g) => g.cell)).size;
      return hide(png, fresh, left, kit, `Hide ${count} ${count === 1 ? 'clue' : 'clues'} in the photo, around the faces`);
    },

    /** Cells a person picked by hand (no local model): hidden the same way, around the faces, with no budget. */
    async hideCells(input: Private<Uint8Array>, cells: number[], kit: Kit): Promise<Publishable<Uint8Array>> {
      const png = Private.openLocally(input);
      photoSize ??= await o.ops.size(png);
      const whole = { x: 0, y: 0, w: photoSize.width, h: photoSize.height };
      const around = await facesIn(png, kit);
      const chosen = [...new Set(cells)].filter((c) => validCell(c) && !hiddenCells.has(c));
      const fresh: MaskRegion[] = [];
      for (const cell of chosen) {
        fresh.push(...cutAround(cellArea(cell, GRID, whole), around).map((rect) => ({ rect, style: 'blur' as const, cell, what: 'chosen by you' })));
        cellCores.set(cell, cutAround(gridSquare(cell, GRID, whole), around));
        hiddenCells.add(cell);
      }
      if (!fresh.length && !threat.regions.length) throw new Error('Nothing to mask: tap the cells you want to hide first');
      return hide(png, fresh, [], kit, `Hide ${chosen.length} ${chosen.length === 1 ? 'cell' : 'cells'} you chose, around the faces`);
    },

    /**
     * One tap per cell on a photo already masked: a hidden cell is shown again, any other is hidden (around the faces), and
     * the mask is painted again from the private original. Masking could not be undone before (21-nov plan).
     */
    async toggleCells(input: Private<Uint8Array>, cells: number[], kit: Kit): Promise<Publishable<Uint8Array>> {
      const png = Private.openLocally(input);
      photoSize ??= await o.ops.size(png);
      const whole = { x: 0, y: 0, w: photoSize.width, h: photoSize.height };
      const chosen = [...new Set(cells)].filter(validCell);
      const show = chosen.filter((c) => threat.masked.includes(c) || hiddenCells.has(c));
      const add = chosen.filter((c) => !show.includes(c));
      const kept = threat.regions.filter((g) => !show.includes(g.cell));
      // Showing every cell again would leave the original, which release() rightly refuses: say what to do instead.
      if (!kept.length && !add.length) throw new Error('Nothing would stay hidden: if you would post the photo as it is, attack it as it is');
      const around = await facesIn(png, kit);
      threat.regions = kept;
      for (const c of show) {
        hiddenCells.delete(c);
        cellCores.delete(c);
      }
      const fresh: MaskRegion[] = [];
      for (const cell of add) {
        fresh.push(...cutAround(cellArea(cell, GRID, whole), around).map((rect) => ({ rect, style: 'blur' as const, cell, what: 'chosen by you' })));
        cellCores.set(cell, cutAround(gridSquare(cell, GRID, whole), around));
        hiddenCells.add(cell);
      }
      const did = [add.length && `hide ${add.length === 1 ? `cell ${add[0]}` : `${add.length} cells`}`, show.length && `show ${show.length === 1 ? `cell ${show[0]}` : `${show.length} cells`} again`].filter(Boolean);
      const op = `${did.join(' and ').replace(/^./, (ch) => ch.toUpperCase())}, around the faces`;
      return hide(png, fresh, threat.leftVisible.filter((c) => !hiddenCells.has(c.cell)), kit, op);
    },

    /**
     * Blur the faces too, or show them again. Before anything is blurred it only sets the choice (the next blur paints it);
     * after, the photo is painted again from the private original, and null means there is nothing to paint yet.
     */
    async setBlurFaces(input: Private<Uint8Array>, on: boolean, kit: Kit): Promise<Publishable<Uint8Array> | null> {
      threat.blurFaces = on;
      if (!threat.regions.length) return null;
      const png = Private.openLocally(input);
      photoSize ??= await o.ops.size(png);
      return hide(png, [], threat.leftVisible, kit, on ? 'Blur the faces too, by your choice' : 'Show the faces again');
    },

    async attack(published: Publishable<Uint8Array>, kit: Kit): Promise<LocationVerdict> {
      // The overlay is derived from the released photo only; it inherits the user's as-is confirmation if there was one.
      // JPEG, not PNG: a phone photo went up as 1–2 MB of PNG for each attack; as JPEG it is about a tenth, and the grid and
      // its numbers read the same.
      const gridded = release(await o.ops.withGrid(published.value, GRID, 'image/jpeg'), 'grid overlay of a released photo', {
        userConfirmedAsIs: published.confirmedAsIs,
      });
      const ask = (op: string) =>
        kit.cloud.generate(
          [
            'You are an OSINT geolocation analyst. Estimate where this photo was taken, as precisely as the evidence allows. ' +
              `It has a ${GRID}×${GRID} numbered grid, cells numbered 1–${GRID * GRID} from left to right, top to bottom. ` +
              'Grey boxes, blurred patches and pixelated cells were masked on purpose: there is nothing to read under them. ' +
              `Masked cells: ${threat.masked.length ? threat.masked.join(', ') : 'none'}. ` +
              'Give your best guess as a place name and coordinates. ' +
              'Return JSON {"place":"best guess","lat":<number>,"lon":<number>,"radiusKm":<number, radius of your uncertainty>,"confidence":"low|medium|high",' +
              '"clues":[{"cell":<number>,"kind":"...","what":"what in that cell helped you"}]}.',
            { image: gridded, mime: 'image/jpeg' },
          ],
          { json: true, schema: GEO_SCHEMA, op },
        );
      // One unreadable answer gets one more try. A cut-off answer is not "repaired": missing coordinates would read as
      // "no guess", and no guess scores as safe.
      let v: { place?: unknown; lat?: unknown; lon?: unknown; radiusKm?: unknown; confidence?: unknown; clues?: unknown };
      try {
        v = parseModelJson((await ask('Geolocation attack')).text);
      } catch (e) {
        if (!(e instanceof ModelJsonError)) throw e;
        v = parseModelJson((await ask('Geolocation attack (again: unreadable answer)')).text);
      }
      v = v && typeof v === 'object' ? v : {};
      // "Unknown" at 0,0 is no guess at all, not a guess 4,500 km off (measured live, 16-nov). Note Number(null) is 0.
      const noGuess = /^\s*(unknown|unclear|undetermined|none|n\/a|not sure|cannot|unable)/i.test(String(v.place ?? 'unknown'));
      const latN = v.lat === null ? null : toNumber(v.lat);
      const lonN = v.lon === null ? null : toNumber(v.lon);
      // A named place with no usable coordinates (missing, 0,0, out of range) is scored on the attacker's own claim
      // (radius and confidence) instead of being called "no guess": out-of-range coordinates used to give a NaN distance,
      // and NaN scored as safe.
      const coordsOk = !noGuess && latN !== null && lonN !== null && Math.abs(latN) <= 90 && Math.abs(lonN) <= 180 && !(latN === 0 && lonN === 0);
      const lat = coordsOk ? latN : null;
      const lon = coordsOk ? lonN : null;
      // Scored on the device: the user's real location never leaves it.
      const errorKm = o.truth && lat !== null && lon !== null ? distanceKm({ lat, lon }, Private.openLocally(o.truth)) : null;
      const radius = toNumber(v.radiusKm);
      return {
        place: noGuess ? 'unknown' : String(v.place),
        lat,
        lon,
        radiusKm: !noGuess && radius !== null && radius > 0 ? radius : 20000,
        confidence: normaliseConfidence(v.confidence),
        // A clue in a cell that is hidden is not one; a cell partly hidden may still show what the attacker used.
        clues: listAt(v, 'clues')
          .map(normaliseClue)
          .filter((c): c is PhotoClue => !!c && !(threat.regions.length ? cellCovered(c.cell) > 0.9 : threat.masked.includes(c.cell))),
        errorKm,
      };
    },

    exposureReason(v: LocationVerdict): ExposureReason | null {
      const sure = v.confidence !== 'low';
      if (sure && v.clues.some(isIdentifier)) return 'readable';
      if (v.errorKm !== null) return v.errorKm < safeRadiusKm ? 'near' : null;
      return sure && v.radiusKm < safeRadiusKm ? 'precise' : null;
    },

    tier(v: LocationVerdict): LocationTier {
      const reason = threat.exposureReason(v);
      // Without your real location, a city it names cannot be checked against where you are: however unsure it says it
      // is, that is never called safe (live, 22-nov: "Madrid, Spain, low confidence" was close, and the app said safe).
      if (!reason) return !o.truth && v.lat !== null && v.radiusKm <= UNCHECKED_CITY_KM ? 'city' : 'safe';
      if (reason === 'readable') return 'street';
      const km = reason === 'near' ? (v.errorKm as number) : v.radiusKm;
      return km < streetRadiusKm ? 'street' : 'city';
    },

    exposed(v: LocationVerdict) {
      // A confident WRONG guess is not exposure, unless it rests on an identifier anyone could look up. Knowing your
      // city (amber) is reported, but does not keep the loop masking: cells rarely hide a city.
      return threat.tier(v) === 'street';
    },
  };
  return threat;
}
