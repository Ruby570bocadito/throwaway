import { beforeEach, describe, expect, it } from 'vitest';
import { clearTaint, CloudModel, Ledger, LocalModel, PrivacyViolation, redTeam, release, secret } from '../framework';
import { demoBackends } from '../demo/recorded';
import { distanceKm, locationThreat, type ImageOps } from './location';
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

  it('without ground truth trusts a sure, precise claim; with it, a confident wrong guess is not exposure', () => {
    const t1 = locationThreat({ ops: fakeOps });
    const t2 = locationThreat({ ops: fakeOps, truth: secret(DEMO_TRUTH) });
    const tokyo = { place: 'Tokyo', lat: 35.68, lon: 139.65, radiusKm: 10, confidence: 'high', clues: [], errorKm: null };
    expect(t1.exposed(tokyo)).toBe(true); // a sure 10 km claim, and nothing to check it against
    expect(t1.exposed({ ...tokyo, confidence: 'low' })).toBe(false); // an unsure claim is not exposure
    expect(t2.exposed({ ...tokyo, errorKm: distanceKm(tokyo, DEMO_TRUTH) })).toBe(false); // it is 10,000+ km off
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
    await expect(locationThreat({ ops: { ...fakeOps, maskCells: async (p) => p } }).sanitize(secret(PHOTO), [], null, kit)).rejects.toBeInstanceOf(PrivacyViolation);
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
