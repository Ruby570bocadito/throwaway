import { describe, expect, it } from 'vitest';
import { diffWords } from './diff';

const render = (parts: ReturnType<typeof diffWords>) => parts.map((p) => (p.op === 'same' ? p.text : p.op === 'removed' ? `[-${p.text.trim()}-] ` : `{+${p.text.trim()}+} `)).join('').trim();

describe('diffWords', () => {
  it('marks generalised details as removed and their replacements as added', () => {
    expect(render(diffWords('I loved this company for three years.', 'I loved this company for several years.'))).toBe(
      'I loved this company for [-three-] {+several+} years.',
    );
  });

  it('ignores case and punctuation when matching words', () => {
    expect(diffWords('So, honestly, it works.', 'so honestly it works').every((p) => p.op === 'same')).toBe(true);
  });

  it('handles empty texts', () => {
    expect(diffWords('', 'new text')).toEqual([{ text: 'new text', op: 'added' }]);
    expect(diffWords('old text', '')).toEqual([{ text: 'old text', op: 'removed' }]);
  });
});
