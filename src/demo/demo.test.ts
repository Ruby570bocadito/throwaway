// Pins the recorded run (`?demo`) end to end. The video and the README quote these outcomes, so any change to the
// framework, the rules or the stylometry must leave them exactly as they are: text 10/10 → 0/10, fingerprint #1 → #10,
// photo Palma 215 m off (it claimed 0.5 km) → "Tokyo, Japan" after hiding cells 3, 7, 8 (since 21-nov; it was Rome).

import { beforeEach, describe, expect, it } from 'vitest';
import { clearTaint, CloudModel, Ledger, LocalModel, publicData, redTeam, release, secret, type RedTeamEvent } from '../framework';
import { authorshipThreat, quotesNotIn, ruleDetails, type AuthorshipVerdict, type Clue } from '../threats/authorship';
import { locationThreat, type ImageOps, type LocationVerdict, type PhotoClue } from '../threats/location';
import { styleMarkers } from '../engine/stylometry';
import { buildAuthorship } from '../kit';
import { demoBackends } from './recorded';
import { DECOYS, DRAFT, MARTA_PUBLIC, REWRITE, SELF_ID } from './scenario';
import { DEMO_TRUTH } from './photo';

beforeEach(() => clearTaint());

const kitFor = () => {
  const ledger = new Ledger();
  const b = demoBackends();
  return { local: new LocalModel(b.local, ledger), cloud: new CloudModel(b.cloud, ledger), ledger };
};

const STYLE: Clue[] = [
  { phrase: 'so', kind: 'style', why: 'You use “so” 9× more than other writers' },
  { phrase: 'honestly', kind: 'style', why: 'You use “honestly” 53× more than other writers' },
  { phrase: 'kind', kind: 'style', why: 'You use “kind” 40× more than other writers' },
  { phrase: 'of', kind: 'style', why: 'You use “of” 4× more than other writers' },
  { phrase: 'anyway', kind: 'style', why: 'You use “anyway” 7× more than other writers' },
  { phrase: 'basically', kind: 'style', why: 'You use “basically” 40× more than other writers' },
  { phrase: 'sorry', kind: 'style', why: 'You use “sorry” 27× more than other writers' },
  { phrase: 'so honestly i', kind: 'style', why: 'Exact phrase from your public posts' },
];

const CONTENT: Clue[] = [
  { phrase: 'three years', why: 'Indicates tenure at the company.', kind: 'content' },
  { phrase: 'March reorg', why: 'Specific event date, likely internally referenced.', kind: 'content' },
  { phrase: 'Lisbon office', why: 'Specific location.', kind: 'content' },
  { phrase: '6 people to 2', why: 'Team size change, precise numbers.', kind: 'content' },
  { phrase: 'Figma migration', why: 'Internal project name.', kind: 'content' },
  { phrase: 'six months', why: 'A count: fixed rule, no AI.', kind: 'content' },
];

const PUBLISHED =
  "An attachment to this organization existed for a period of several years; however, the preceding several months have presented challenges. Following a restructuring, the design team's personnel transitioned from numerous individuals to a smaller number, without explanation. The expectation became to deliver the transition with reduced staffing levels while maintaining the same timeline. Management intends positively, yet responsiveness appears lacking. Consequently, individuals in design roles should carefully consider this proposition.";

describe('recorded text run (v5, 16-nov)', () => {
  it('replays the same clues, rewrite, attacks and fingerprints', async () => {
    const kit = kitFor();
    const threat = authorshipThreat({
      selfId: SELF_ID,
      self: publicData(MARTA_PUBLIC, 'blog'),
      decoys: DECOYS.map((d) => ({ id: d.id, text: publicData(d.corpus, 'decoy') })),
    });
    const events: RedTeamEvent<string, Clue, AuthorshipVerdict>[] = [];
    for await (const e of redTeam(threat, secret(DRAFT, 'draft'), kit, { asIs: release(DRAFT, 'baseline', { userConfirmedAsIs: true }) })) events.push(e);

    expect(events.map((e) => e.type)).toEqual(['clues', 'attacked', 'sanitized', 'attacked', 'safe']);
    expect((events[0] as { clues: Clue[] }).clues).toEqual([...STYLE, ...CONTENT]);
    const attacks = events.filter((e) => e.type === 'attacked') as { verdict: AuthorshipVerdict }[];
    expect(attacks.map((a) => [a.verdict.hits, a.verdict.answered])).toEqual([[10, 10], [0, 10]]);
    expect(attacks[1].verdict.picks.filter((p) => p === 'd1')).toHaveLength(9);
    // The reasons say whose they are, and name that writer by its letter in that attempt's shuffle (the screen puts it back
    // to the writer's seat): before the rewrite they are about the author; after it, about the last writer picked.
    const [asIs, rewritten] = attacks.map((a) => a.verdict);
    expect(asIs.reasonsPick).toBe(SELF_ID);
    const letter = 'ABCDEFGHIJ'[asIs.reasonsOrder!.indexOf(SELF_ID)];
    expect(asIs.reasons[2]).toBe(`Strong conversational stylometry matching Writer ${letter}'s specific syntactic rhythm.`);
    // The reasons quote d1's own text ("organisation", "review", "staffing"): they are d1's, the writer picked 9 times.
    expect(rewritten.reasonsPick).toBe('d1');
    expect(rewritten.reasonsOrder).toHaveLength(10);
    const d1 = DECOYS.find((d) => d.id === 'd1')!.corpus;
    expect(quotesNotIn(rewritten.reasons[2], `${PUBLISHED}\n${d1}`)).toEqual([]);

    const published = (events[2] as { published: { value: string } }).published.value;
    expect(published).toBe(PUBLISHED);
    expect(threat.lastRewrite?.generalised).toEqual([
      { phrase: 'Figma migration', generic: 'migration', by: 'rule' },
      { phrase: 'Lisbon office', generic: 'office', by: 'rule' },
      { phrase: '6 people to 2', generic: 'several people to a few', by: 'rule' },
      { phrase: 'three years', generic: 'several years', by: 'rule' },
      { phrase: 'March reorg', generic: 'reorg', by: 'rule' },
      { phrase: 'six months', generic: 'several months', by: 'rule' },
    ]);
    expect(threat.lastRewrite?.detailsLeft).toEqual([]);
    expect(threat.lastRewrite?.claims.map((c) => c.kept)).toEqual([true, true, true, true, true, true]);

    // The local fingerprint: #1 of 10 before, #10 of 10 after (README: "fingerprint #10 of 10").
    const before = threat.fingerprint(DRAFT);
    const after = threat.fingerprint(published);
    expect([before.rank, before.score]).toEqual([1, 1]);
    expect([after.rank, after.score]).toEqual([10, 0]);
    expect(before.ranked[0].delta).toBeCloseTo(0.820018, 5);
    expect(after.ranked[9].delta).toBeCloseTo(1.426507, 5);
    expect(threat.fingerprint(REWRITE).rank).toBe(10);
    expect(buildAuthorship(() => undefined).fingerprint(DRAFT).rank).toBe(1);

    // The same steps, in the same places.
    const steps = kit.ledger.all.map((e) => `${e.op}|${e.route}`).reverse();
    expect(steps.slice(0, 3)).toEqual([
      'Fingerprint (Burrows’ Delta)|local-js',
      'Find identifying details|on-device',
      'Find counts and dates (fixed rules)|local-js',
    ]);
    expect(steps.filter((s) => s.endsWith('|cloud'))).toHaveLength(20);
    expect(steps.slice(13, 17)).toEqual([
      'Fixed rules generalised 6 details|local-js',
      'Rewrite on-device|on-device',
      'Check the final text for details|local-js',
      'Meaning check|on-device',
    ]);
  }, 30_000);

  it('shows the same style habits and rule-found details on screen', () => {
    expect(styleMarkers(DRAFT, MARTA_PUBLIC, DECOYS.map((d) => d.corpus))).toEqual(STYLE);
    expect(styleMarkers(PUBLISHED, MARTA_PUBLIC, DECOYS.map((d) => d.corpus))).toEqual([
      { phrase: 'of', kind: 'style', why: 'You use “of” 4× more than other writers' },
    ]);
    // The range is one detail since 17-nov: "6 people to 2" generalises to "several people to a few".
    expect(ruleDetails(DRAFT).map((d) => d.phrase)).toEqual(['March', '6 people to 2', 'three years', 'six months']);
  });
});

describe('recorded photo run (15/16-nov)', () => {
  const fakeOps: ImageOps = {
    withGrid: async (png) => new Uint8Array([...png, 250]),
    maskCells: async (png, cells) => new Uint8Array([...png, 251, ...cells]),
  size: async () => ({ width: 400, height: 300 }),
  faces: async () => [],
  crop: async (png, r) => new Uint8Array([...png.slice(0, 8), 252, r.x % 251, r.y % 251]),
  paint: async (png, regions) => new Uint8Array([...png, 253, ...regions.map((g) => g.cell)]),
  };
  const PHOTO = new Uint8Array(Array.from({ length: 64 }, (_, i) => (i * 37) % 251));

  it('replays Palma 215 m off (claiming 0.5 km), then "Tokyo, Japan" after hiding the street name, number and shop sign', async () => {
    const kit = kitFor();
    const threat = locationThreat({ ops: fakeOps, truth: secret(DEMO_TRUTH, 'real location') });
    const events: RedTeamEvent<Uint8Array, PhotoClue, LocationVerdict>[] = [];
    for await (const e of redTeam(threat, secret(PHOTO, 'photo'), kit, { asIs: release(PHOTO, 'baseline', { userConfirmedAsIs: true }) })) events.push(e);

    expect(events.map((e) => e.type)).toEqual(['clues', 'attacked', 'sanitized', 'attacked', 'safe']);
    expect((events[0] as { clues: PhotoClue[] }).clues.map((c) => c.cell)).toEqual([3, 7, 8, 12, 1]);
    const [asIs, masked] = (events.filter((e) => e.type === 'attacked') as { verdict: LocationVerdict }[]).map((a) => a.verdict);
    expect(asIs.place).toBe('Carrer de la Llum, 23, Palma, Mallorca, Spain');
    expect(asIs.radiusKm).toBe(0.5);
    expect(threat.tier(asIs)).toBe('street');
    expect(threat.exposureReason(asIs)).toBe('readable');
    expect(threat.masked).toEqual([3, 7, 8]); // the poster in 1 has nothing to read, the tree in 12 only says the city
    expect(masked.place).toBe('Tokyo, Japan');
    expect(masked.confidence).toBe('low');
    // Palma → Tokyo. The landing page and the README still quote Rome (869 km): they change with this photo work.
    expect(Math.round(masked.errorKm ?? 0)).toBe(10559);
    expect(threat.tier(masked)).toBe('safe');
    expect(threat.leftVisible).toEqual([]);
  }, 30_000);
});
