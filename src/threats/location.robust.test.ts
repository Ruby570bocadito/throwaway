// Small models answering badly about a photo: their own words for kinds, cells as strings, unreadable or cut-off
// answers, coordinates out of range. None of it may turn into a "safe" verdict by accident.

import { beforeEach, describe, expect, it } from 'vitest';
import { clearTaint, CloudModel, Ledger, LocalModel, ModelJsonError, release, secret, type ModelBackend } from '../framework';
import { distanceKm, locationThreat, normaliseClue, type ImageOps } from './location';
import { DEMO_TRUTH } from '../demo/photo';

beforeEach(() => clearTaint());

const fakeOps: ImageOps = {
  withGrid: async (png) => new Uint8Array([...png, 250]),
  maskCells: async (png, cells) => new Uint8Array([...png, 251, ...cells]),
};
const PHOTO = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 37) % 251));

/** A model that answers with the given raw texts, one per call (the last one repeats). */
function kitAnswering(...answers: string[]) {
  let call = 0;
  const backend = (source: 'on_device' | 'in_cloud'): ModelBackend => ({
    name: source,
    generate: async () => ({ text: answers[Math.min(call++, answers.length - 1)], source }),
  });
  const ledger = new Ledger();
  return { local: new LocalModel(backend('on_device'), ledger), cloud: new CloudModel(backend('in_cloud'), ledger), ledger, calls: () => call };
}

describe('clues in the words small models use', () => {
  it.each([
    [{ cell: 3, kind: 'street sign', what: 'Rua de São Miguel' }, { cell: 3, kind: 'text', what: 'Rua de São Miguel' }],
    [{ cell: '7', kind: 'House Number', what: '23' }, { cell: 7, kind: 'number', what: '23' }],
    [{ cell: 'cell 4', kind: 'License plate', what: 'a car' }, { cell: 4, kind: 'plate', what: 'a car' }],
    [{ cell: 12, kind: 'tree', what: 'orange tree' }, { cell: 12, kind: 'vegetation', what: 'orange tree' }],
    [{ cell: 2, kind: 'Facade', what: 'balconies' }, { cell: 2, kind: 'architecture', what: 'balconies' }],
    [{ cell: 9, kind: 'church tower', what: 'bell tower' }, { cell: 9, kind: 'landmark', what: 'bell tower' }],
    [{ cell: 1, kind: 'vibes' }, { cell: 1, kind: 'other', what: '' }],
  ])('%o', (raw, expected) => {
    expect(normaliseClue(raw)).toEqual(expected);
  });

  it('drops what does not point at a cell', () => {
    for (const raw of [{ cell: 0 }, { cell: 17 }, { cell: 'x' }, { cell: 2.5 }, null, 'cell 3', { kind: 'text' }]) expect(normaliseClue(raw)).toBeNull();
  });
});

describe('local clue search with a small model', () => {
  it('keeps the most specific clue per cell across scans, so a street sign is not left visible behind a "facade"', async () => {
    const scan1 = JSON.stringify({ clues: [{ cell: 3, kind: 'architecture', what: 'facade' }, { cell: 5, kind: 'architecture', what: 'roofs' }] });
    const scan2 = JSON.stringify({ clues: [{ cell: 3, kind: 'sign', what: 'Street sign reading Rua Augusta' }] });
    const kit = kitAnswering(scan1, scan2);
    const threat = locationThreat({ ops: fakeOps, maxMaskedCells: 0 });
    const clues = await threat.findClues(secret(PHOTO), kit);
    expect(clues).toEqual([
      { cell: 3, kind: 'text', what: 'Street sign reading Rua Augusta' },
      { cell: 5, kind: 'architecture', what: 'roofs' },
    ]);
    await threat.sanitize(secret(PHOTO), clues, null, kit);
    expect(threat.masked).toEqual([3]); // an identifier is masked even with no budget left
  });

  it('skips an unreadable scan, repairs a cut-off one, and fails clearly when no scan can be read', async () => {
    const cut = '```json\n{"clues":[{"cell":3,"kind":"text","what":"plaque"},{"cell":7,"kind":"num';
    expect((await locationThreat({ ops: fakeOps }).findClues(secret(PHOTO), kitAnswering('I see a street.', cut))).map((c) => c.cell)).toEqual([3]);
    await expect(locationThreat({ ops: fakeOps }).findClues(secret(PHOTO), kitAnswering('No idea.'))).rejects.toThrow(/no answer it could read/);
  });
});

describe('the geolocation attack, answering badly', () => {
  const attack = async (...answers: object[] | string[]) => {
    const kit = kitAnswering(...answers.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))));
    const threat = locationThreat({ ops: fakeOps, truth: secret(DEMO_TRUTH, 'real location') });
    const v = await threat.attack(release(PHOTO, 'baseline', { userConfirmedAsIs: true }), kit);
    return { v, threat, calls: kit.calls() };
  };
  const tokyo = { place: 'Tokyo, Japan', lat: 35.68, lon: 139.65, radiusKm: 10, confidence: 'high', clues: [] };

  it('swapped or out-of-range coordinates are not a distance (NaN used to score as safe): the claim is used instead', async () => {
    const { v, threat } = await attack({ ...tokyo, place: 'Palma old town', lat: 139.65, lon: 35.68, radiusKm: 0.4 });
    expect(v).toMatchObject({ place: 'Palma old town', lat: null, lon: null, errorKm: null, radiusKm: 0.4, confidence: 'high' });
    expect(threat.tier(v)).toBe('street');
  });

  it('reads "High", "not sure", "0.5 km" and cells written as strings', async () => {
    const { v } = await attack({ ...tokyo, confidence: 'High', radiusKm: '0.5 km', clues: [{ cell: '7', kind: 'House number', what: '23' }] });
    expect(v).toMatchObject({ confidence: 'high', radiusKm: 0.5, clues: [{ cell: 7, kind: 'number', what: '23' }] });
    expect((await attack({ ...tokyo, confidence: 'not sure' })).v.confidence).toBe('low');
  });

  it('asks once more after an unreadable answer, and fails rather than guess after two', async () => {
    const { v, calls } = await attack('The photo looks Mediterranean.', JSON.stringify(tokyo));
    expect(v.place).toBe('Tokyo, Japan');
    expect(calls).toBe(2);
    await expect(attack('Hmm.', 'Still not sure.')).rejects.toBeInstanceOf(ModelJsonError);
  });

  it('never repairs a cut-off answer: missing coordinates would read as "no guess", which is safe', async () => {
    await expect(attack('{"place":"Carrer de la Llum, 23, Palma","lat":39.56', '{"place":"Carrer de la Llum, 23, Pal')).rejects.toBeInstanceOf(ModelJsonError);
  });

  it('distances stay finite, even between antipodes', () => {
    expect(distanceKm({ lat: 0, lon: 0 }, { lat: 0, lon: 180 })).toBeCloseTo(20015, 0);
    expect(Number.isFinite(distanceKm({ lat: 90, lon: 0 }, { lat: -90, lon: 0 }))).toBe(true);
  });
});
