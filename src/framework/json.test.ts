import { describe, expect, it } from 'vitest';
import { parseModelJson } from './json';

describe('parseModelJson', () => {
  it('reads plain JSON, fenced JSON (what Gemini Nano returned) and JSON with prose around it', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{ "clues": [] }\n```')).toEqual({ clues: [] });
    expect(parseModelJson('Sure! Here it is: {"pick":"C"} Hope it helps')).toEqual({ pick: 'C' });
    expect(() => parseModelJson('no json here')).toThrow(/valid JSON/);
  });
});
