import { beforeEach, describe, expect, it } from 'vitest';
import { clearTaint, CloudModel, isTemporary, Ledger, LocalModel, publicData, release, secret, type ModelBackend } from '../framework';
import { authorshipThreat, deterministicGeneralise, hasPhrase, isSpecific, looksBroken, newSpecifics } from './authorship';
import { CONTENT_DETAILS, DECOYS, DRAFT, MARTA_PUBLIC, NANO_REWRITE_RECORDED, NANO_REWRITE_V3_RECORDED, REWRITE, SELF_ID } from '../demo/scenario';

beforeEach(() => clearTaint());

const threatFor = () =>
  authorshipThreat({
    selfId: SELF_ID,
    self: publicData(MARTA_PUBLIC, 'blog'),
    decoys: DECOYS.map((d) => ({ id: d.id, text: publicData(d.corpus, 'decoy') })),
  });

/** A scripted on-device model; each handler receives the full prompt text. */
const nanoScript = (handle: (prompt: string) => object): ModelBackend => ({
  name: 'nano',
  generate: async (parts) => ({ text: JSON.stringify(handle(parts.map((p) => ('text' in p ? p.text : '')).join('\n'))), source: 'on_device' }),
});

/**
 * Runs sanitize with the details found by the scan (by default the five REAL ones). "Nano" rewrites the draft it is
 * given with `rewrite`; every prompt it receives is recorded, so tests can check what the model saw.
 */
async function runWith(rewrite: (draftSeen: string) => string, draft = DRAFT, details: { phrase: string; why: string }[] = CONTENT_DETAILS) {
  const prompts: string[] = [];
  const nano = nanoScript((prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith('Rewrite the DRAFT')) return { rewrite: rewrite((prompt.split('DRAFT:\n')[1] ?? '').trim()) };
    if (prompt.startsWith('Compare the ORIGINAL')) return { claims: [{ claim: 'Team was cut', kept: true }, { claim: ' ', kept: true }, { claim: 'Deadline unchanged', kept: false }] };
    return {};
  });
  const ledger = new Ledger();
  const kit = { local: new LocalModel(nano, ledger), cloud: new CloudModel(nano, ledger), ledger };
  const threat = threatFor();
  const clues = details.map((d) => ({ ...d, kind: 'content' as const }));
  const published = await threat.sanitize(secret(draft, 'draft'), clues, null, kit);
  return { published, threat, ledger, prompts };
}

/** The real draft after the fixed rules, for the five real details: what Gemini Nano now gets to rewrite. */
const RULED_DRAFT =
  'So, honestly, I loved this company for several years — but the last six months have been kind of a mess. Anyway, after the reorg our design team in the office went from several people to a few (and nobody told us why). Basically we were asked to ship the migration with half the people and the same deadline. Honestly, management means well, but they do not listen — they announce. So, if you are a designer, think twice (sorry not sorry).';

/** The five details left in the real v3 run (the author's Chrome, 16-nov). */
const V3_LEFT = ['three years', 'March', 'Lisbon office', 'six individuals to two', 'Figma migration'];
const V3_RULED =
  "The tenure with the organization spanned several years. Recent organizational changes, implemented recently, significantly altered the structure of the design team located in the office. The team's size reduced from several individuals to a few. A key directive arose to implement a migration within this diminished team structure, maintaining the original project timeline. Management communicated the direction, yet feedback mechanisms appeared ineffective. The situation presents challenges for those in design roles.";

describe('deterministic helpers', () => {
  const text = 'My tenure was three years. The design team was based in the Lisbon office. We shipped the Figma migration.';
  it('isSpecific keeps numbers, dates and proper nouns', () => {
    expect(isSpecific('three years', text)).toBe(true);
    expect(isSpecific('Lisbon office', text)).toBe(true);
    expect(isSpecific('Figma migration', text)).toBe(true);
    expect(isSpecific('6 people to 2', '6 people to 2')).toBe(true);
    expect(isSpecific('March reorg', 'after the March reorg')).toBe(true);
    expect(isSpecific('one year', 'I stayed one year')).toBe(true);
  });
  it('isSpecific drops the generic words Gemini Nano over-flagged in the live run', () => {
    expect(isSpecific('team', text)).toBe(false);
    expect(isSpecific('a period of time', text)).toBe(false);
    expect(isSpecific('design roles', text)).toBe(false);
    expect(isSpecific('My tenure', text)).toBe(false); // capitalised only because it starts a sentence
    expect(isSpecific('one of the offices', text)).toBe(false); // our own generic wording
  });
  it('hasPhrase matches whole words only', () => {
    expect(hasPhrase('Our network is fine.', 'two')).toBe(false);
    expect(hasPhrase('It went from six to two.', 'two')).toBe(true);
    expect(hasPhrase('based in the Lisbon\noffice', 'lisbon office')).toBe(true);
    expect(hasPhrase('anything', '  ')).toBe(false);
  });
  it('newSpecifics finds the numbers, dates and names a rewrite added', () => {
    expect(newSpecifics('I worked there for three years. In March the Lisbon team was cut.', RULED_DRAFT).sort()).toEqual(['Lisbon', 'March', 'three']);
    expect(newSpecifics(REWRITE, RULED_DRAFT)).toEqual([]); // nothing specific in the demo's rewrite
    expect(newSpecifics('The last six months were hard. One of us left.', RULED_DRAFT)).toEqual([]); // already in the draft / "one"
  });
  it('looksBroken catches a placeholder repeated by the model', () => {
    const live = 'The tenure spanned what you wrote instead. A reorganization occurred in what you wrote instead. It went from what you wrote instead to two.';
    expect(looksBroken(live, NANO_REWRITE_RECORDED)).toBe(true);
    expect(looksBroken('I worked there for a few years. The team shrank a lot.', NANO_REWRITE_RECORDED)).toBe(false);
  });
});

describe('fixed rules (no model) for the details Nano could not generalise', () => {
  it('removes the five details Gemini Nano kept in the live v3 run, and nothing else', () => {
    const r = deterministicGeneralise(NANO_REWRITE_V3_RECORDED, V3_LEFT);
    expect(r.text).toBe(V3_RULED);
    expect(r.done).toEqual([
      { phrase: 'six individuals to two', generic: 'several individuals to a few' },
      { phrase: 'Figma migration', generic: 'migration' },
      { phrase: 'Lisbon office', generic: 'office' },
      { phrase: 'three years', generic: 'several years' },
      { phrase: 'March', generic: 'recently' },
    ]);
    for (const p of V3_LEFT) expect(hasPhrase(r.text, p)).toBe(false);
  });

  it.each([
    // dates
    ['Implemented in March, then shipped.', 'March', 'Implemented recently, then shipped.'],
    ['In March, we were reorganised.', 'March', 'Recently, we were reorganised.'],
    ['It happened after the March reorg.', 'March reorg', 'It happened after the reorg.'],
    ['It has been like this since March 2023.', 'March 2023', 'It has been like this for a while.'],
    ['We left at the end of March.', 'March', 'We left at the end of that month.'],
    ['Stand-ups every Monday at nine.', 'every Monday', 'Stand-ups every week at nine.'],
    ["Monday's meeting was tense.", 'Monday', "That day's meeting was tense."],
    ['The reorg on 14 February cut twenty-five jobs.', '14 February', 'The reorg recently cut twenty-five jobs.'],
    ['In March management announced it.', 'March', 'Recently management announced it.'],
    ['Our March reorg was a mess.', 'March reorg', 'Our reorg was a mess.'],
    // names
    ['We had to ship a Figma migration.', 'Figma', 'We had to ship a migration.'],
    ['The team was based in Lisbon.', 'Lisbon', 'The team was based somewhere.'],
    ['I raised it with Anna.', 'Anna', 'I raised it with [redacted].'],
    ['Our team at Google shipped it.', 'Google', 'Our team at [redacted] shipped it.'],
    ['Yesterday Anna said no.', 'Anna', 'Yesterday [redacted] said no.'],
    ['I worked in Lisbon for years.', 'Lisbon', 'I worked somewhere for years.'],
    ["Ask anyone in Anna's team.", "Anna's team", 'Ask anyone in the team.'],
    ['The Lisbon office is great. I miss the Lisbon office.', 'Lisbon office', 'The office is great. I miss the office.'],
    // numbers
    ['Three years in, I quit.', 'Three years', 'Several years in, I quit.'],
    ['Our network has two teams.', 'two', 'Our network has a few teams.'],
    ['Pay was cut by 15% this year.', '15%', 'Pay was cut by a portion this year.'],
    ['They offered me €50k.', '€50k', 'They offered me an amount.'],
    ['I stayed one year.', 'one year', 'I stayed about a year.'],
    ['It was a three-year contract.', 'three-year contract', 'It was a multi-year contract.'],
  ])('%s', (input, phrase, expected) => {
    const r = deterministicGeneralise(input, [phrase]);
    expect(r.text).toBe(expected);
    expect(hasPhrase(r.text, phrase)).toBe(false);
  });

  it('leaves codes alone instead of mangling them ("24/7", "COVID-19")', () => {
    const t = 'We followed a 24/7 on-call rota and the COVID-19 rules.';
    const r = deterministicGeneralise(t, ['24/7 on-call rota', 'COVID-19 rules']);
    expect(r.text).toBe(t);
    expect(r.done).toEqual([]);
  });
});

describe('rewrite: fixed rules first, then the style', () => {
  it('generalises the details in the draft BEFORE the rewrite, so Gemini Nano never sees them', async () => {
    let seen = '';
    const { published, threat, ledger, prompts } = await runWith((d) => {
      seen = d;
      return REWRITE;
    });
    expect(seen).toBe(RULED_DRAFT);
    expect(seen).not.toMatch(/three years|March|Lisbon|6 people|Figma/);
    expect(published.value).toBe(REWRITE);
    expect(threat.lastRewrite?.generalised).toEqual([
      { phrase: 'Figma migration', generic: 'migration', by: 'rule' },
      { phrase: 'Lisbon office', generic: 'office', by: 'rule' },
      { phrase: '6 people to 2', generic: 'several people to a few', by: 'rule' },
      { phrase: 'three years', generic: 'several years', by: 'rule' },
      { phrase: 'March reorg', generic: 'reorg', by: 'rule' },
    ]);
    expect(threat.lastRewrite?.detailsLeft).toEqual([]);
    expect(threat.lastRewrite?.claims).toEqual([
      { claim: 'Team was cut', kept: true },
      { claim: 'Deadline unchanged', kept: false },
    ]);
    // Live v4 (16-nov): Nano copied our prompt's examples into the text. Now there are none, and only two model calls.
    expect(prompts.map((p) => p.slice(0, 20))).toEqual(['Rewrite the DRAFT so', 'Compare the ORIGINAL']);
    expect(prompts[0]).not.toMatch(/for example|Generalise these details/);
    expect(ledger.all.map((e) => [e.op, e.route])).toEqual([
      ['Meaning check', 'on-device'],
      ['Check the final text for details', 'local-js'],
      ['Rewrite on-device', 'on-device'],
      ['Fixed rules generalised 5 details', 'local-js'],
    ]);
    expect(ledger.bytesOut).toBe(0);
  });

  it('catches a number, date or name the rewrite adds, and generalises it without a model', async () => {
    const { published, threat, ledger } = await runWith(() => 'I worked there for three years and valued it. In March the Lisbon team was cut. We shipped it anyway.');
    expect(published.value).toBe('I worked there for several years and valued it. Recently the team was cut. We shipped it anyway.');
    expect(threat.lastRewrite?.detailsLeft).toEqual([]);
    expect(threat.lastRewrite?.generalised.slice(5)).toEqual([
      { phrase: 'three years', generic: 'several years', by: 'rule' },
      { phrase: 'Lisbon', generic: '', by: 'rule' },
      { phrase: 'March', generic: 'recently', by: 'rule' },
    ]);
    expect(ledger.all.find((e) => e.op === 'Check the final text for details')?.note).toBe('no model · 3 details added by the rewrite');
  });

  it('rejects a rewrite that repeats a new phrase (the live placeholder failure, “what you wrote instead”)', async () => {
    const broken = 'The tenure spanned what you wrote instead. A reorganization occurred in what you wrote instead. It went from what you wrote instead to two.';
    await expect(runWith(() => broken)).rejects.toThrow(/same phrase over and over/);
  });

  const ROTA = 'I was on a 24/7 on-call rota for most of my time there. It was exhausting and nobody listened to us.';
  const ROTA_DETAIL = [{ phrase: '24/7 on-call rota', why: 'Specific schedule.' }];

  it('still reports what neither the rules nor the model could generalise, instead of calling the text safe', async () => {
    const kept = 'The 24/7 on-call rota was exhausting, and concerns were ignored.';
    const { published, threat, prompts } = await runWith(() => kept, ROTA, ROTA_DETAIL);
    expect(prompts[0]).toContain('Generalise these details: 24/7 on-call rota.');
    expect(published.value).toBe(kept);
    expect(threat.lastRewrite?.generalised).toEqual([]);
    expect(threat.lastRewrite?.detailsLeft).toEqual(ROTA_DETAIL);
  });

  it('credits the model when it removes a detail the rules could not', async () => {
    const { threat } = await runWith(() => 'The on-call duties never stopped, and concerns were ignored.', ROTA, ROTA_DETAIL);
    expect(threat.lastRewrite?.generalised).toEqual([{ phrase: '24/7 on-call rota', generic: '', by: 'nano' }]);
    expect(threat.lastRewrite?.detailsLeft).toEqual([]);
  });
});

describe('a busy cloud (live run: [500] "This model is currently experiencing high demand")', () => {
  const lineupAnswer = (prompt: string, who: 'self' | 'other') => {
    const corpusStart = (who === 'self' ? MARTA_PUBLIC : DECOYS[0].corpus).slice(0, 40);
    const m = [...prompt.matchAll(/Writer ([A-J]):\n/g)].find((x) => prompt.slice((x.index ?? 0) + x[0].length).trimStart().startsWith(corpusStart));
    return JSON.stringify({ pick: m?.[1] ?? 'A', confidence: 'high', reasons: ['r'] });
  };

  it('classifies the live 500 as temporary and the App Check 401 as not', () => {
    expect(isTemporary(new Error('[500 ] This model is currently experiencing high demand. Please try again later.'))).toBe(true);
    expect(isTemporary(new Error('[401 ] Firebase App Check token is invalid.'))).toBe(false);
  });

  it('loses only the failed attempts, and scores the rest as a rate', async () => {
    let call = 0;
    const flaky: ModelBackend = {
      name: 'cloud',
      generate: async (parts) => {
        call++;
        if (call === 2 || call === 5) throw new Error('[500 ] This model is currently experiencing high demand.');
        const prompt = parts.map((p) => ('text' in p ? p.text : '')).join('\n');
        return { text: lineupAnswer(prompt, 'self'), source: 'in_cloud' };
      },
    };
    const ledger = new Ledger();
    const kit = { local: new LocalModel(flaky, ledger), cloud: new CloudModel(flaky, ledger), ledger };
    const threat = threatFor();
    const v = await threat.attack(release('Some text to publish, long enough to be a post.', 'test'), kit);
    expect(v.answered).toBe(8);
    expect(v.hits).toBe(8);
    expect(threat.exposed(v)).toBe(true);
    expect(threat.inconclusive(v)).toBe(false);
    expect(ledger.all.filter((e) => e.note === 'no answer (model busy)')).toHaveLength(2);
  });

  it('never shows the live "1/1 — you are one of ten": one hit out of one answer is exposure, and inconclusive', () => {
    const threat = threatFor();
    const v = { picks: ['marta', ...Array(9).fill('none')], hits: 1, attempts: 10, answered: 1, reasons: [] };
    expect(threat.exposed(v)).toBe(true);
    expect(threat.inconclusive(v)).toBe(true);
  });

  it('throws if no attempt got an answer', async () => {
    const down: ModelBackend = { name: 'cloud', generate: async () => { throw new Error('[503] UNAVAILABLE'); } };
    const ledger = new Ledger();
    const kit = { local: new LocalModel(down, ledger), cloud: new CloudModel(down, ledger), ledger };
    await expect(threatFor().attack(release('Some text to publish, long enough to be a post.', 'test'), kit)).rejects.toThrow(/UNAVAILABLE/);
  });
});
