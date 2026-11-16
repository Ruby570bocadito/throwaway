import { beforeEach, describe, expect, it } from 'vitest';
import { clearTaint, CloudModel, Ledger, LocalModel, PrivacyViolation, redTeam, release, secret } from '../framework';
import { demoBackends } from '../demo/recorded';
import { distanceKm, isIdentifier, locationThreat, type ImageOps } from './location';
import { DEMO_TRUTH } from '../demo/photo';

// Fake image ops: no canvas in Node. Masking appends the masked cells, so the bytes change like a real edit would.
const fakeOps: ImageOps = {
  withGrid: async (png) => new Uint8Array([...png, 250]),
  maskCells: async (png, cells) => new Uint8Array([...png, 251, ...cells]),
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
    // Recorded real answers: Palma (≈0.2 km from the scene) as-is, then Rome after masking the five cells Nano flagged.
    expect(attacks[0].verdict.errorKm).toBeLessThan(1);
    expect(attacks[1].verdict.place).toBe('Rome, Italy');
    expect(attacks[1].verdict.errorKm).toBeGreaterThan(500);
    expect(attacks.map((a) => a.exposed)).toEqual([true, false]);
    expect(events[events.length - 1].type).toBe('safe');
    expect(threat.masked).toEqual([1, 3, 7, 8, 12]);
    expect(ledger.all.filter((e) => e.route === 'on-device').every((e) => e.bytesOut === 0)).toBe(true);
    expect(ledger.all.filter((e) => e.route === 'cloud')).toHaveLength(2);
  }, 30_000);

  it('keeps the photo usable: identifiers always go, facades only within the budget (Paris street, live 16-nov)', async () => {
    const ledger = new Ledger();
    const b = demoBackends();
    const kit = { local: new LocalModel(b.local, ledger), cloud: new CloudModel(b.cloud, ledger), ledger };
    const t = locationThreat({ ops: fakeOps });
    // Gemini Nano flagged a facade in every cell, plus a street sign and a church tower.
    const facades = Array.from({ length: 16 }, (_, i) => ({ cell: i + 1, kind: 'architecture', what: 'Haussmann facade with balconies' }));
    const clues = [...facades, { cell: 14, kind: 'text', what: 'Blue street sign reading Rue Oberkampf' }, { cell: 9, kind: 'landmark', what: 'Church tower' }];
    const feedback = { place: 'Paris', lat: 48.86, lon: 2.37, radiusKm: 0.5, confidence: 'high', errorKm: null, clues: [{ cell: 5, kind: 'architecture', what: 'Zinc roofs' }] };
    await t.sanitize(secret(PHOTO, 'photo'), clues, feedback, kit);
    expect(t.masked).toHaveLength(6); // not 16: the photo is still worth posting
    expect(t.masked).toContain(14); // the street sign, always
    expect(t.masked).toContain(9); // a landmark before plain facades
    expect(t.masked).toContain(5); // the facade the attacker used, before the others
    expect(t.leftVisible).toHaveLength(10);
    expect(ledger.all.find((e) => e.op === 'Pixelate 6 cells')?.note).toBe('kept 10 cells visible so the photo stays usable');

    // A later round that only cites facades adds nothing; one that reads a house number still masks it, budget or not.
    await t.sanitize(secret(PHOTO, 'photo'), [], { ...feedback, clues: [{ cell: 10, kind: 'architecture', what: 'Balconies' }] }, kit);
    expect(t.masked).toHaveLength(6);
    await t.sanitize(secret(PHOTO, 'photo'), [], { ...feedback, clues: [{ cell: 11, kind: 'number', what: 'House number 23' }] }, kit);
    expect(t.masked).toContain(11);
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
    await expect(locationThreat({ ops: { ...fakeOps, maskCells: async (p) => p } }).sanitize(secret(PHOTO), sign, null, kit)).rejects.toBeInstanceOf(PrivacyViolation);
  });

  it('with nothing flagged, says there is nothing to mask instead of a scary privacy block (the no-op re-encode is the original)', async () => {
    const ledger = new Ledger();
    const b = demoBackends();
    const kit = { local: new LocalModel(b.local, ledger), cloud: new CloudModel(b.cloud, ledger), ledger };
    const err = await locationThreat({ ops: { ...fakeOps, maskCells: async (p) => p } })
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
    const nano = { name: 'nano', generate: async () => ({ text: JSON.stringify(answers[call++]), source: 'on_device' as const }) };
    const kit = { local: new LocalModel(nano, ledger), cloud: new CloudModel(nano, ledger), ledger };
    const clues = await locationThreat({ ops: fakeOps }).findClues(secret(PHOTO), kit);
    expect(clues.map((c) => c.cell).sort((a, b) => a - b)).toEqual([1, 3, 7, 12]);
    expect(ledger.all.filter((e) => e.route === 'on-device')).toHaveLength(2);
    expect(ledger.bytesOut).toBe(0);
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
