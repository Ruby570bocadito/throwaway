// Real inputs and small-model failures for the authorship threat: identifiers, malformed Nano answers, refusals,
// empty and oversized posts. Nano is scripted with raw text, so it can answer as badly as it does live.

import { beforeEach, describe, expect, it } from 'vitest';
import { clearTaint, CloudModel, Ledger, LocalModel, publicData, secret, type ModelBackend } from '../framework';
import {
  authorshipThreat, deterministicGeneralise, hasPhrase, identifiers, isSpecific, looksLikeRefusal, MAX_DRAFT_WORDS, newSpecifics, ruleDetails,
} from './authorship';
import { DECOYS, DRAFT, MARTA_PUBLIC, REWRITE, SELF_ID } from '../demo/scenario';

beforeEach(() => clearTaint());

const threatFor = () =>
  authorshipThreat({
    selfId: SELF_ID,
    self: publicData(MARTA_PUBLIC, 'blog'),
    decoys: DECOYS.map((d) => ({ id: d.id, text: publicData(d.corpus, 'decoy') })),
  });

/** Nano answers with raw text; `answer` gets the prompt and how many times that kind of prompt was asked. */
function kitWith(answer: (prompt: string, n: number) => string) {
  const asked = new Map<string, number>();
  const prompts: string[] = [];
  const nano: ModelBackend = {
    name: 'nano',
    generate: async (parts) => {
      const prompt = parts.map((p) => ('text' in p ? p.text : '')).join('\n');
      prompts.push(prompt);
      const kind = prompt.slice(0, 12);
      const n = asked.get(kind) ?? 0;
      asked.set(kind, n + 1);
      return { text: answer(prompt, n), source: 'on_device' };
    },
  };
  const ledger = new Ledger();
  return { kit: { local: new LocalModel(nano, ledger), cloud: new CloudModel(nano, ledger), ledger }, prompts };
}

const meaning = JSON.stringify({ claims: [{ claim: 'The team was cut', kept: true }] });

describe('identifiers anyone can look up', () => {
  const POST =
    'Email me at marta.silva@acme.pt or call +351 912 345 678. My blog is https://marta.design/blog/2023 and I am @marta_designs on Twitter.';

  it('are found by the fixed rules and replaced whole, before any count rule can mangle them', () => {
    expect(ruleDetails(POST).map((d) => [d.phrase, d.why])).toEqual([
      ['marta.silva@acme.pt', 'An email address: fixed rule, no AI.'],
      ['+351 912 345 678', 'A phone number: fixed rule, no AI.'],
      ['https://marta.design/blog/2023', 'A link: fixed rule, no AI.'],
      ['@marta_designs', 'A username: fixed rule, no AI.'],
    ]);
    expect(deterministicGeneralise(POST, ruleDetails(POST).map((d) => d.phrase)).text).toBe(
      'Email me at [email address] or call [phone number]. My blog is [link] and I am [username] on Twitter.',
    );
  });

  it.each([
    ['Write to marta [at] acme [dot] pt today.', 'Write to [email address] today.'],
    ['See marta.design/about for more.', 'See [link] for more.'],
    ['Check www.acme.com/careers?ref=marta, then email hr@acme.com.', 'Check [link], then email [email address].'],
    ['Ping u/marta_d on Reddit, or text 555-123-4567.', 'Ping [username] on Reddit, or text [phone number].'],
    ['Our office phone is (555) 123 4567 and the fax 912345678.', 'Our office phone is [phone number] and the fax [phone number].'],
    ['It happened in the meeting on 16/11/2023 with the whole team.', 'It happened in the meeting at some point with the whole team.'],
  ])('%s', (text, expected) => {
    expect(deterministicGeneralise(text, ruleDetails(text).map((d) => d.phrase)).text).toBe(expected);
  });

  it('leaves alone what only looks like one: a missing space, versions, codes, a list of years', () => {
    expect(identifiers('I left.It was hard.')).toEqual([]);
    expect(identifiers('Version 1.2.3 shipped with 24/7 support.')).toEqual([]);
    expect(identifiers('Sales in 2019 2020 2021 grew.')).toEqual([]);
    expect(identifiers('Use node.js and e.g. React.')).toEqual([]);
    const v = 'Version 1.2.3 shipped with 24/7 support.';
    expect(deterministicGeneralise(v, ruleDetails(v).map((d) => d.phrase)).text).toBe(v);
  });

  it('count as specific when Nano flags them, and as added when the rewrite invents them', () => {
    for (const p of ['marta.silva@acme.pt', '@marta_designs', 'marta.design', '+351 912 345 678']) expect(isSpecific(p, POST)).toBe(true);
    expect(newSpecifics('Contact marta@acme.pt or @marta_designs, see https://x.com/abc. Ask José.', 'Contact me. Ask him.')).toEqual([
      'marta@acme.pt',
      '@marta_designs',
      'https://x.com/abc',
      'José',
    ]);
  });

  it('never reach Gemini Nano: the rules replace them in the draft first', async () => {
    const { kit, prompts } = kitWith((p) => (p.startsWith('Rewrite') ? JSON.stringify({ rewrite: 'You can reach the author through the usual channels.' }) : meaning));
    const published = await threatFor().sanitize(secret(POST, 'draft'), [], null, kit);
    const rewritePrompt = prompts.find((p) => p.startsWith('Rewrite'))!;
    for (const id of ['marta.silva@acme.pt', '912 345 678', 'marta.design', '@marta_designs']) expect(rewritePrompt).not.toContain(id);
    expect(rewritePrompt).toContain('[email address]');
    expect(published.value).toBe('You can reach the author through the usual channels.');
  });
});

describe('names and quotes the way small models write them', () => {
  it('matches a flagged phrase with straight or curly apostrophes and dashes', () => {
    expect(hasPhrase('Ask anyone in Anna’s team.', "Anna's team")).toBe(true);
    expect(hasPhrase("Ask anyone in Anna's team.", 'Anna’s team')).toBe(true);
    expect(hasPhrase('a three‑year contract', 'three-year contract')).toBe(true);
  });

  it('generalises accented names whole ("São Paulo", not "São")', () => {
    const t = 'We had a São Paulo office. Later the Zürich team took over.';
    expect(isSpecific('São Paulo office', t)).toBe(true);
    expect(deterministicGeneralise(t, ['São Paulo office', 'Zürich team']).text).toBe('We had an office. Later the team took over.');
  });
});

describe('Gemini Nano answering badly', () => {
  const POST = 'After the March reorg our team in the Lisbon office went from 6 people to 2, and nobody told us why.';

  it.each([
    ['details is not a list', '{"details":"Lisbon office"}', []],
    ['phrases that are not strings, empty, invented or repeated', '{"details":[{"phrase":42},{"phrase":""},{"phrase":"Paris office"},{"phrase":"Lisbon office","why":"place"},{"phrase":"lisbon office","why":"again"}]}', ['Lisbon office']],
    ['a bare list of strings', '["Lisbon office", "team"]', ['Lisbon office']],
    ['an answer cut off mid-list', '```json\n{"details":[{"phrase":"Lisbon office","why":"A place."},{"phrase":"March re', ['Lisbon office']],
  ])('%s', async (_name, answer, expected) => {
    const { kit } = kitWith(() => answer);
    const clues = await threatFor().findClues(secret(POST, 'draft'), kit);
    const flagged = clues.filter((c) => c.kind === 'content' && !c.why.includes('fixed rule'));
    expect(flagged.map((c) => c.phrase)).toEqual(expected);
  });

  it('an unreadable answer gets one more try; two of them leave the fixed rules, and the ledger says so', async () => {
    const once = kitWith((_p, n) => (n === 0 ? 'Sure! The details are the office and the date.' : '{"details":[{"phrase":"Lisbon office","why":"A place."}]}'));
    const clues = await threatFor().findClues(secret(POST, 'draft'), once.kit);
    expect(clues.some((c) => c.phrase === 'Lisbon office')).toBe(true);
    expect(once.prompts).toHaveLength(2);

    const never = kitWith(() => 'I could not find anything.');
    const rulesOnly = await threatFor().findClues(secret(POST, 'draft'), never.kit);
    expect(rulesOnly.filter((c) => c.kind === 'content').map((c) => c.phrase)).toEqual(['March', '6 people', '2']);
    expect(never.kit.ledger.all[0].note).toBe("no model · Nano's answer was unreadable, the rules found 3");
  });

  it('a rewrite that is unreadable, a refusal or a loop gets one more try', async () => {
    for (const bad of ['Here is the rewrite: (it was cut', "I'm sorry, but I can't help with rewriting this review.", '{"rewrite":"x y z. x y z. x y z. x y z."}']) {
      clearTaint();
      const { kit, prompts } = kitWith((p, n) => (p.startsWith('Rewrite') ? (n === 0 ? bad : JSON.stringify({ rewrite: REWRITE })) : meaning));
      const published = await threatFor().sanitize(secret(DRAFT, 'draft'), [], null, kit);
      expect(published.value).toContain('An attachment to this organization');
      expect(prompts.filter((p) => p.startsWith('Rewrite'))).toHaveLength(2);
      expect(kit.ledger.all.some((e) => e.op.startsWith('Rewrite on-device (again'))).toBe(true);
    }
  });

  it('two refusals in a row: an error, never a released refusal that would score 0/10 and look safe', async () => {
    const { kit } = kitWith((p) => (p.startsWith('Rewrite') ? JSON.stringify({ rewrite: 'Sorry, I cannot do that.' }) : meaning));
    await expect(threatFor().sanitize(secret(DRAFT, 'draft'), [], null, kit)).rejects.toThrow(/declined, or dropped most of the post/);
  });

  it('a meaning check with no readable answer keeps the finished rewrite and says the check is missing', async () => {
    const { kit } = kitWith((p) => (p.startsWith('Rewrite') ? JSON.stringify({ rewrite: REWRITE }) : 'The claims are all kept.'));
    const threat = threatFor();
    const published = await threat.sanitize(secret(DRAFT, 'draft'), [], null, kit);
    expect(published.value).toContain('An attachment to this organization');
    expect(threat.lastRewrite).toMatchObject({ claims: [], meaningCheck: 'failed' });
    expect(kit.ledger.all[0]).toMatchObject({ op: 'Meaning check', note: 'unreadable answer · read the final text yourself' });
  });

  it('reads claims whose "kept" came back as a string, and drops half claims', async () => {
    const answer = '{"claims":[{"claim":"Team cut","kept":"true"},{"claim":"No reason given","kept":"false"},{"claim":"Bad management"},{"claim":"Deadl';
    const { kit } = kitWith((p) => (p.startsWith('Rewrite') ? JSON.stringify({ rewrite: REWRITE }) : answer));
    const threat = threatFor();
    await threat.sanitize(secret(DRAFT, 'draft'), [], null, kit);
    expect(threat.lastRewrite?.claims).toEqual([
      { claim: 'Team cut', kept: true },
      { claim: 'No reason given', kept: false },
    ]);
    expect(threat.lastRewrite?.meaningCheck).toBe('done');
  });

  it('looksLikeRefusal: refusals and a one-line summary of a long post, but not a short rewrite of a short post', () => {
    expect(looksLikeRefusal("I'm sorry, I can't help with that.", DRAFT)).toBe(true);
    expect(looksLikeRefusal('As an AI language model, I cannot rewrite reviews.', DRAFT)).toBe(true);
    expect(looksLikeRefusal('The company is bad.', DRAFT)).toBe(true);
    expect(looksLikeRefusal(REWRITE, DRAFT)).toBe(false);
    expect(looksLikeRefusal('Concerns were ignored.', 'Nobody listened to our concerns at all.')).toBe(false);
  });
});

describe('empty and very long posts', () => {
  it('an empty post costs no model call and cannot be "rewritten"', async () => {
    const { kit, prompts } = kitWith(() => '{}');
    const threat = threatFor();
    expect((await threat.findClues(secret('   ', 'draft'), kit)).filter((c) => c.kind === 'content')).toEqual([]);
    expect(prompts).toHaveLength(0);
    await expect(threat.sanitize(secret(' \n ', 'draft'), [], null, kit)).rejects.toThrow(/nothing to rewrite/);
  });

  it('a post too long for Gemini Nano is refused up front with a clear message, not after a long wait', async () => {
    const { kit, prompts } = kitWith(() => '{}');
    const long = Array.from({ length: MAX_DRAFT_WORDS + 1 }, () => 'word').join(' ');
    await expect(threatFor().findClues(secret(long, 'draft'), kit)).rejects.toThrow(/too long for Gemini Nano on this device \(1,501 words; up to 1,500 fit\)/);
    await expect(threatFor().sanitize(secret('长'.repeat(10_001), 'draft'), [], null, kit)).rejects.toThrow(/too long/);
    expect(prompts).toHaveLength(0);
  });
});
