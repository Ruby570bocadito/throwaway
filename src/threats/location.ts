// Threat: "where was this photo taken?" — visual geolocation of a photo you want to post.
// Local: Gemini Nano looks at the private photo (with a numbered grid drawn on it) and lists the cells that give your
// location away; the cells are pixelated on the device.
// Cloud: a geolocation attacker gets ONLY the released (masked) photo and estimates where it was taken and how precisely.
// If it can still narrow you down, it says which cells helped, and the loop masks those too.

import { parseModelJson, Private, release, type JsonSchema, type Kit, type Publishable, type Threat } from '../framework';

export const GRID = 4; // 4×4 cells, numbered 1–16 left to right, top to bottom

export interface ImageOps {
  /** Draws the numbered grid on a copy (set-of-mark prompting), so models can point at cells. */
  withGrid(png: Uint8Array, n: number): Promise<Uint8Array>;
  /** Pixelates the given cells. */
  maskCells(png: Uint8Array, cells: number[], n: number): Promise<Uint8Array>;
}

export interface PhotoClue {
  cell: number;
  kind: string;
  what: string;
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
   * How many of the 16 cells masking may cover, so the photo stays worth posting. Identifiers (street names, house numbers,
   * plates) are masked even beyond it. Live (16-nov): on a Paris street Gemini Nano flagged facades in every cell and the
   * union of its clues and the attacker's pixelated the whole photo.
   */
  maxMaskedCells?: number;
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
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

const validCell = (c: unknown): c is number => Number.isInteger(c) && (c as number) >= 1 && (c as number) <= GRID * GRID;

const PERSON = /\b(person|people|face|faces|body|shoulder|selfie|human)\b/i;

/** Kinds of clue that can carry an identifier a person can look up (an address, a plate), not just hints. */
const READABLE = new Set(['text', 'number', 'plate']);
// Text counts only when it is an address (or a phone number). Live (16-nov): Tokyo shop signs ("ramen", "sake shop")
// made the attacker "read your address" while it guessed Kyoto, 360 km off. A generic shop sign is a hint, not an address.
const ADDRESS =
  /\b(street|road|avenue|boulevard|lane|alley|square|plaza|piazza|rua|rue|calle|carrer|avenida|avinguda|pla[cç]a|pra[cç]a|via|strasse|straße|platz|address|postcode|post code|zip code|postal|phone|chome|banchi)\b|丁目|番地/i;
// A number is a house number, a plate or a phone until the attacker says it is something else.
const NOT_AN_ID = /\b(price|bus|route|line|time|clock|date|year|speed|platform|floor|menu)\b/i;

/** Does this clue carry an identifier a person could look up anywhere: a street name, a house number, a plate? */
export function isIdentifier(c: PhotoClue): boolean {
  if (!READABLE.has(c.kind)) return false;
  if (c.kind === 'plate') return true;
  const what = String(c.what ?? '');
  if (c.kind === 'number') return !NOT_AN_ID.test(what) || ADDRESS.test(what);
  return ADDRESS.test(what);
}

/**
 * Why a verdict counts as exposure:
 *  - 'readable': the attacker read an identifier (street name, house number, plate) and is not unsure. Even if it picked
 *    the wrong city, a human would search that address everywhere. This holds with or without ground truth.
 *  - 'near': with the user's real location, the guess landed within the safe distance.
 *  - 'precise': without ground truth, the attacker claims a small radius and is not unsure.
 */
export type ExposureReason = 'readable' | 'near' | 'precise';

/**
 * Red, amber or green, for the user:
 *  - 'street' (red): an identifier anyone can look up, or a guess within `streetRadiusKm` of you.
 *  - 'city' (amber): it knows your city, not your street. Fine unless your city is the secret.
 *  - 'safe' (green): the wrong place, or too unsure to say.
 * Only red keeps the red-team loop going. Measured with realistic test photos (16-nov): masking cells took the attacker
 * from your address to your city, but a scene full of local cues still says "Lisbon" with half of it masked, and a
 * low-confidence "Tokyo" is a city of 14 million people, not where you are.
 */
export type LocationTier = 'street' | 'city' | 'safe';

export function locationThreat(o: LocationOptions): Threat<Uint8Array, PhotoClue, LocationVerdict> & {
  masked: number[];
  /** Flagged cells left unmasked to keep the photo usable (the budget was spent on more specific clues). */
  leftVisible: PhotoClue[];
  maxMasked: number;
  exposureReason(v: LocationVerdict): ExposureReason | null;
  tier(v: LocationVerdict): LocationTier;
} {
  const safeRadiusKm = o.safeRadiusKm ?? 50;
  const streetRadiusKm = o.streetRadiusKm ?? 1;
  const threat = {
    id: 'location',
    question: 'Where was this photo taken?',
    /** Cells masked so far (for the UI). */
    masked: [] as number[],
    leftVisible: [] as PhotoClue[],
    maxMasked: o.maxMaskedCells ?? 6,

    async findClues(input: Private<Uint8Array>, kit: Kit): Promise<PhotoClue[]> {
      // The grid copy is derived from the private photo, so it is private too.
      const gridded = new Private(await o.ops.withGrid(Private.openLocally(input), GRID), 'photo with grid');
      const scans = Math.max(1, o.scans ?? 2);
      const byCell = new Map<number, PhotoClue>();
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
        // Union of the scans: a cell flagged by any scan gets masked (the safe direction). People are not location clues:
        // pixelating the user's own face would defeat the point of posting a selfie.
        for (const c of parseModelJson<{ clues?: PhotoClue[] }>(res.text).clues ?? []) {
          if (validCell(c.cell) && !PERSON.test(c.what ?? '') && !byCell.has(c.cell)) byCell.set(c.cell, c);
        }
      }
      return [...byCell.values()];
    },

    async sanitize(input: Private<Uint8Array>, clues: PhotoClue[], feedback: LocationVerdict | null, kit: Kit): Promise<Publishable<Uint8Array>> {
      // Rank every flagged cell by its most specific clue: identifiers first (always masked), then specific clues, then
      // ambient ones (facades, trees). Within a rank, cells the attacker actually used go first. Masking stops at the budget.
      const rank = (c: PhotoClue) => (isIdentifier(c) ? 0 : SPECIFIC.has(c.kind) ? 1 : 2);
      const best = new Map<number, { rank: number; cited: boolean; clue: PhotoClue }>();
      const consider = (c: PhotoClue, cited: boolean) => {
        if (!validCell(c.cell) || threat.masked.includes(c.cell)) return;
        const prev = best.get(c.cell);
        const r = rank(c);
        if (!prev || r < prev.rank) best.set(c.cell, { rank: r, cited: cited || !!prev?.cited, clue: c });
        else if (cited) prev.cited = true;
      };
      for (const c of clues) consider(c, false);
      for (const c of feedback?.clues ?? []) consider(c, true);
      const ranked = [...best.entries()].sort(([, a], [, b]) => a.rank - b.rank || Number(b.cited) - Number(a.cited));
      const next = [...threat.masked];
      const left: PhotoClue[] = [];
      for (const [cell, { rank: r, clue }] of ranked) {
        if (r === 0 || next.length < threat.maxMasked) next.push(cell);
        else left.push(clue);
      }
      threat.masked = [...new Set(next)].sort((a, b) => a - b);
      threat.leftVisible = left.sort((a, b) => a.cell - b.cell);
      const t0 = performance.now();
      const masked = await o.ops.maskCells(Private.openLocally(input), threat.masked, GRID);
      kit.ledger.add({
        op: `Pixelate ${threat.masked.length} cells`,
        route: 'local-js',
        ms: Math.round(performance.now() - t0),
        bytesOut: 0,
        note: left.length ? `kept ${left.length} cells visible so the photo stays usable` : undefined,
      });
      // release() refuses bytes identical to the private original.
      return release(masked, `masked cells ${threat.masked.join(',')}`);
    },

    async attack(published: Publishable<Uint8Array>, kit: Kit): Promise<LocationVerdict> {
      // The overlay is derived from the released photo only; it inherits the user's as-is confirmation if there was one.
      const gridded = release(await o.ops.withGrid(published.value, GRID), 'grid overlay of a released photo', {
        userConfirmedAsIs: published.confirmedAsIs,
      });
      const res = await kit.cloud.generate(
        [
          'You are an OSINT geolocation analyst. Estimate where this photo was taken, as precisely as the evidence allows. ' +
            `It has a ${GRID}×${GRID} numbered grid, cells numbered 1–${GRID * GRID} from left to right, top to bottom. Pixelated cells were masked on purpose: ignore them. ` +
            `Masked cells: ${threat.masked.length ? threat.masked.join(', ') : 'none'}. ` +
            'Give your best guess as a place name and coordinates. ' +
            'Return JSON {"place":"best guess","lat":<number>,"lon":<number>,"radiusKm":<number, radius of your uncertainty>,"confidence":"low|medium|high",' +
            '"clues":[{"cell":<number>,"kind":"...","what":"what in that cell helped you"}]}.',
          { image: gridded, mime: 'image/png' },
        ],
        { json: true, schema: GEO_SCHEMA, op: 'Geolocation attack' },
      );
      const v = parseModelJson<{ place?: string; lat?: number | null; lon?: number | null; radiusKm?: number; confidence?: string; clues?: PhotoClue[] }>(res.text);
      // "Unknown" at 0,0 is no guess at all, not a guess 4,500 km off (measured live, 16-nov). Note Number(null) is 0.
      const noGuess =
        /^\s*(unknown|unclear|undetermined|none|n\/a|not sure|cannot|unable)/i.test(String(v.place ?? 'unknown')) ||
        v.lat == null || v.lon == null || (Number(v.lat) === 0 && Number(v.lon) === 0);
      const lat = !noGuess && Number.isFinite(Number(v.lat)) ? Number(v.lat) : null;
      const lon = !noGuess && Number.isFinite(Number(v.lon)) ? Number(v.lon) : null;
      // Scored on the device: the user's real location never leaves it.
      const errorKm = o.truth && lat !== null && lon !== null ? distanceKm({ lat, lon }, Private.openLocally(o.truth)) : null;
      return {
        place: noGuess ? 'unknown' : String(v.place),
        lat,
        lon,
        radiusKm: !noGuess && Number(v.radiusKm) > 0 ? Number(v.radiusKm) : 20000,
        confidence: String(v.confidence ?? 'low'),
        clues: (Array.isArray(v.clues) ? v.clues : []).filter((c: PhotoClue) => validCell(c.cell) && !threat.masked.includes(c.cell)),
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
      if (!reason) return 'safe';
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
