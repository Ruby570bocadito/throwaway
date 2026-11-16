// How a careless developer could get private data past the guard, and why each one is still blocked.
// Every case was a real bypass on 16-nov, found with probes before the canonical letter stream.

import { beforeEach, describe, expect, it } from 'vitest';
import { clearTaint, CloudModel, isTainted, Ledger, LocalModel, PrivacyViolation, Publishable, publicData, recordedBackend, release, secret } from './index';
import { canonicalLetters, decodeEscapes } from './guard';
import { isReleased } from './data';
import { DECOYS, DRAFT, MARTA_PUBLIC, NANO_REWRITE_RECORDED, NANO_REWRITE_V3_RECORDED, REWRITE } from '../demo/scenario';

beforeEach(() => clearTaint());

const echo = recordedBackend('echo', () => 'ok', 0);
const send = (parts: unknown[], schema?: Record<string, unknown>) =>
  new CloudModel(echo, new Ledger()).generate(parts as string[], { op: 'probe', schema });
const blocked = (parts: unknown[], schema?: Record<string, unknown>) => expect(send(parts, schema)).rejects.toBeInstanceOf(PrivacyViolation);
const sent = (parts: unknown[], schema?: Record<string, unknown>) => expect(send(parts, schema)).resolves.toBeTruthy();

const utf8Base64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

describe('canonical text', () => {
  it('drops case, accents, look-alikes, invisible characters, spacing and punctuation', () => {
    const plain = canonicalLetters('Ça, c’est la vie!');
    expect(plain).toBe('cacestlavie');
    expect(canonicalLetters('ÇA,​ C\'EST  LA­ VIE')).toBe(plain);
    expect(canonicalLetters('Ｃａ ｃ’ｅｓｔ ｌａ ｖｉｅ')).toBe(plain); // fullwidth
    expect(canonicalLetters('𝐂𝐚 𝐜’𝐞𝐬𝐭 𝐥𝐚 𝐯𝐢𝐞')).toBe(plain); // mathematical bold
    expect(canonicalLetters('Cа cеst lа viе')).toBe(plain); // Cyrillic а and е
    expect(canonicalLetters('Straße')).toBe(canonicalLetters('Strasse'));
  });

  it('decodes the encodings a developer applies without thinking', () => {
    expect(decodeEscapes('don&#39;t &amp; won&#x27;t &quot;x&quot;')).toBe('don\'t & won\'t "x"');
    expect(decodeEscapes('So%2C%20honestly%E2%80%94yes')).toBe('So, honestly—yes');
    expect(decodeEscapes('line\\nnext \\u00e9 \\u{1F600}')).toBe('line next é 😀');
    expect(decodeEscapes('100% sure, 50%zz off')).toBe('100% sure, 50%zz off'); // not %-encoding: left alone
  });
});

describe('private text cannot leave in disguise', () => {
  beforeEach(() => void secret(DRAFT, 'draft'));
  const words = DRAFT.split(' ');

  it.each([
    ['verbatim, after an instruction', 'Summarise this review: ' + DRAFT],
    ['upper case', DRAFT.toUpperCase()],
    ['zero-width spaces inside every word', words.map((w) => [...w].join('​')).join(' ')],
    ['zero-width spaces instead of spaces', words.join('​')],
    ['soft hyphens', DRAFT.replace(/(\w)(\w)/g, '$1­$2')],
    ['no spaces or punctuation at all', DRAFT.replace(/[^A-Za-z0-9]/g, '')],
    ['fullwidth letters', DRAFT.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0))],
    ['Cyrillic look-alike letters', DRAFT.replace(/a/g, 'а').replace(/o/g, 'о').replace(/e/g, 'е')],
    ['extra whitespace and line breaks', words.join('  \n\t ')],
    ['every word on its own line with a bullet', words.map((w) => `• ${w}`).join('\n')],
    ['curly quotes and dashes swapped', DRAFT.replace(/'/g, '’').replace(/—/g, '--')],
    ['HTML-escaped', DRAFT.replace(/[<>&"' ]/g, (c) => `&#${c.charCodeAt(0)};`)],
    ['URL-encoded', encodeURIComponent(DRAFT)],
    ['in a URL query', `https://example.com/api?q=${encodeURIComponent(DRAFT).replace(/%20/g, '+')}`],
    ['JSON-stringified', JSON.stringify({ text: DRAFT.replace(/\. /g, '.\n') })],
    ['base64', utf8Base64(DRAFT)],
    ['base64url', utf8Base64(DRAFT).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')],
    ['base64 inside a JSON payload', JSON.stringify({ payload: utf8Base64(DRAFT) })],
    ['base64 twice', btoa(utf8Base64(DRAFT))],
  ])('%s', async (_name, payload) => {
    await blocked([payload]);
    expect(() => release(payload, 'careless')).toThrow(PrivacyViolation);
  });

  it('a draft cut into one-word parts of the same call', async () => {
    await blocked(words);
    await blocked(['Here it is:', ...words.slice(0, 5), publicData(words.slice(5).join(' '), 'mixed')]);
  });

  it('text bytes sent as an "image" (TextEncoder)', async () => {
    const bytes = new TextEncoder().encode(DRAFT);
    expect(() => release(bytes, 'as bytes')).toThrow(PrivacyViolation);
  });

  it('the structured-output schema, which is sent too', async () => {
    await blocked(['Pick one.'], { type: 'object', properties: { pick: { type: 'string', enum: [DRAFT] } } });
  });

  it('a Public value whose toString() returns the draft', async () => {
    await blocked([publicData({ toString: () => DRAFT }, 'object')]);
  });
});

describe('other languages are private too (the old tokenizer only saw a–z)', () => {
  it.each([
    ['Spanish, accents stripped', 'Llevo tres años en esta empresa y la reorganización de marzo dejó al equipo de diseño de Lisboa con dos personas. Nadie nos explicó por qué.', (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')],
    ['Russian', 'Я проработала в этой компании три года, но после мартовской реорганизации нашу команду сократили с шести человек до двух.', (s: string) => s],
    ['Greek', 'Δούλεψα σε αυτή την εταιρεία τρία χρόνια, αλλά μετά την αναδιοργάνωση η ομάδα μας μειώθηκε από έξι σε δύο άτομα.', (s: string) => s.toUpperCase()],
    ['Chinese', '我在这家公司工作了三年，但是三月重组之后，我们在里斯本办公室的设计团队从六个人减少到两个人，没有人告诉我们为什么。', (s: string) => s],
    ['Japanese', 'この会社で三年間働きましたが、三月の組織再編の後、リスボンのデザインチームは六人から二人になりました。', (s: string) => s],
    ['Korean', '이 회사에서 삼 년 동안 일했지만 삼월 구조조정 이후 리스본 사무실의 디자인 팀은 여섯 명에서 두 명으로 줄었습니다.', (s: string) => s],
  ])('%s', async (_lang, text, disguise) => {
    secret(text, 'draft');
    await blocked([`Translate: ${disguise(text)}`]);
    expect(() => release(disguise(text), 'no confirmation')).toThrow(PrivacyViolation);
    expect(() => release(text, 'as-is', { userConfirmedAsIs: true })).not.toThrow();
  });

  it('a short CJK phrase shared with a rewrite is not a leak', () => {
    secret('我在这家公司工作了三年，但是三月重组之后，我们的设计团队从六个人减少到两个人。', 'draft');
    expect(() => release('这家公司的设计团队规模变小了，管理层没有解释原因。', 'rewrite')).not.toThrow();
  });
});

describe('images and locations', () => {
  const PHOTO = new Uint8Array(Array.from({ length: 300 }, (_, i) => (i * 37) % 251));
  const binary = (b: Uint8Array) => String.fromCharCode(...b);

  it('the private photo as base64, a data: URL or a binary string is still the private photo', async () => {
    secret(PHOTO, 'photo');
    await blocked([`data:image/png;base64,${btoa(binary(PHOTO))}`]);
    await blocked([publicData(btoa(binary(PHOTO)), 'b64')]);
    await blocked([binary(PHOTO)]);
    expect(() => release(PHOTO.slice(), 'copy')).toThrow(PrivacyViolation);
    expect(() => release(new Uint8Array(PHOTO.buffer), 'view')).toThrow(PrivacyViolation);
    // A really edited image (other bytes) is fine.
    expect(() => release(PHOTO.map((b, i) => (i > 200 ? 0 : b)), 'masked')).not.toThrow();
  });

  it('the real location (3+ decimals, about 100 m) is private; a city-level 2-decimal number is not checked', async () => {
    secret({ lat: 38.7116, lon: -9.1297 }, 'real location');
    await blocked(['The user is at 38.7116, -9.1297']);
    await blocked([`Near ${(38.7116).toFixed(3)}`]);
    await blocked(['lon 9,1297']); // decimal comma
    await blocked([JSON.stringify({ lat: 38.7116 })]);
    expect(() => release({ lat: 38.7116, lon: -9.1297 }, 'coords')).toThrow(PrivacyViolation);
    await sent(['Masked cells: 1, 3, 7, 8, 12. Lisbon is at about 38.72, -9.14.']);
    await sent(['A different place: 38.7999, -9.2000']);
  });
});

describe('only release() opens the door', () => {
  it('a Publishable faked with Object.create, or edited after release, is refused', async () => {
    secret(DRAFT, 'draft');
    const fake = Object.create(Publishable.prototype) as Publishable<string>;
    Object.assign(fake, { value: 'harmless', reason: 'x', releasedAt: 0, confirmedAsIs: false });
    expect(fake instanceof Publishable).toBe(true);
    expect(isReleased(fake)).toBe(false);
    await expect(send([fake])).rejects.toBeInstanceOf(PrivacyViolation);

    const real = release('A harmless sentence for the attacker.', 'ok');
    expect(isReleased(real)).toBe(true);
    expect(() => {
      (real as { value: string }).value = DRAFT;
    }).toThrow(TypeError); // frozen
    expect(real.value).toBe('A harmless sentence for the attacker.');
  });

  it('release() refuses a Private wrapper, even when "confirmed as-is", and one hidden inside an object', () => {
    const draft = secret(DRAFT, 'draft');
    expect(() => release(draft as unknown as string, 'oops', { userConfirmedAsIs: true })).toThrow(PrivacyViolation);
    expect(() => release({ text: 'x', original: draft }, 'nested')).toThrow(PrivacyViolation);
  });

  it('an image part needs an image mime type (the mime string is sent too)', async () => {
    const img = release(new Uint8Array([9, 9, 9]), 'masked');
    await sent([{ image: img, mime: 'image/png' }]);
    await blocked([{ image: img, mime: DRAFT }]);
    await blocked([{ image: img, mime: 'text/plain' }]);
  });

  it('a local backend that cannot say where it ran is treated as the cloud', async () => {
    const ledger = new Ledger();
    const vague = { name: 'vague', generate: async () => ({ text: 'x', source: undefined as unknown as 'on_device' }) };
    await expect(new LocalModel(vague, ledger).generate([secret(DRAFT)], { op: 'rewrite' })).rejects.toBeInstanceOf(PrivacyViolation);
    expect(ledger.all[0].route).toBe('blocked');
  });
});

describe('no false positives on legitimate text', () => {
  it('the real rewrites, the public blog and the decoys still go through', async () => {
    secret(DRAFT, 'draft');
    for (const t of [REWRITE, NANO_REWRITE_RECORDED, NANO_REWRITE_V3_RECORDED, MARTA_PUBLIC, ...DECOYS.map((d) => d.corpus)]) {
      expect(isTainted(t)).toBe(false);
      expect(() => release(t, 'legit')).not.toThrow();
    }
    // The real lineup prompt: instructions, the as-is draft (released by the user) and ten public writers.
    await sent([
      'Which writer most likely wrote the ANONYMOUS TEXT?\n\nANONYMOUS TEXT:\n',
      release(DRAFT, 'as-is', { userConfirmedAsIs: true }),
      '\n\nLINEUP:',
      ...[MARTA_PUBLIC, ...DECOYS.map((d) => d.corpus)].flatMap((c, k) => [`\n\nWriter ${'ABCDEFGHIJ'[k]}:\n`, publicData(c.slice(0, 900), 'lineup')]),
    ]);
  });

  it('stays linear on a large payload', () => {
    secret(DRAFT, 'draft');
    const big = Array.from({ length: 4000 }, (_, i) => `Paragraph ${i} talks about design reviews and teams.`).join(' ');
    const t0 = performance.now();
    expect(isTainted(big)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
