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
  /** Exposed while the attacker's guess lands within this distance of the truth (or claims this precision). */
  safeRadiusKm?: number;
  /**
   * How many times to ask the local model for clues; the answers are merged. Gemini Nano is not deterministic (the same
   * photo gave 5 clue cells, then 4), and on-device calls are free, so asking twice buys recall at no cost and no egress.
   */
  scans?: number;
}

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

/** Kinds of clue that are identifiers a person can look up (an address, a plate), not just hints. */
const READABLE = new Set(['text', 'number', 'plate']);

/**
 * Why a verdict counts as exposure:
 *  - 'readable': the attacker read an identifier (street name, house number, plate) and is not unsure. Even if it picked
 *    the wrong city, a human would search that address everywhere. This holds with or without ground truth.
 *  - 'near': with the user's real location, the guess landed within the safe distance.
 *  - 'precise': without ground truth, the attacker claims a small radius and is not unsure.
 */
export type ExposureReason = 'readable' | 'near' | 'precise';

export function locationThreat(
  o: LocationOptions,
): Threat<Uint8Array, PhotoClue, LocationVerdict> & { masked: number[]; exposureReason(v: LocationVerdict): ExposureReason | null } {
  const safeRadiusKm = o.safeRadiusKm ?? 50;
  const threat = {
    id: 'location',
    question: 'Where was this photo taken?',
    /** Cells masked so far (for the UI). */
    masked: [] as number[],

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
      const cells = new Set([...threat.masked, ...clues.map((c) => c.cell), ...(feedback?.clues ?? []).map((c) => c.cell)].filter(validCell));
      threat.masked = [...cells].sort((a, b) => a - b);
      const t0 = performance.now();
      const masked = await o.ops.maskCells(Private.openLocally(input), threat.masked, GRID);
      kit.ledger.add({ op: `Pixelate ${threat.masked.length} cells`, route: 'local-js', ms: Math.round(performance.now() - t0), bytesOut: 0 });
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
      if (sure && v.clues.some((c) => READABLE.has(c.kind))) return 'readable';
      if (v.errorKm !== null) return v.errorKm < safeRadiusKm ? 'near' : null;
      return sure && v.radiusKm < safeRadiusKm ? 'precise' : null;
    },

    exposed(v: LocationVerdict) {
      // A confident WRONG guess is not exposure, unless it rests on an identifier anyone could look up.
      return threat.exposureReason(v) !== null;
    },
  };
  return threat;
}
