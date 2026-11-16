import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTaint, CloudModel, Ledger, LocalModel, PrivacyViolation, Publishable, publicData, recordedBackend, redTeam, release, secret,
} from './index';
import { authorshipThreat } from '../threats/authorship';
import { demoBackends } from '../demo/recorded';
import { DECOYS, DRAFT, MARTA_PUBLIC, REWRITE, SELF_ID } from '../demo/scenario';

const echo = recordedBackend('echo', () => 'ok', 0);

beforeEach(() => clearTaint());

describe('privacy contract', () => {
  it('rejects a Private value in a cloud call at compile time and at run time', async () => {
    const ledger = new Ledger();
    const cloud = new CloudModel(echo, ledger);
    const draft = secret(DRAFT, 'draft');
    // @ts-expect-error — Private is not a CloudPart
    await expect(cloud.generate([draft], { op: 'leak' })).rejects.toBeInstanceOf(PrivacyViolation);
    expect(ledger.all[0].route).toBe('blocked');
    expect(ledger.bytesOut).toBe(0);
  });

  it('blocks private text smuggled into a plain string', async () => {
    const ledger = new Ledger();
    const cloud = new CloudModel(echo, ledger);
    secret(DRAFT, 'draft');
    await expect(cloud.generate(['Summarise: ' + DRAFT], { op: 'smuggle' })).rejects.toBeInstanceOf(PrivacyViolation);
    expect(ledger.bytesOut).toBe(0);
  });

  it('only lets released images reach the cloud', async () => {
    const ledger = new Ledger();
    const cloud = new CloudModel(echo, ledger);
    const photo = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    secret(photo, 'photo');
    // An unreleased image smuggled with `as any` is refused.
    await expect(
      cloud.generate([{ image: { value: photo } as unknown as Publishable<Uint8Array>, mime: 'image/png' }], { op: 'img' }),
    ).rejects.toBeInstanceOf(PrivacyViolation);
    // The original cannot be released without the user's confirmation; a modified copy can.
    expect(() => release(photo, 'blurred?')).toThrow(PrivacyViolation);
    expect(() => release(new Uint8Array([1, 2, 3, 0, 0, 0, 7, 8, 9]), 'masked')).not.toThrow();
    await expect(cloud.generate([{ image: release(photo, 'as is', { userConfirmedAsIs: true }), mime: 'image/png' }], { op: 'img' })).resolves.toBeTruthy();
    // The same bytes as text (a binary string or base64) are still the private photo.
    await expect(cloud.generate([publicData(String.fromCharCode(...photo))], { op: 'img' })).rejects.toBeInstanceOf(PrivacyViolation);
    // Known limit, documented: a re-encoded copy (decoded and encoded again, so other bytes) is not recognised.
    await expect(cloud.generate([publicData(String.fromCharCode(...photo.map((b) => b + 1)))], { op: 'img' })).resolves.toBeTruthy();
  });

  it('only release() can mint a Publishable', () => {
    expect(() => new (Publishable as unknown as new (v: string, r: string, t: number) => unknown)('x', 'sneaky', 0)).toThrow(PrivacyViolation);
  });

  it('refuses to release text that still carries the private original, unless the user confirms', () => {
    secret(DRAFT, 'draft');
    expect(() => release(DRAFT, 'lazy rewrite')).toThrow(PrivacyViolation);
    expect(() => release(DRAFT, 'as is', { userConfirmedAsIs: true })).not.toThrow();
    expect(() => release(REWRITE, 'rewrite')).not.toThrow();
  });

  it('lets local models read private data and records 0 bytes out', async () => {
    const ledger = new Ledger();
    const local = new LocalModel(echo, ledger);
    await local.generate(['Rewrite:', secret(DRAFT)], { op: 'rewrite' });
    expect(ledger.all[0]).toMatchObject({ route: 'on-device', bytesOut: 0 });
  });

  it('refuses a local model that was served from the cloud', async () => {
    const ledger = new Ledger();
    const sneaky = { name: 'sneaky', generate: async () => ({ text: 'x', source: 'in_cloud' as const }) };
    const local = new LocalModel(sneaky, ledger);
    await expect(local.generate([secret(DRAFT)], { op: 'rewrite' })).rejects.toBeInstanceOf(PrivacyViolation);
  });
});

describe('the red-team loop', () => {
  /** A threat whose attacker always finds you, and whose sanitizer can only do `steps` different things. */
  const stubborn = (steps: number) => {
    let sanitized = 0;
    let attacked = 0;
    const threat = {
      id: 'stub',
      question: 'Who?',
      findClues: async () => [],
      sanitize: async () => release(`version ${Math.min(++sanitized, steps)} of a harmless sentence`, 'stub'),
      attack: async () => (attacked++, { found: true }),
      exposed: (v: { found: boolean }) => v.found,
    };
    return { threat, attacks: () => attacked };
  };
  const kit = () => {
    const ledger = new Ledger();
    return { local: new LocalModel(echo, ledger), cloud: new CloudModel(echo, ledger), ledger };
  };

  it('stops when a round changes nothing, instead of attacking the same thing again', async () => {
    const s = stubborn(2);
    const events = [];
    for await (const e of redTeam(s.threat, secret('my draft'), kit(), { maxRounds: 5 })) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['clues', 'sanitized', 'attacked', 'sanitized', 'attacked', 'gave-up']);
    expect(s.attacks()).toBe(2);
    expect(events[events.length - 1]).toMatchObject({ round: 2, published: { value: 'version 2 of a harmless sentence' } });
  });

  it('always runs at least one round without a baseline', async () => {
    const s = stubborn(9);
    const events = [];
    for await (const e of redTeam(s.threat, secret('my draft'), kit(), { maxRounds: 0 })) events.push(e);
    expect(events.map((e) => e.type)).toEqual(['clues', 'sanitized', 'attacked', 'gave-up']);
  });
});

describe('authorship threat on the demo scenario', () => {
  it('is exposed as-is, safe after the on-device rewrite, and the draft never leaves', async () => {
    const ledger = new Ledger();
    const b = demoBackends();
    const kit = { local: new LocalModel(b.local, ledger), cloud: new CloudModel(b.cloud, ledger), ledger };
    const threat = authorshipThreat({
      selfId: SELF_ID,
      self: publicData(MARTA_PUBLIC, 'blog'),
      decoys: DECOYS.map((d) => ({ id: d.id, text: publicData(d.corpus, 'decoy') })),
    });
    const draft = secret(DRAFT, 'draft');
    const events = [];
    for await (const e of redTeam(threat, draft, kit, { asIs: release(DRAFT, 'baseline', { userConfirmedAsIs: true }) })) events.push(e);

    const attacks = events.filter((e) => e.type === 'attacked');
    expect(attacks[0]).toMatchObject({ exposed: true });
    // Recorded real answers: 10/10 before the rewrite, 0/10 after.
    expect((attacks[0] as { verdict: { hits: number } }).verdict.hits).toBe(10);
    expect((attacks[1] as { verdict: { hits: number } }).verdict.hits).toBe(0);
    expect(attacks[1]).toMatchObject({ exposed: false });
    expect(events[events.length - 1]?.type).toBe('safe');

    // Deterministic fingerprint agrees: #1 before, last after.
    expect(threat.fingerprint(DRAFT).rank).toBe(1);
    expect(threat.fingerprint(REWRITE).rank).toBe(10);

    // Every on-device call sent 0 bytes; only the 20 attack calls went to the cloud.
    expect(ledger.all.filter((e) => e.route === 'on-device').every((e) => e.bytesOut === 0)).toBe(true);
    expect(ledger.all.filter((e) => e.route === 'cloud')).toHaveLength(20);
  }, 30_000);
});
