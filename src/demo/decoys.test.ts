import { beforeEach, describe, expect, it } from 'vitest';
import { clearTaint, CloudModel, Ledger, LocalModel, release, type ModelBackend } from '../framework';
import { burrowsDelta, tokenize } from '../engine/stylometry';
import { identifiers } from '../threats/authorship';
import { buildAuthorship, lineupField } from '../kit';
import * as decoyPacks from './decoys';
import { choosePack, DECOY_PACK_IDS, DECOY_PACKS } from './decoys';
import { DECOYS, DRAFT } from './scenario';

beforeEach(() => clearTaint());

const DRAFTS = {
  healthcare:
    'I have worked night shifts on this ward for four years. Staffing is so bad that one nurse covers eleven patients, and management keeps adding charting to every handover. Patients wait for their meds while we type.',
  education:
    'After six years teaching at this school I am leaving. Class sizes went up, marking doubled, and the head teacher ignores every department meeting. The kids deserve better lessons than the ones we plan at midnight.',
  technology:
    'Our engineering team ships every week but on-call is brutal: the pager goes off at night, the legacy codebase has no tests, and the CTO wants microservices for a product with twelve developers.',
  finance:
    'Month-end close at this firm means fourteen-hour days. The audit found the same reconciliation errors two years running, the CFO blames the analysts, and the budget forecast is fiction.',
  // A store review a test user wrote went to healthcare ("shift", "staffing"), and the attacker found him by subject (17-nov).
  retail:
    'Our regional manager humiliates staff in meetings. I have run this store for four years. We are short-staffed every weekend, customers wait at the tills, and shift cover is a nightmare. Head office ignores every complaint about staffing.',
};

describe('decoy packs', () => {
  it('have nine writers each, with ids unique across packs, and the design pack is the recorded run’s', () => {
    expect(DECOY_PACKS.design.decoys).toBe(DECOYS);
    const ids = DECOY_PACK_IDS.flatMap((p) => DECOY_PACKS[p].decoys.map((d) => d.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of DECOY_PACK_IDS) expect(DECOY_PACKS[p].decoys).toHaveLength(9);
  });

  it('the new writers have 150–300 words each and nothing anyone could look up', () => {
    for (const p of DECOY_PACK_IDS.filter((x) => x !== 'design')) {
      for (const d of DECOY_PACKS[p].decoys) {
        const words = tokenize(d.corpus).length;
        expect(words, `${d.id}: ${words} words`).toBeGreaterThanOrEqual(150);
        expect(words, `${d.id}: ${words} words`).toBeLessThanOrEqual(300);
        expect(identifiers(d.corpus), d.id).toEqual([]);
      }
    }
  });

  it('cover the same range of habits as the design pack, so style, not topic, is what the attacker has to read', () => {
    const habits = (t: string) => {
      const sentences = t.split(/(?<=[.!?])\s+|\n+/).filter((s) => /\p{L}/u.test(s));
      return {
        bangs: (t.match(/!/g) ?? []).length,
        semicolons: (t.match(/;/g) ?? []).length,
        lowercase: sentences.filter((s) => /^[a-z]/.test(s.trim())).length / sentences.length,
        meanWords: tokenize(t).length / sentences.length,
      };
    };
    for (const p of DECOY_PACK_IDS.filter((x) => x !== 'design')) {
      const h = DECOY_PACKS[p].decoys.map((d) => habits(d.corpus));
      expect(h.some((x) => x.bangs >= 5), `${p}: an enthusiast`).toBe(true);
      expect(h.some((x) => x.semicolons >= 5), `${p}: an aphorist`).toBe(true);
      expect(h.some((x) => x.lowercase >= 0.5), `${p}: someone who never capitalises`).toBe(true);
      expect(h.some((x) => x.meanWords < 6), `${p}: a terse log`).toBe(true);
      expect(h.some((x) => x.meanWords > 17), `${p}: long, formal sentences`).toBe(true);
    }
  });

  it('are each on their field: the chooser puts most writers of a pack back in their own pack', () => {
    for (const p of DECOY_PACK_IDS.filter((x) => x !== 'design')) {
      const home = DECOY_PACKS[p].decoys.filter((d) => choosePack(d.corpus).id === p).length;
      expect(home, p).toBeGreaterThanOrEqual(7);
    }
  });

  it('the full texts are told apart by Burrows’ Delta (each is its own closest writer)', () => {
    for (const p of DECOY_PACK_IDS) for (const d of DECOY_PACKS[p].decoys) expect(burrowsDelta(d.corpus, DECOY_PACKS[p].decoys)[0].id).toBe(d.id);
  });
});

describe('choosing the pack that matches the draft', () => {
  it.each(Object.entries(DRAFTS))('%s', (field, draft) => {
    expect(choosePack(draft).id).toBe(field);
  });

  it('puts a restaurant kitchen in retail and hospitality', () => {
    expect(choosePack('The kitchen is chaos every Friday. Our head chef shouts at the waiters, tips are split unfairly and the owner cuts shifts without notice.').id).toBe('retail');
  });

  it('keeps the recorded demo, and anything without a clear field, on design', () => {
    expect(choosePack(DRAFT).id).toBe('design');
    expect(choosePack('The restaurant was lovely and the pasta was great, but the service was slow.').id).toBe('design');
    expect(choosePack('').id).toBe('design');
  });

  it('says which of the field’s words it matched, and is deterministic', () => {
    const r = choosePack(DRAFTS.healthcare);
    expect(r.matched).toEqual(expect.arrayContaining(['nurse', 'patient', 'ward', 'handover']));
    expect(choosePack(DRAFTS.healthcare)).toEqual(r);
  });
});

describe('the field of the lineup', () => {
  it('follows the writing that stands for the user, not the post', () => {
    // No public writing of the user's: the sample writer, a designer, stands in, and so do the designers next to her,
    // whatever the post is about (finance writers next to a designer would hide her by subject).
    expect(lineupField('', decoyPacks).field).toBe('design');
    expect(lineupField('   ', decoyPacks, 'finance').field).toBe('design');
    // The user's own writing sets the field, and the user can pick another one.
    expect(lineupField(DRAFTS.healthcare, decoyPacks)).toEqual({ matched: 'healthcare', clear: true, wanted: 'healthcare', field: 'healthcare' });
    expect(lineupField(DRAFTS.healthcare, decoyPacks, 'finance')).toMatchObject({ matched: 'healthcare', field: 'finance' });
    // Writing with no clear field stays with the designers, and says so.
    expect(lineupField('The restaurant was lovely and the pasta was great, but the service was slow.', decoyPacks)).toMatchObject({ field: 'design', clear: false });
    // Until the packs load, the designers stay.
    expect(lineupField(DRAFTS.healthcare, null)).toMatchObject({ field: 'design', clear: true });
  });
});

describe('buildAuthorship with the lineup of a field', () => {
  it('stays on design by default (the recorded run), and attacks with the writers it is given', async () => {
    expect(buildAuthorship(() => undefined).fingerprint(DRAFT).ranked.map((r) => r.id).sort()).toEqual(['marta', ...DECOYS.map((d) => d.id)].sort());
    const threat = buildAuthorship(() => undefined, '', DECOY_PACKS[choosePack(DRAFTS.healthcare).id].decoys);
    expect(threat.fingerprint(DRAFTS.healthcare).ranked.map((r) => r.id)).toEqual(expect.arrayContaining(['h1', 'h9']));

    // The attacker gets the healthcare writers next to the user, not the designers.
    const prompts: string[] = [];
    const cloud: ModelBackend = {
      name: 'cloud',
      generate: async (parts) => {
        prompts.push(parts.map((p) => ('text' in p ? p.text : '')).join('\n'));
        return { text: '{"pick":"A","confidence":"low","reasons":[]}', source: 'in_cloud' };
      },
    };
    const ledger = new Ledger();
    await threat.attack(release('A short post about a long week on the ward.', 'test'), { local: new LocalModel(cloud, ledger), cloud: new CloudModel(cloud, ledger), ledger });
    expect(prompts[0]).toContain(DECOY_PACKS.healthcare.decoys[0].corpus.slice(0, 60));
    expect(prompts[0]).not.toContain(DECOYS[0].corpus.slice(0, 60));
  });
});
