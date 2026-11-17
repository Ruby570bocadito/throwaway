import { beforeEach, describe, expect, it } from 'vitest';
import { clearTaint, CloudModel, isTemporary, Ledger, LocalModel, publicData, release, secret, type ModelBackend } from '../framework';
import {
  aboutSubject,
  authorshipThreat,
  deterministicGeneralise,
  generalisableByHand,
  hasPhrase,
  isSpecific,
  letterIndex,
  looksBroken,
  nameDetails,
  newSpecifics,
  quotesNotIn,
  ruleDetails,
  sample,
  shuffled,
} from './authorship';
import { ATTACK_AFTER, ATTACK_BEFORE, CONTENT_DETAILS, DECOYS, DRAFT, MARTA_PUBLIC, NANO_REWRITE_RECORDED, NANO_REWRITE_V3_RECORDED, REWRITE, SELF_ID } from '../demo/scenario';
import { FIELD_WORDS } from '../demo/decoys';

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

/** The draft Gemini Nano saw in the live v5 run (the five real details generalised, counts not yet all). */
const RULED_DRAFT_V5 =
  'So, honestly, I loved this company for several years — but the last six months have been kind of a mess. Anyway, after the reorg our design team in the office went from several people to a few (and nobody told us why). Basically we were asked to ship the migration with half the people and the same deadline. Honestly, management means well, but they do not listen — they announce. So, if you are a designer, think twice (sorry not sorry).';

/** The real draft after the fixed rules now: the five real details plus every count and date. What Nano gets to rewrite. */
const RULED_DRAFT =
  'So, honestly, I loved this company for several years — but the last several months have been kind of a mess. Anyway, after the reorg our design team in the office went from several people to a few (and nobody told us why). Basically we were asked to ship the migration with half the people and the same deadline. Honestly, management means well, but they do not listen — they announce. So, if you are a designer, think twice (sorry not sorry).';

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
    expect(newSpecifics('I worked there for three years. In March the Lisbon team was cut.', RULED_DRAFT).sort()).toEqual(['Lisbon', 'March', 'three years']);
    expect(newSpecifics(REWRITE, RULED_DRAFT_V5)).toEqual([]); // the live v5 rewrite added nothing to the draft it saw
    expect(newSpecifics('The last six months were hard. One of us left.', RULED_DRAFT_V5)).toEqual([]); // already in the draft / "one"
  });
  it('newSpecifics compares a count with the word it counts (live, public URL: "six individuals" next to "six months")', () => {
    expect(newSpecifics('decreased from six individuals to only two. The past six months were hard.', 'the last six months')).toEqual(['six individuals', 'two']);
  });
  it('ruleDetails finds every count and date in the real draft, without a model', () => {
    expect(ruleDetails(DRAFT).map((d) => d.phrase)).toEqual(['March', 'three years', 'six months', '6 people', '2']);
    expect(ruleDetails('One of us left after one year.').map((d) => d.phrase)).toEqual(['one year']);
    expect(ruleDetails('A 24/7 rota under COVID-19 rules.')).toEqual([]);
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
    // The recorded rewrite still says "six months" (Nano saw it then); the final check makes it vague.
    expect(published.value).toBe(REWRITE.replace('six months', 'several months'));
    expect(threat.lastRewrite?.generalised).toEqual([
      { phrase: 'Figma migration', generic: 'migration', by: 'rule' },
      { phrase: 'Lisbon office', generic: 'office', by: 'rule' },
      { phrase: '6 people to 2', generic: 'several people to a few', by: 'rule' },
      { phrase: 'three years', generic: 'several years', by: 'rule' },
      { phrase: 'March reorg', generic: 'reorg', by: 'rule' },
      { phrase: 'six months', generic: 'several months', by: 'rule' },
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
      ['Fixed rules generalised 6 details', 'local-js'],
    ]);
    expect(ledger.bytesOut).toBe(0);
  });

  it('catches a number, date or name the rewrite adds, and generalises it without a model', async () => {
    const { published, threat, ledger } = await runWith(() => 'I worked there for three years and valued it. In March the Lisbon team was cut. We shipped it anyway.');
    expect(published.value).toBe('I worked there for several years and valued it. Recently the team was cut. We shipped it anyway.');
    expect(threat.lastRewrite?.detailsLeft).toEqual([]);
    // "three years" is already listed from the draft, so it is not listed twice.
    expect(threat.lastRewrite?.generalised.slice(6)).toEqual([
      { phrase: 'Lisbon', generic: '', by: 'rule' },
      { phrase: 'March', generic: 'recently', by: 'rule' },
    ]);
    expect(ledger.all.find((e) => e.op === 'Check the final text for details')?.note).toBe('no model · generalised 3 details the rewrite added');
  });

  it('live run on the public URL (16-nov): Nano missed "6 people to 2" and the rewrite kept the team size; now it cannot', async () => {
    const flagged = CONTENT_DETAILS.filter((d) => d.phrase !== '6 people to 2');
    // Nano's raw rewrite from that run, reconstructed: the final text had "only a few" because our check caught "two".
    const raw =
      'For several years, I held a positive view of this organization. However, the past six months have presented considerable challenges. Following the organizational restructuring, the design team in the office decreased from six individuals to only two, without explanation. The team was then tasked with delivering the migration with a reduced workforce while maintaining the original deadline. Management intends well, but communication lacks substantive engagement. This situation warrants careful consideration for designers.';
    let seen = '';
    const { published, threat } = await runWith((d) => ((seen = d), raw), DRAFT, flagged);
    expect(seen).toBe(RULED_DRAFT); // every count is vague before Nano sees the draft
    expect(seen).not.toMatch(/\b(6|2|six|two)\b/);
    expect(DRAFT).toMatch(/\b(6|2|six|two)\b/); // and the check itself can fail
    expect(published.value).toContain('decreased from several individuals to only a few');
    expect(published.value).toContain('the past several months');
    expect(threat.lastRewrite?.detailsLeft).toEqual([]);
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

  it('stops asking a cloud that is down: two failures before any answer, no ten (each already retried for up to 45 s)', async () => {
    let calls = 0;
    const down: ModelBackend = { name: 'cloud', generate: async () => (calls++, Promise.reject(new Error('[503] UNAVAILABLE'))) };
    const ledger = new Ledger();
    const kit = { local: new LocalModel(down, ledger), cloud: new CloudModel(down, ledger), ledger };
    await expect(threatFor().attack(release('Some text to publish, long enough to be a post.', 'test'), kit)).rejects.toThrow(/UNAVAILABLE/);
    expect(calls).toBe(2);
  });

  it('a cloud that goes down mid-attack: three failures in a row end it, the rest count as no answer', async () => {
    let calls = 0;
    const flaky: ModelBackend = {
      name: 'cloud',
      generate: async (parts) => {
        if (++calls > 4) throw new Error('[500 ] high demand');
        return { text: lineupAnswer(parts.map((p) => ('text' in p ? p.text : '')).join('\n'), 'self'), source: 'in_cloud' };
      },
    };
    const ledger = new Ledger();
    const kit = { local: new LocalModel(flaky, ledger), cloud: new CloudModel(flaky, ledger), ledger };
    const seen: string[] = [];
    const threat = authorshipThreat({
      selfId: SELF_ID,
      self: publicData(MARTA_PUBLIC, 'blog'),
      decoys: DECOYS.map((d) => ({ id: d.id, text: publicData(d.corpus, 'decoy') })),
      onAttempt: (id) => seen.push(id),
    });
    const v = await threat.attack(release('Some text to publish, long enough to be a post.', 'test'), kit);
    expect(calls).toBe(7);
    expect(seen).toHaveLength(10); // the UI still gets one callback per attempt
    expect(v).toMatchObject({ attempts: 10, answered: 4, hits: 4 });
    expect(v.picks.slice(4)).toEqual(Array(6).fill('none'));
    expect(threat.inconclusive(v)).toBe(true);
    expect(ledger.all[0]).toMatchObject({ op: 'Attack attempts 8–10 skipped', bytesOut: 0 });
  });

  it('reads a pick from a cut-off or loosely formatted answer', async () => {
    const answers = ['{"pick":"Writer C","confidence":"high","reasons":["Distinc', '{"pick":"(b)","reasons":[]}', '{"pick":"Z"}'];
    let i = 0;
    const cloud: ModelBackend = { name: 'cloud', generate: async () => ({ text: answers[i++ % 3], source: 'in_cloud' }) };
    const ledger = new Ledger();
    const kit = { local: new LocalModel(cloud, ledger), cloud: new CloudModel(cloud, ledger), ledger };
    const v = await threatFor().attack(release('Some text to publish, long enough to be a post.', 'test'), kit);
    expect(v.answered).toBe(7); // "Z" is not a writer: 3 of 10 attempts are no answer
  });
});

describe('the lineup', () => {
  it('is shuffled without bias: the user, listed first, lands in every position about equally', () => {
    const counts = Array(10).fill(0);
    const items = Array.from({ length: 10 }, (_, k) => k);
    for (let n = 0; n < 20_000; n++) counts[shuffled(items).indexOf(0)]++;
    for (const c of counts) expect(Math.abs(c - 2000)).toBeLessThan(250);
  });

  it('reads the letter however the model writes it', () => {
    expect(['C', 'c', 'Writer C', '(C)', 'C.', ' writer c '].map(letterIndex)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(['', 'Z', 'CD', 3, null, 'Writer'].map(letterIndex)).toEqual([-1, -1, -1, -1, -1, -1]);
  });

  it('cuts each writer at a word boundary', () => {
    expect(sample('one two three four', 11)).toBe('one two');
    expect(sample('short', 900)).toBe('short');
    expect(sample(MARTA_PUBLIC, 900).length).toBeLessThanOrEqual(900);
    expect(MARTA_PUBLIC.startsWith(sample(MARTA_PUBLIC, 900))).toBe(true);
    expect(sample(MARTA_PUBLIC, 900)).toMatch(/\w$|[.)]$/);
  });
});

describe("the attacker's reasons", () => {
  it('flag quotes that are not in the attacked text, and leave the grounded ones alone (recorded run)', () => {
    // Before: every quoted habit is in the draft.
    for (const r of ATTACK_BEFORE.reasons) expect(quotesNotIn(r, DRAFT), r).toEqual([]);
    // After: the rewrite says "organization" and never "review"; the attacker quoted another writer's words.
    expect(quotesNotIn(ATTACK_AFTER.reasons[2], REWRITE)).toEqual(['organisation', 'review']);
  });

  it('read straight, curly and double quotes, but not apostrophes inside words', () => {
    expect(quotesNotIn("Matches Writer C's rhythm and 'so, honestly'", 'So, honestly, it was fine.')).toEqual([]);
    expect(quotesNotIn('Uses “per se” and "inter alia"', 'Nothing Latin here.')).toEqual(['per se', 'inter alia']);
    expect(quotesNotIn('No quotes at all', 'text')).toEqual([]);
  });
});

describe('generalising by hand, without a local model', () => {
  it('leaves bare numbers to the person, and generalises counts with their word and dates', () => {
    // A test user's edit (17-nov): "11 of them under 21" became "several of them under many".
    const post =
      "I've been assistant manager here for nine years and we have 46 on the rota, 11 of them under 21. The rota was sorted in March, then Dean left after 3 weeks of covering two shifts a day.";
    const r = deterministicGeneralise(post, generalisableByHand(ruleDetails(post).map((d) => d.phrase)));
    expect(r.text).toContain('we have 46 on the rota, 11 of them under 21');
    expect(r.text).not.toMatch(/under (?:many|several|a few)/);
    expect(r.done.map((d) => d.phrase).sort()).toEqual(['3 weeks', 'March', 'nine years', 'two shifts']);
  });
});

describe('names without a local model', () => {
  it('are the capitalised words in the middle of a sentence: not dates, roles, or the word that opens one', () => {
    // A test user's post (17-nov): "Dave" and "Kelly" went unflagged without Gemini Nano.
    const post =
      'Our regional manager, Dave, came in after the restructure in March 2026. He cut Saturday cover, and in April he shouted at Kelly from the bakery. HR said they would look into it. Anyway, ask about the rota at the Forn Pastisseria counter.';
    expect(nameDetails(post).map((n) => n.phrase)).toEqual(['Dave', 'Kelly', 'Forn Pastisseria']);
    expect(nameDetails(post)[0].why).toMatch(/maybe a name, place or company/);
  });

  it('find the sample post’s place and product, as Gemini Nano did', () => {
    expect(nameDetails(DRAFT).map((n) => n.phrase)).toEqual(['Lisbon', 'Figma']);
  });
});

describe('a reason about the subject, not the style', () => {
  it('is told apart, so the user hears that the decoys may be from another field', () => {
    // A test user's live run (17-nov): found by what he wrote about.
    expect(aboutSubject('The vocabulary focuses on retail management and store operations.')).toBe(true);
    expect(aboutSubject('Mentions retail/store management context and shift/rota challenges.')).toBe(true);
    // The recorded run's reasons are about style.
    for (const r of [...ATTACK_BEFORE.reasons, ...ATTACK_AFTER.reasons]) expect(aboutSubject(r), r).toBe(false);
  });

  it('also when it names a word of a field that the attacked text uses, but not a word that names a habit of style', () => {
    const post = 'Honestly, the new rota at our cafe is a joke. Three of us cover the whole weekend, and the owner only reads the online reviews.';
    // A live run (17-nov): a café worker among finance writers, found 10/10 by what she wrote about, and no note.
    expect(aboutSubject('shares the exact same cafe/rota narrative details', FIELD_WORDS, post)).toBe(true);
    expect(aboutSubject('Both describe weekend rotas in a café', FIELD_WORDS, post)).toBe(true);
    // A field word the post does not use, or none at all.
    expect(aboutSubject('writes like a barista', FIELD_WORDS, post)).toBe(false);
    expect(aboutSubject('similar sentence structure and vocabulary choices', FIELD_WORDS, post)).toBe(false);
    // Field words that also name habits of style, even when the post uses them.
    expect(aboutSubject('A close match in sentence flow and a clinical, detached tone', FIELD_WORDS, 'Patient flow is a mess and clinical staff are close to quitting.')).toBe(false);
    // The recorded run stays on style.
    for (const r of [...ATTACK_BEFORE.reasons, ...ATTACK_AFTER.reasons]) expect(aboutSubject(r, FIELD_WORDS, DRAFT), r).toBe(false);
  });
});
