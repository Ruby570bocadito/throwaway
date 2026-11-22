import { beforeEach, describe, expect, it } from 'vitest';
import { clearTaint, CloudModel, Ledger, LocalModel, PrivacyViolation, redTeam, release, secret, type ModelBackend } from '../framework';
import { demoBackends } from '../demo/recorded';
import { distanceKm, isIdentifier, locationThreat, readMatches, type ImageOps } from './location';
import { DEMO_TRUTH } from '../demo/photo';

// Fake image ops: no canvas in Node. Masking appends the masked cells, so the bytes change like a real edit would.
const fakeOps: ImageOps = {
  withGrid: async (png) => new Uint8Array([...png, 250]),
  size: async () => ({ width: 400, height: 300 }),
  faces: async () => [],
  crop: async (png, r) => new Uint8Array([...png.slice(0, 8), 252, r.x % 251, r.y % 251]),
  paint: async (png, regions) => new Uint8Array([...png, 253, ...regions.map((g) => g.cell)]),
};

const PHOTO = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 37) % 251));

beforeEach(() => clearTaint());

describe('location threat on the demo scene', () => {
  it('is found as-is, lands in the wrong country after one masking round, and is scored on the device', async () => {
    const ledger = new Ledger();
    const b = demoBackends();
    const kit = { local: new LocalModel(b.local, ledger), cloud: new CloudModel(b.cloud, ledger), ledger };
    const threat = locationThreat({ ops: fakeOps, truth: secret(DEMO_TRUTH, 'real location') });
    const photo = secret(PHOTO, 'photo');

    const events = [];
    for await (const e of redTeam(threat, photo, kit, { asIs: release(PHOTO, 'baseline', { userConfirmedAsIs: true }) })) events.push(e);

    const attacks = events.filter((e) => e.type === 'attacked') as { verdict: { errorKm: number; place: string }; exposed: boolean }[];
    // Recorded real answers: Palma (≈0.2 km from the scene) as-is, then Tokyo once the street name, number and shop sign are
    // hidden: the poster (a red circle, nothing to read) and the tree are left, and the poster fools the attacker.
    expect(attacks[0].verdict.errorKm).toBeLessThan(1);
    expect(attacks[1].verdict.place).toBe('Tokyo, Japan');
    expect(attacks[1].verdict.errorKm).toBeGreaterThan(500);
    expect(attacks.map((a) => a.exposed)).toEqual([true, false]);
    expect(events[events.length - 1].type).toBe('safe');
    expect(threat.masked).toEqual([3, 7, 8]);
    expect(ledger.all.filter((e) => e.route === 'on-device').every((e) => e.bytesOut === 0)).toBe(true);
    expect(ledger.all.filter((e) => e.route === 'cloud')).toHaveLength(2);
  }, 30_000);

  it('keeps the photo usable: facades and trees are left, identifiers always go (Paris street, live 16-nov)', async () => {
    const ledger = new Ledger();
    const b = demoBackends();
    const kit = { local: new LocalModel(b.local, ledger), cloud: new CloudModel(b.cloud, ledger), ledger };
    const t = locationThreat({ ops: fakeOps });
    // Gemini Nano flagged a facade in every cell, plus a street sign and a church tower.
    const facades = Array.from({ length: 16 }, (_, i) => ({ cell: i + 1, kind: 'architecture', what: 'Haussmann facade with balconies' }));
    // The sign and the tower as findClues returns them: read up close.
    const clues = [
      ...facades,
      { cell: 14, kind: 'text', what: 'Blue street sign reading Rue Oberkampf', read: true },
      { cell: 9, kind: 'landmark', what: 'Bell tower of Saint-Ambroise church', read: true },
    ];
    const feedback = { place: 'Paris', lat: 48.86, lon: 2.37, radiusKm: 0.5, confidence: 'high', errorKm: null, clues: [{ cell: 5, kind: 'architecture', what: 'Zinc roofs' }] };
    await t.sanitize(secret(PHOTO, 'photo'), clues, feedback, kit);
    // The facades and the attacker's roofs say Paris, not the street: hiding them covered whole photos (21-nov review).
    expect(t.masked).toEqual([9, 14]);
    expect(t.maskedShare).toBeCloseTo(2 / 16, 3);
    expect(t.regions.map((g) => [g.cell, g.style]).sort()).toEqual([[14, 'blur'], [9, 'blur']].sort());
    expect(t.leftVisible).toEqual([]);
    expect(ledger.all.find((e) => e.op.startsWith('Hide '))?.note).toBe('13% of the photo');
    expect(ledger.all.find((e) => e.op.startsWith('Find faces'))?.note).toBe('no face found');

    // A later round that only cites facades adds nothing; one that reads a house number hides it.
    await t.sanitize(secret(PHOTO, 'photo'), [], { ...feedback, clues: [{ cell: 10, kind: 'architecture', what: 'Balconies' }] }, kit);
    expect(t.masked).toEqual([9, 14]);
    await t.sanitize(secret(PHOTO, 'photo'), [], { ...feedback, clues: [{ cell: 11, kind: 'number', what: 'House number 23' }] }, kit);
    expect(t.masked).toEqual([9, 11, 14]);
  });

  it('hides only what can be read or named, from Gemini Nano’s real scans on the photo bench (21-nov)', async () => {
    const hiddenCells = async (clues: { cell: number; kind: string; what: string }[]) => {
      const ledger = new Ledger();
      const b = demoBackends();
      const kit = { local: new LocalModel(b.local, ledger), cloud: new CloudModel(b.cloud, ledger), ledger };
      const t = locationThreat({ ops: fakeOps });
      await t.sanitize(secret(PHOTO, 'photo'), clues, null, kit).catch((e) => {
        if (!/^Nothing to mask/.test((e as Error).message)) throw e;
      });
      return t.masked;
    };
    // A park with nothing to read: Nano said "text: None" in six cells and called a path a landmark.
    const park = [1, 2, 3, 4, 8, 16].map((cell) => ({ cell, kind: 'vegetation', what: 'Large deciduous trees' }));
    const nothing = [7, 10, 11, 14, 15].map((cell) => ({ cell, kind: 'text', what: 'None' }));
    expect(await hiddenCells([...park, ...nothing, { cell: 6, kind: 'landmark', what: 'Path winding through trees' }])).toEqual([]);
    // Lisbon: the street sign in four cells; the tooth, the earring, the tram and the tiles are not clues.
    const lisbon = [
      { cell: 1, kind: 'text', what: 'RUA DAS FLORES' },
      { cell: 5, kind: 'text', what: 'RUA DAS FLORES' },
      { cell: 6, kind: 'text', what: 'RUA DAS FLORES' },
      { cell: 2, kind: 'text', what: 'Rua das Flores' },
      { cell: 8, kind: 'landmark', what: 'Tram' },
      { cell: 10, kind: 'text', what: 'None' },
      { cell: 15, kind: 'plate', what: 'Tooth' },
      { cell: 13, kind: 'plate', what: 'Earring' },
      { cell: 3, kind: 'landmark', what: 'Azulejo tile' },
    ];
    expect(await hiddenCells(lisbon)).toEqual([1, 2, 5, 6]);
    // New York: the street sign ("W 4 St" is an address), not the menu, the coffee cup, the glasses or the taxis.
    const ny = [
      { cell: 3, kind: 'landmark', what: 'W 4 St' },
      { cell: 4, kind: 'text', what: 'W 4 St' },
      { cell: 8, kind: 'landmark', what: 'Taxi' },
      { cell: 10, kind: 'text', what: 'Menu' },
      { cell: 11, kind: 'landmark', what: 'Glasses' },
      { cell: 15, kind: 'text', what: 'Coffee cup' },
      { cell: 16, kind: 'landmark', what: 'Yellow taxi' },
    ];
    // Without Gemini Nano's readings (recorded answers name no cell of this photo), the address in cell 4 is hidden within
    // the budget, and the landmark in cell 3, unread, is left. With them, cell 3 is the rest of the sign (Tokyo test).
    expect(await hiddenCells(ny)).toEqual([4]);
  }, 60_000);

  it('hides other clues within a quarter of the photo, identifiers past it', async () => {
    const ledger = new Ledger();
    const b = demoBackends();
    const kit = { local: new LocalModel(b.local, ledger), cloud: new CloudModel(b.cloud, ledger), ledger };
    const t = locationThreat({ ops: fakeOps });
    // Shop signs Gemini Nano read in their cells (findClues marks them so).
    const shops = [1, 2, 3, 4, 5, 6].map((cell) => ({ cell, kind: 'text', what: `Shop sign number ${cell}`, read: true }));
    const plates = [15, 16].map((cell) => ({ cell, kind: 'plate', what: 'Car plate', read: true }));
    await t.sanitize(secret(PHOTO, 'photo'), [...shops, ...plates], null, kit);
    // The plates first, whatever the budget; then shop signs until a quarter of the photo is hidden.
    expect(t.masked).toEqual([1, 2, 15, 16]);
    expect(t.leftVisible.map((c) => c.cell)).toEqual([3, 4, 5, 6]);
    expect(t.maskedShare).toBeCloseTo(0.25, 3);
  }, 30_000);

  it('never hides a face: a clue’s cell is hidden around the faces in it, and a cell that is all face is left', async () => {
    const ledger = new Ledger();
    const b = demoBackends();
    const kit = { local: new LocalModel(b.local, ledger), cloud: new CloudModel(b.cloud, ledger), ledger };
    // The photo is 400 × 300: cell 3 is 100 × 75 at (200, 0), cell 6 is 100 × 75 at (100, 75).
    const heads = [
      { x: 210, y: 40, w: 60, h: 60 }, // a head under the street sign in cell 3
      { x: 95, y: 70, w: 110, h: 85 }, // a head filling cell 6
    ];
    const t = locationThreat({ ops: { ...fakeOps, faces: async () => heads } });
    const clues = [
      { cell: 3, kind: 'text', what: 'Street sign reading Rua Augusta' },
      { cell: 6, kind: 'number', what: 'House number 23' },
    ];
    await t.sanitize(secret(PHOTO, 'photo'), clues, null, kit);
    expect(t.regions.map((g) => g.rect)).toEqual([
      { x: 200, y: 0, w: 100, h: 40 }, // above the head
      { x: 200, y: 40, w: 10, h: 30 }, // left of it, down to the other head (it reaches x 205)
      { x: 270, y: 40, w: 30, h: 35 }, // right of it
    ]);
    const overlap = (a: { x: number; y: number; w: number; h: number }, c: typeof a) => a.x < c.x + c.w && c.x < a.x + a.w && a.y < c.y + c.h && c.y < a.y + a.h;
    expect(t.regions.some((g) => heads.some((h) => overlap(g.rect, h)))).toBe(false);
    expect(t.leftVisible.map((c) => c.cell)).toEqual([6]);
    expect(t.masked).toEqual([3]);
    expect(t.faces).toEqual(heads);
    expect(ledger.all.find((e) => e.op.startsWith('Find faces'))?.note).toBe('2 faces · never hidden');
  });

  it('hides the cells a person picks by hand the same way, around the faces', async () => {
    const ledger = new Ledger();
    const kit = { local: new LocalModel(demoBackends().local, ledger), cloud: new CloudModel(demoBackends().cloud, ledger), ledger };
    const t = locationThreat({ ops: { ...fakeOps, faces: async () => [{ x: 95, y: 70, w: 110, h: 85 }] } });
    await t.hideCells(secret(PHOTO, 'photo'), [6, 16], kit);
    expect(t.masked).toEqual([16]); // cell 6 is all face
    expect(ledger.all[0].op).toBe('Hide 2 cells you chose, around the faces');
  });

  it('shows a hidden cell again with a tap, and hides another, painted again from the original', async () => {
    const ledger = new Ledger();
    const kit = { local: new LocalModel(demoBackends().local, ledger), cloud: new CloudModel(demoBackends().cloud, ledger), ledger };
    const t = locationThreat({ ops: fakeOps });
    await t.hideCells(secret(PHOTO, 'photo'), [3, 7], kit);
    expect(t.masked).toEqual([3, 7]);
    await t.toggleCells(secret(PHOTO, 'photo'), [7, 5], kit);
    expect(t.masked).toEqual([3, 5]);
    expect(t.maskedShare).toBeCloseTo(2 / 16, 3);
    expect(ledger.all[0].op).toBe('Hide cell 5 and show cell 7 again, around the faces');
    // Every cell shown again would release the original: refused, with what to do instead.
    await expect(t.toggleCells(secret(PHOTO, 'photo'), [3, 5], kit)).rejects.toThrow(/attack it as it is/);
    expect(t.masked).toEqual([3, 5]);
  });

  it('still masks when the face detector cannot run, and says faces were not protected', async () => {
    const ledger = new Ledger();
    const kit = { local: new LocalModel(demoBackends().local, ledger), cloud: new CloudModel(demoBackends().cloud, ledger), ledger };
    const t = locationThreat({ ops: { ...fakeOps, faces: async () => Promise.reject(new Error('WebAssembly blocked')) } });
    await t.sanitize(secret(PHOTO, 'photo'), [{ cell: 7, kind: 'number', what: 'House number 23' }], null, kit);
    expect(t.masked).toEqual([7]);
    expect(ledger.all.find((e) => e.op.startsWith('Find faces'))?.note).toBe('could not run (WebAssembly blocked) · faces not protected');
  });

  it('without ground truth trusts a sure, precise claim; with it, a confident wrong guess is not exposure', () => {
    const t1 = locationThreat({ ops: fakeOps });
    const t2 = locationThreat({ ops: fakeOps, truth: secret(DEMO_TRUTH) });
    const tokyo = { place: 'Tokyo', lat: 35.68, lon: 139.65, radiusKm: 10, confidence: 'high', clues: [], errorKm: null };
    expect(t1.tier(tokyo)).toBe('city'); // a sure 10 km claim, and nothing to check it against: it can tell the city
    expect(t1.exposed(tokyo)).toBe(false);
    expect(t1.tier({ ...tokyo, radiusKm: 0.3 })).toBe('street'); // a sure street-level claim
    expect(t1.exposed({ ...tokyo, radiusKm: 0.3 })).toBe(true);
    expect(t1.exposed({ ...tokyo, confidence: 'low' })).toBe(false); // an unsure claim is not exposure
    // …but without your location, a city it names is not called safe either: "Madrid, low confidence" was close (live, 22-nov).
    expect(t1.tier({ ...tokyo, confidence: 'low', radiusKm: 50 })).toBe('city');
    expect(t1.tier({ ...tokyo, confidence: 'low', radiusKm: 2000 })).toBe('safe'); // a country or more: not your city
    expect(t2.tier({ ...tokyo, confidence: 'low', radiusKm: 50, errorKm: distanceKm(tokyo, DEMO_TRUTH) })).toBe('safe'); // checked: far off
    expect(t2.exposed({ ...tokyo, errorKm: distanceKm(tokyo, DEMO_TRUTH) })).toBe(false); // it is 10,000+ km off
  });

  it('red, amber, green: street, city or wrong place (the live test-photo results, 16-nov)', () => {
    const t = locationThreat({ ops: fakeOps, truth: secret(DEMO_TRUTH) });
    const v = (o: Partial<{ errorKm: number | null; confidence: string; clues: { cell: number; kind: string; what: string }[]; lat: number | null }>) => ({
      place: 'x', lat: 1, lon: 1, radiusKm: 1, confidence: 'low', clues: [], errorKm: null, ...o,
    });
    const sign = [{ cell: 8, kind: 'text', what: 'Street sign reading Rua de São Miguel' }];
    expect(t.tier(v({ errorKm: 0.034, confidence: 'high', clues: sign }))).toBe('street'); // Lisbon as-is: read the plaque
    expect(t.tier(v({ errorKm: 0.876, confidence: 'high' }))).toBe('street'); // Lisbon, 8 cells masked: 876 m
    expect(t.tier(v({ errorKm: 2, confidence: 'low' }))).toBe('city'); // Paris, sign masked: ~2 km
    expect(t.tier(v({ errorKm: 3, confidence: 'low' }))).toBe('city'); // Tokyo: ~3 km, a city of millions
    expect(t.tier(v({ errorKm: null, lat: null }))).toBe('safe'); // control: no guess at all
    expect(t.tier(v({ errorKm: 950 }))).toBe('safe'); // the demo scene after masking: Rome
    expect(t.exposed(v({ errorKm: 3, confidence: 'low' }))).toBe(false); // amber does not keep the loop masking
  });

  it('a shop sign is a hint, not an address (live, 16-nov: "ramen" and "sake shop" signs, guess Kyoto, 360 km off)', () => {
    const t = locationThreat({ ops: fakeOps, truth: secret(DEMO_TRUTH) });
    const kyoto = {
      place: 'Kyoto, Japan', lat: 35.01, lon: 135.77, radiusKm: 5, confidence: 'medium', errorKm: 360,
      clues: [
        { cell: 7, kind: 'text', what: 'Japanese signage saying ramen and sake shop (酒店)' },
        { cell: 8, kind: 'text', what: 'Japanese confectionery and alcohol store signage' },
        { cell: 2, kind: 'architecture', what: 'Typical dense utility poles and power lines' },
      ],
    };
    expect(t.exposureReason(kyoto)).toBeNull();
    expect(t.tier(kyoto)).toBe('safe'); // 360 km off and no address: the wrong place
    // Identifiers still count, in the words the live attacker used:
    expect(isIdentifier({ cell: 8, kind: 'text', what: 'Street sign reading Rua de São Miguel' })).toBe(true);
    expect(isIdentifier({ cell: 15, kind: 'text', what: 'Blue street sign indicating Rue Oberkampf' })).toBe(true);
    expect(isIdentifier({ cell: 7, kind: 'number', what: 'Building number 23' })).toBe(true);
    expect(isIdentifier({ cell: 7, kind: 'number', what: '23' })).toBe(true);
    expect(isIdentifier({ cell: 4, kind: 'plate', what: 'a car plate' })).toBe(true);
    expect(isIdentifier({ cell: 5, kind: 'number', what: 'Bus route number 28' })).toBe(false);
    expect(isIdentifier({ cell: 6, kind: 'text', what: 'Shop sign for a bakery' })).toBe(false);
  });

  it('treats "Unknown" at 0,0 as no guess, not as a guess 4,500 km off (live, 16-nov)', async () => {
    const answer = (body: object) => ({ name: 'cloud', generate: async () => ({ text: JSON.stringify(body), source: 'in_cloud' as const }) });
    const run = async (body: object) => {
      const ledger = new Ledger();
      const cloud = answer(body);
      const kit = { local: new LocalModel(cloud, ledger), cloud: new CloudModel(cloud, ledger), ledger };
      const threat = locationThreat({ ops: fakeOps, truth: secret({ lat: 40.4168, lon: -3.7038 }, 'real location') });
      const v = await threat.attack(release(PHOTO, 'baseline', { userConfirmedAsIs: true }), kit);
      return { v, exposed: threat.exposed(v) };
    };
    const live = { place: 'Unknown', lat: 0, lon: 0, radiusKm: 5000, confidence: 'low', clues: [{ cell: 12, kind: 'vegetation', what: 'potted plant' }] };
    const a = await run(live);
    expect(a.v).toMatchObject({ place: 'unknown', lat: null, lon: null, errorKm: null, radiusKm: 20000 });
    expect(a.exposed).toBe(false);
    const b = await run({ ...live, place: 'Somewhere', lat: null, lon: null }); // Number(null) would have been 0
    expect(b.v.errorKm).toBeNull();
    const c = await run({ ...live, place: 'Madrid, Spain', lat: 40.42, lon: -3.7 }); // a real guess is still scored
    expect(c.v.errorKm).toBeLessThan(1);
    expect(c.exposed).toBe(true);
  });

  it('cannot send the original photo without the user confirming it', async () => {
    const ledger = new Ledger();
    const b = demoBackends();
    const kit = { local: new LocalModel(b.local, ledger), cloud: new CloudModel(b.cloud, ledger), ledger };
    secret(PHOTO, 'photo');
    expect(() => release(PHOTO, 'sneaky')).toThrow(PrivacyViolation);
    const sign = [{ cell: 3, kind: 'text', what: 'Street sign' }];
    await expect(locationThreat({ ops: { ...fakeOps, paint: async (p) => p } }).sanitize(secret(PHOTO), sign, null, kit)).rejects.toBeInstanceOf(PrivacyViolation);
  });

  it('with nothing flagged, says there is nothing to mask instead of a scary privacy block (the no-op re-encode is the original)', async () => {
    const ledger = new Ledger();
    const b = demoBackends();
    const kit = { local: new LocalModel(b.local, ledger), cloud: new CloudModel(b.cloud, ledger), ledger };
    const err = await locationThreat({ ops: { ...fakeOps, paint: async (p) => p } })
      .sanitize(secret(PHOTO), [], null, kit)
      .catch((e) => e);
    expect(err).not.toBeInstanceOf(PrivacyViolation);
    expect((err as Error).message).toMatch(/^Nothing to mask/);
  });
});

describe('local clue search', () => {
  it('merges several free on-device scans, because Gemini Nano does not answer the same way twice', async () => {
    const ledger = new Ledger();
    const answers = [
      { clues: [{ cell: 3, kind: 'text', what: 'plaque' }, { cell: 7, kind: 'number', what: '23' }, { cell: 1, kind: 'text', what: 'poster' }] },
      { clues: [{ cell: 3, kind: 'text', what: 'plaque' }, { cell: 12, kind: 'vegetation', what: 'orange tree' }] },
    ];
    let call = 0;
    // After the two scans, Gemini Nano reads the one cell that names something to read (the house number).
    const nano = { name: 'nano', generate: async () => ({ text: JSON.stringify(answers[call++] ?? { texts: ['23'] }), source: 'on_device' as const }) };
    const kit = { local: new LocalModel(nano, ledger), cloud: new CloudModel(nano, ledger), ledger };
    const clues = await locationThreat({ ops: fakeOps }).findClues(secret(PHOTO), kit);
    expect(clues.map((c) => c.cell).sort((a, b) => a - b)).toEqual([1, 3, 7, 12]);
    expect(ledger.all.filter((e) => e.route === 'on-device').map((e) => e.op)).toEqual(['Read the text in cell 7', 'Find location clues (scan 2/2)', 'Find location clues (scan 1/2)']);
    expect(clues.find((c) => c.cell === 7)?.read).toBe(true);
    expect(ledger.bytesOut).toBe(0);
  });
});

describe('reading each cell up close (bench, 21-nov)', () => {
  it('readMatches: a name, a number or a plate, as read or nearly; not some other text', () => {
    expect(readMatches(['RUA DAS', 'FLORES'], 'Street sign reading Rua das Flores')).toBe(true);
    expect(readMatches(['27'], 'House number 27.')).toBe(true);
    expect(readMatches(['AB-I23-CD'], 'Vehicle license plate AB-123-CD')).toBe(true); // one character misread
    expect(readMatches(['CARRETER DE LA LLUM'], 'Carrer de la Llum')).toBe(true);
    expect(readMatches([], 'House number 27.')).toBe(false);
    expect(readMatches(['BOULANGERIE'], 'House number 27.')).toBe(false);
    expect(readMatches(['EXIT'], 'Underground station sign.')).toBe(true); // it names nothing to read: anything read counts
    expect(readMatches([], 'Underground station sign.')).toBe(false);
  });

  it('keeps the cell where Gemini Nano reads the number or the plate, not the other cells it put them in (Paris)', async () => {
    const ledger = new Ledger();
    const number = (cell: number) => ({ cell, kind: 'number', what: 'House number 27' });
    const plate = (cell: number) => ({ cell, kind: 'plate', what: 'Vehicle license plate AB-123-CD' });
    const shop = (cell: number) => ({ cell, kind: 'text', what: 'BOULANGERIE MARTIN shop sign' });
    const scan = { clues: [number(4), number(12), plate(9), plate(10), plate(13), plate(14), shop(2), shop(7)] };
    // What each cell really shows, read up close.
    const reads: Record<number, string[]> = { 4: ['27'], 14: ['AB-123-CD'], 2: ['BOULANGERIE MAR'] };
    const nano: ModelBackend = {
      name: 'nano',
      generate: async (_parts, opts) => {
        const cell = Number(opts.op.match(/cell (\d+)/)?.[1]);
        return { text: JSON.stringify(opts.op.startsWith('Read') ? { texts: reads[cell] ?? [] } : scan), source: 'on_device' };
      },
    };
    const kit = { local: new LocalModel(nano, ledger), cloud: new CloudModel(nano, ledger), ledger };
    const t = locationThreat({ ops: fakeOps });
    const clues = await t.findClues(secret(PHOTO, 'photo'), kit);
    // The shop sign in 7 could not be read there; the number in 12 and the plate in 9, 10, 13 were read elsewhere.
    expect(clues.map((c) => [c.cell, c.read]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [2, true],
      [4, true],
      [14, true],
    ]);
    await t.sanitize(secret(PHOTO, 'photo'), clues, null, kit);
    expect(t.masked).toEqual([2, 4, 14]);
    expect(t.maskedShare).toBeCloseTo(3 / 16, 3);
  });

  /** Gemini Nano as it answered on the photo bench: one scan, and what it read in each cell it was asked to read. */
  const benchNano = (clues: { cell: number; kind: string; what: string }[], reads: Record<number, string[]>): ModelBackend => ({
    name: 'nano',
    generate: async (_parts, opts) => {
      const cell = Number(opts.op.match(/cell (\d+)/)?.[1]);
      return { text: JSON.stringify(opts.op.startsWith('Read') ? { texts: reads[cell] ?? [] } : { clues }), source: 'on_device' };
    },
  });
  const maskWith = async (nano: ModelBackend, o: { maxMaskedShare?: number } = {}) => {
    const ledger = new Ledger();
    const kit = { local: new LocalModel(nano, ledger), cloud: new CloudModel(nano, ledger), ledger };
    const t = locationThreat({ ops: fakeOps, scans: 1, ...o });
    const clues = await t.findClues(secret(PHOTO, 'photo'), kit);
    await t.sanitize(secret(PHOTO, 'photo'), clues, null, kit).catch((e) => {
      if (!/^Nothing to mask/.test((e as Error).message)) throw e;
    });
    return t;
  };

  it('Barcelona: the café and the street sign, read whole in their cells; not the table number or a "15"', async () => {
    const t = await maskWith(
      benchNano(
        [
          { cell: 1, kind: 'text', what: 'CAFE VERDI' },
          { cell: 2, kind: 'text', what: 'Carre de Verdi' },
          { cell: 3, kind: 'text', what: 'Carre de Verdi' },
          { cell: 6, kind: 'text', what: 'Café Verdi awning' },
          { cell: 7, kind: 'text', what: 'Carer de Verdi' },
          { cell: 10, kind: 'text', what: 'CAFE VERDI' },
          { cell: 14, kind: 'number', what: 'Table number 14' },
          { cell: 15, kind: 'number', what: '15' },
          { cell: 11, kind: 'text', what: 'Coffee cups and croissants on the table' },
          { cell: 4, kind: 'architecture', what: 'Building with balconies' },
        ],
        { 1: ['CAFE V'], 2: ['VERDI', 'Carrer de Verdi'], 3: [], 6: [], 7: [''], 10: [], 14: [''], 15: ['latte'] },
      ),
    );
    // Cell 3 holds a sliver of the street sign's edge: the name was read whole in cell 2, so cell 3 is not its rest.
    expect(t.masked).toEqual([1, 2]);
  });

  it('a park: a "0" and a book title it cannot read up close are not hidden', async () => {
    const t = await maskWith(
      benchNano(
        [
          { cell: 10, kind: 'number', what: '0' },
          { cell: 11, kind: 'text', what: 'Book title: "The Art of Joy"' },
          { cell: 2, kind: 'vegetation', what: 'Trees' },
        ],
        {},
      ),
    );
    expect(t.masked).toEqual([]);
  });

  it('Paris: the sign read as "BOULANGERIE" in one cell and "MARTIN" in another, and the plate in its cell only', async () => {
    const shop = (cell: number, what = 'Boulangerie Martin') => ({ cell, kind: 'text', what });
    const t = await maskWith(
      benchNano(
        [shop(6), shop(7, 'Boulangerie'), shop(11), { cell: 12, kind: 'number', what: '27' }, { cell: 13, kind: 'plate', what: 'AB-123-CD' }, shop(2), shop(3), { cell: 10, kind: 'plate', what: 'AB-123-CD' }, { cell: 14, kind: 'plate', what: 'AB-123-CD' }],
        { 6: ['BOULANGERIE', 'CHARCUTERIE'], 7: [], 11: [''], 12: [], 13: [], 2: ['[ROULANGERIE MARTINI'], 3: ['AN'], 10: [], 14: ['AB-123-CD'] },
      ),
    );
    // Both words of the sign were read (cells 2 and 6), so cell 3, which read "AN", is not its rest.
    expect(t.masked).toEqual([2, 6, 14]);
  });

  it('Tokyo: finds the rest of the station sign in the cell beside it; not the cell below, a vague "structure" or a "plate" read as "3"', async () => {
    const station = (cell: number) => ({ cell, kind: 'text', what: 'Harajuku Station' });
    const t = await maskWith(
      benchNano(
        [
          { cell: 3, kind: 'text', what: 'HARAJUKU STATION' },
          station(7),
          station(9),
          { cell: 11, kind: 'landmark', what: 'Station structure' },
          { cell: 12, kind: 'landmark', what: 'Station structure' },
          { cell: 16, kind: 'plate', what: 'Vehicle plate (partially obscured)' },
        ],
        // Cell 2 was never flagged; read beside cell 3, it shows the rest of the sign.
        { 3: ['STATION'], 7: [], 9: [], 16: ['3'], 2: ['HARAJUKU'], 4: [] },
      ),
    );
    expect(t.masked).toEqual([2, 3]);
  });

  it('Tokyo, again: "HARAKUJO STATION" called a landmark in every cell; read up close, only its two cells stay', async () => {
    const everywhere = Array.from({ length: 16 }, (_, i) => ({ cell: i + 1, kind: 'landmark', what: 'HARAKUJO STATION' }));
    const t = await maskWith(
      benchNano(
        [...everywhere.filter((c) => c.cell !== 3 && c.cell !== 1 && c.cell !== 11), { cell: 3, kind: 'text', what: 'HARAKUJU STATION' }, { cell: 1, kind: 'text', what: 'HARAKUJO STATION' }, { cell: 11, kind: 'text', what: 'HARAKUJO STATION' }],
        // Read up close: "HARAJUKU" in cell 2 (letters in another order than the scan's), "STATION" in cell 3, nothing elsewhere.
        { 2: ['HARAJUKU'], 3: ['STATION'] },
      ),
    );
    expect(t.masked).toEqual([2, 3]);
  });

  it('Tokyo, a third time: "HARAKUJUKU" read up close beside the scan’s "HARAKUJO STATION" is the rest of the sign', async () => {
    const station = (cell: number, kind = 'text') => ({ cell, kind, what: 'HARAKUJO STATION' });
    const t = await maskWith(
      benchNano(
        [station(3), station(6), station(7, 'landmark'), station(8, 'landmark'), station(10), station(11), { cell: 4, kind: 'landmark', what: 'Red pillar/sign' }],
        // As read on the bench (21-nov).
        { 3: ['STATION'], 7: [''], 2: ['HARAKUJUKU ST'] },
      ),
    );
    expect(t.masked).toEqual([2, 3]);
    // A different word that ends the same is not the same word.
    expect(readMatches(['ROTTERDAM'], 'AMSTERDAM')).toBe(false);
  });

  it('Amsterdam: the street sign and the number, not a second cell for the same number', async () => {
    const t = await maskWith(
      benchNano(
        [
          { cell: 2, kind: 'text', what: 'Prinsengracht street sign' },
          { cell: 7, kind: 'number', what: '263' },
          { cell: 6, kind: 'text', what: 'House number 263' },
          { cell: 13, kind: 'vegetation', what: 'Bicycles parked by a canal' },
        ],
        { 2: ['PRINSENGRACHT'], 7: ['263'], 6: [] },
      ),
    );
    expect(t.masked).toEqual([2, 7]);
  });

  it('Paris, again: the sign put a row too low; read up close, the cell above holds it, and the cell beside is not its rest', async () => {
    const shop = (cell: number) => ({ cell, kind: 'text', what: 'Boulangerie Martin' });
    const plate = (cell: number) => ({ cell, kind: 'plate', what: 'Vehicle license plate AB-123-CD' });
    const clues = [
      shop(3),
      shop(6),
      shop(7),
      shop(11),
      { cell: 4, kind: 'number', what: 'House number 27.' },
      { cell: 8, kind: 'number', what: 'House number 27' },
      plate(9),
      plate(10),
      plate(13),
      plate(14),
      { cell: 5, kind: 'text', what: 'Shop sign (partially obscured)' },
      { cell: 2, kind: 'text', what: 'Building facade with arches' },
    ];
    // As read on the bench (21-nov); cell 2, which no scan put the sign in, shows it (the photo, cell by cell).
    const reads = { 4: ['27'], 14: ['AB-123-CD'], 3: ['ON'], 6: ['BOULANGERIE', 'BOULANGERIE'], 5: ["RUE D'AUXERAU"], 2: ['BOULANGERIE MARTIN'] };
    expect((await maskWith(benchNano(clues, reads))).masked).toEqual([2, 4, 6, 14]);
    // With room for one cell of the sign, the one that shows all of it.
    expect((await maskWith(benchNano(clues, reads), { maxMaskedShare: 0.2 })).masked).toEqual([2, 4, 14]);
  });

  it('New York: "4 St" read in one cell and the "W" in the cell beside it, so both are hidden', async () => {
    const t = await maskWith(
      benchNano(
        [
          { cell: 3, kind: 'text', what: 'W 4 St' },
          { cell: 4, kind: 'landmark', what: 'W 4 St' },
          { cell: 11, kind: 'text', what: 'W 4 St' },
          { cell: 8, kind: 'landmark', what: 'Yellow taxi' },
          { cell: 15, kind: 'text', what: 'Coffee cup' },
        ],
        { 3: ['W'], 4: ['4 St'], 11: [] },
      ),
    );
    expect(t.masked).toEqual([3, 4]);
  });

  it('Paris, a third time: "27" put a row below its sign, found in the cell above; a landmark called "Street" is not read', async () => {
    const sign = (cell: number, what = 'ROUGERIE MARTIN') => ({ cell, kind: 'text', what });
    const plate = (cell: number) => ({ cell, kind: 'plate', what: 'AB-123-CD' });
    const t = await maskWith(
      benchNano(
        [
          sign(2),
          sign(3, 'ROUGERIE'),
          sign(6),
          sign(7),
          sign(11, 'Boulangerie Martin'),
          { cell: 8, kind: 'number', what: '27' },
          plate(10),
          plate(13),
          plate(14),
          { cell: 5, kind: 'text', what: 'Shop sign' },
          { cell: 9, kind: 'landmark', what: 'Street' },
        ],
        // As read on the bench (21-nov), and cell 4, which shows the 27 (the photo, cell by cell).
        { 14: ['AB-123-CD', 'EURO', 'D'], 3: ['ON'], 6: ['BOULANGERIE'], 2: ['BOULANGERIE MARTIN'], 9: ['Z-000-111'], 4: ['27'] },
      ),
    );
    expect(t.masked).toEqual([2, 4, 14]);
  });

  it('Lisbon: the street sign put in one of the two cells it spans; read up close, the cell beside it holds the rest', async () => {
    const t = await maskWith(
      benchNano(
        [
          { cell: 1, kind: 'text', what: 'RUA DAS FLORES' },
          { cell: 6, kind: 'text', what: 'RUA DAS FLORES' },
          { cell: 7, kind: 'landmark', what: 'Yellow tram' },
          { cell: 5, kind: 'architecture', what: 'Blue and white tiled wall' },
        ],
        // As read on the bench (21-nov), and cell 2 as read in the run before.
        { 1: ['RAS DA V'], 6: ['FOREO'], 2: ['RUA FLORES'] },
      ),
    );
    expect(t.masked).toEqual([1, 2]);
  });

  it('Barcelona, again: both signs put a cell or more off; read up close, the cell beside one holds the street name', async () => {
    const t = await maskWith(
      benchNano(
        [
          { cell: 3, kind: 'text', what: 'Carer de Verdi' },
          { cell: 7, kind: 'text', what: 'Carer de Verdi' },
          { cell: 15, kind: 'text', what: 'CAFE VERDI' },
          { cell: 10, kind: 'text', what: 'CAFE VERDI' },
          { cell: 16, kind: 'architecture', what: 'Balconies' },
        ],
        // As read on the bench (21-nov), and cell 2 as read in the run before.
        { 3: ['Sonne & Mond'], 7: [], 10: [], 15: ['latte'], 2: ['VERDI', 'Carrer de Verd'] },
      ),
    );
    expect(t.masked).toEqual([2]);
  });

  it('looks for faces once, while Gemini Nano scans: blurring does not wait for the detector again', async () => {
    let faceCalls = 0;
    const ledger = new Ledger();
    const nano = benchNano([{ cell: 7, kind: 'number', what: 'House number 23' }], { 7: ['23'] });
    const kit = { local: new LocalModel(nano, ledger), cloud: new CloudModel(nano, ledger), ledger };
    const t = locationThreat({ ops: { ...fakeOps, faces: async () => (faceCalls++, []) }, scans: 1 });
    const clues = await t.findClues(secret(PHOTO, 'photo'), kit);
    expect(faceCalls).toBe(1);
    await t.sanitize(secret(PHOTO, 'photo'), clues, null, kit);
    expect(faceCalls).toBe(1);
    expect(t.masked).toEqual([7]);
  });

  it('blurs the faces only when you ask: a layer of their own, outside the budget and the cells told to the attacker', async () => {
    const painted: number[][] = [];
    const ops: ImageOps = {
      ...fakeOps,
      faces: async () => [{ x: 20, y: 40, w: 100, h: 120 }],
      paint: async (png, regions) => (painted.push(regions.map((g) => g.cell)), new Uint8Array([...png, 253, ...regions.map((g) => g.cell)])),
    };
    const ledger = new Ledger();
    const nano = benchNano([{ cell: 7, kind: 'number', what: 'House number 23' }], { 7: ['23'] });
    const kit = { local: new LocalModel(nano, ledger), cloud: new CloudModel(nano, ledger), ledger };
    const t = locationThreat({ ops, scans: 1 });
    const photo = secret(PHOTO, 'photo');
    await t.sanitize(photo, await t.findClues(photo, kit), null, kit);
    expect(painted[painted.length - 1]).not.toContain(0);
    const without = t.maskedShare;
    expect(await t.setBlurFaces(photo, true, kit)).not.toBeNull();
    expect(painted[painted.length - 1]).toContain(0); // the face layer (cell 0: no cell of its own)
    expect(t.masked).toEqual([7]);
    expect(t.maskedShare).toBeGreaterThan(without);
    expect(t.clueShare).toBeCloseTo(without); // the budget never counts a face
    expect(ledger.all[0]?.note).toMatch(/1 face blurred, by your choice/); // newest first
    await t.setBlurFaces(photo, false, kit);
    expect(painted[painted.length - 1]).not.toContain(0);
    expect(t.maskedShare).toBeCloseTo(without);
  });

  it('remembers the choice made before blurring: the first blur paints the faces too', async () => {
    const painted: number[][] = [];
    const ops: ImageOps = {
      ...fakeOps,
      faces: async () => [{ x: 20, y: 40, w: 100, h: 120 }],
      paint: async (png, regions) => (painted.push(regions.map((g) => g.cell)), new Uint8Array([...png, 253, ...regions.map((g) => g.cell)])),
    };
    const ledger = new Ledger();
    const nano = benchNano([{ cell: 7, kind: 'number', what: 'House number 23' }], { 7: ['23'] });
    const kit = { local: new LocalModel(nano, ledger), cloud: new CloudModel(nano, ledger), ledger };
    const t = locationThreat({ ops, scans: 1 });
    const photo = secret(PHOTO, 'photo');
    const clues = await t.findClues(photo, kit);
    expect(await t.setBlurFaces(photo, true, kit)).toBeNull(); // nothing blurred yet: nothing painted
    expect(painted).toEqual([]);
    await t.sanitize(photo, clues, null, kit);
    expect(painted[painted.length - 1]).toEqual([7, 0]);
  });

  it('sends the attacker a JPEG of the photo, not a PNG: a phone photo was 1–2 MB per attack', async () => {
    const types: (string | undefined)[] = [];
    const mimes: string[] = [];
    const cloud: ModelBackend = {
      name: 'cloud',
      generate: async (parts) => {
        for (const p of parts) if ('image' in p) mimes.push(p.mime);
        return { text: JSON.stringify({ place: 'Somewhere', lat: 1, lon: 1, radiusKm: 5000, confidence: 'low', clues: [] }), source: 'in_cloud' };
      },
    };
    const ledger = new Ledger();
    const kit = { local: new LocalModel(cloud, ledger), cloud: new CloudModel(cloud, ledger), ledger };
    const t = locationThreat({ ops: { ...fakeOps, withGrid: async (png, _n, type) => (types.push(type), new Uint8Array([...png, 250])) } });
    await t.attack(release(PHOTO, 'as is', { userConfirmedAsIs: true }), kit);
    expect(types).toEqual(['image/jpeg']);
    expect(mimes).toEqual(['image/jpeg']);
  });

  it('still hides an identifier it could read nowhere, within the budget (the attacker may read it better)', async () => {
    const ledger = new Ledger();
    const scan = { clues: [{ cell: 6, kind: 'number', what: 'House number 23' }] };
    const nano: ModelBackend = {
      name: 'nano',
      generate: async (_parts, opts) => ({ text: JSON.stringify(opts.op.startsWith('Read') ? { texts: [] } : scan), source: 'on_device' }),
    };
    const kit = { local: new LocalModel(nano, ledger), cloud: new CloudModel(nano, ledger), ledger };
    const t = locationThreat({ ops: fakeOps });
    const clues = await t.findClues(secret(PHOTO, 'photo'), kit);
    expect(clues).toEqual([{ cell: 6, kind: 'number', what: 'House number 23', read: false, seen: [] }]);
    await t.sanitize(secret(PHOTO, 'photo'), clues, null, kit);
    expect(t.masked).toEqual([6]);
  });
});

describe('exposure rules', () => {
  const t = () => locationThreat({ ops: fakeOps, truth: secret(DEMO_TRUTH) });
  const verdict = (over: Partial<Parameters<ReturnType<typeof t>['exposed']>[0]>) => ({
    place: 'x', lat: 0, lon: 0, radiusKm: 1, confidence: 'high', clues: [], errorKm: 500, ...over,
  });

  it('counts a readable address as exposure even when the AI picked the wrong city (live run: Barcelona, 206 km off)', () => {
    const v = verdict({ place: 'Carrer de la Llum, Barcelona', errorKm: 206, clues: [{ cell: 3, kind: 'text', what: 'street sign' }, { cell: 7, kind: 'number', what: '23' }] });
    expect(t().exposureReason(v)).toBe('readable');
    expect(t().exposed(v)).toBe(true);
  });

  it('does not count a low-confidence guess from generic hints (live run: Rome, 950 km off)', () => {
    const v = verdict({ place: 'Rome', confidence: 'low', errorKm: 950, clues: [{ cell: 4, kind: 'architecture', what: 'balcony' }] });
    expect(t().exposed(v)).toBe(false);
  });

  it('counts a guess near the real location, whatever the clues', () => {
    expect(t().exposureReason(verdict({ errorKm: 3, confidence: 'low' }))).toBe('near');
  });
});

describe('people are not location clues', () => {
  it('drops faces and bodies so a selfie is never pixelated', async () => {
    const ledger = new Ledger();
    const answer = { clues: [{ cell: 10, kind: 'other', what: 'person' }, { cell: 13, kind: 'other', what: "Part of a person's body (shoulder)" }, { cell: 3, kind: 'text', what: 'Street sign' }] };
    const nano = { name: 'nano', generate: async () => ({ text: JSON.stringify(answer), source: 'on_device' as const }) };
    const kit = { local: new LocalModel(nano, ledger), cloud: new CloudModel(nano, ledger), ledger };
    const clues = await locationThreat({ ops: fakeOps, scans: 1 }).findClues(secret(PHOTO), kit);
    expect(clues.map((c) => c.cell)).toEqual([3]);
  });
});
