import { describe, expect, it } from 'vitest';
import { burrowsDelta, exposure, MIN_WORDS, readsAsEnglish, styleMarkers, tokenize, type Candidate } from './stylometry';
import { DECOYS, DRAFT, LINEUP, MARTA_PUBLIC, REWRITE } from '../demo/scenario';

const PUBLISHED = REWRITE.replace('six months', 'several months');

describe('tokenize', () => {
  it('keeps letters of any script together and drops digits and punctuation', () => {
    expect(tokenize('Café — año 2023, don’t: Zürich!')).toEqual(['café', 'año', "don't", 'zürich']);
    expect(tokenize('So, honestly, I')).toEqual(['so', 'honestly', 'i']);
  });
});

describe('how far to trust the fingerprint', () => {
  it('says "too short to tell" below the floor, even when the rank looks certain', () => {
    // Six words of the author's own habits rank her LAST, and stay last in every resample: stably wrong.
    const six = exposure('So, honestly, basically it was fine.', LINEUP, 'marta');
    expect(six.rank).toBe(10);
    expect(six.reliability.level).toBe('too-short');
    expect(six.reliability.notes[0]).toMatch(/^Only 6 words: too short to tell/);
    expect(exposure('', LINEUP, 'marta').reliability).toMatchObject({ level: 'too-short', words: 0 });
    // The first 29 words of the draft rank her #1, but resampled they rank her #2 to #10.
    const thirty = exposure(DRAFT.split(' ').slice(0, 30).join(' '), LINEUP, 'marta');
    expect(thirty.rank).toBe(1);
    expect(thirty.reliability.level).toBe('too-short');
    expect(thirty.reliability.stability).toBeLessThan(0.5);
    expect(MIN_WORDS).toBe(50);
  });

  it('gives the demo draft its #1 with low confidence, and the rewrite its #10 at every resample', () => {
    const before = exposure(DRAFT, LINEUP, 'marta');
    expect(before.rank).toBe(1);
    expect(before.reliability.level).toBe('low');
    expect(before.reliability.rankRange[0]).toBe(1);
    expect(before.reliability.notes).toContain('80 words is a short sample: treat the rank as a hint.');
    const after = exposure(PUBLISHED, LINEUP, 'marta');
    expect(after.rank).toBe(10);
    expect(after.reliability).toMatchObject({ level: 'medium', stability: 1, rankRange: [10, 10] }); // capped: 70 words
  });

  it('is deterministic (no flicker while typing) and cheap enough for every keystroke', () => {
    expect(exposure(DRAFT, LINEUP, 'marta').reliability).toEqual(exposure(DRAFT, LINEUP, 'marta').reliability);
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) exposure(DRAFT + ' '.repeat(i), LINEUP, 'marta');
    expect((performance.now() - t0) / 10).toBeLessThan(100);
  });

  it('says when the text is not English, or the user’s own writing is too short or much longer than the rest', () => {
    const spanish =
      'Llevo tres años en esta empresa y la reorganización de marzo dejó al equipo de diseño de Lisboa con dos personas. ' +
      'Nadie nos explicó por qué, y la dirección no escucha nunca a nadie aunque se lo pidamos una y otra vez en cada reunión. ' +
      'Si eres diseñador, piénsalo dos veces antes de venir aquí, porque el ambiente es malo y los plazos son imposibles.';
    const es = exposure(spanish, LINEUP, 'marta').reliability;
    expect(es.level).toBe('low');
    expect(es.notes.some((n) => /does not read as English/.test(n))).toBe(true);

    const shortSelf: Candidate[] = [{ id: 'me', label: 'self', corpus: 'Honestly, I write short posts. So, basically, that is it.' }, ...DECOYS];
    const r = exposure(DRAFT, shortSelf, 'me').reliability;
    expect(r.selfWords).toBe(10);
    expect(r.notes.some((n) => /only 10 words/.test(n))).toBe(true);
    expect(['low', 'medium']).toContain(r.level);

    const longSelf: Candidate[] = [{ id: 'me', label: 'self', corpus: Array(8).fill(MARTA_PUBLIC).join('\n\n') }, ...DECOYS];
    expect(exposure(DRAFT, longSelf, 'me').reliability.notes.some((n) => /much longer/.test(n))).toBe(true);
  });

  it('leaves the rank and the Delta of the full text exactly as before (the demo pins them)', () => {
    expect(burrowsDelta(DRAFT, LINEUP)[0]).toEqual({ id: 'marta', delta: expect.closeTo(0.820018, 5) });
  });
});

describe('habit markers with the user’s own public writing', () => {
  it('in a long public text, a phrase must recur and carry a word of its own to be a signature', () => {
    const long = [
      'One of the things I keep telling my team is that a lot of process is just fear.',
      'Honestly, a lot of process is fear wearing a lanyard, and one of the reasons I write is to say so.',
      ...Array.from({ length: 40 }, (_, i) => `Post ${i}: we shipped the thing, we argued about the thing, and then we shipped it again.`),
    ].join(' ');
    const draft = 'One of the problems here is that a lot of process is fear. Management is lost.';
    const phrases = styleMarkers(draft, long, DECOYS.map((d) => d.corpus)).filter((m) => m.phrase.includes(' ')).map((m) => m.phrase);
    expect(phrases).toContain('a lot of'); // recurs, and "lot" is a word of its own
    expect(phrases).toContain('of process is');
    expect(phrases).not.toContain('one of the'); // function words only: everybody writes it
  });

  it('a short public text keeps the old rule: one occurrence is enough (the demo’s "so honestly i")', () => {
    expect(styleMarkers(DRAFT, MARTA_PUBLIC, DECOYS.map((d) => d.corpus)).map((m) => m.phrase)).toContain('so honestly i');
  });
});

describe('whether a post reads as English', () => {
  it('tells English from Spanish, and says nothing about a few words', () => {
    expect(readsAsEnglish(DRAFT)).toBe(true);
    expect(
      readsAsEnglish('Llevo tres años en este colegio y la nueva directora grita al conserje delante de los alumnos cada lunes por la mañana sin motivo.'),
    ).toBe(false);
    expect(readsAsEnglish('Too short to tell.')).toBeNull();
  });
});
