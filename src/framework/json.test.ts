import { describe, expect, it } from 'vitest';
import { listAt, ModelJsonError, parseModelJson, parseModelJsonLenient } from './json';

describe('parseModelJson', () => {
  it('reads plain JSON, fenced JSON (what Gemini Nano returned) and JSON with prose around it', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{ "clues": [] }\n```')).toEqual({ clues: [] });
    expect(parseModelJson('Sure! Here it is: {"pick":"C"} Hope it helps')).toEqual({ pick: 'C' });
    expect(() => parseModelJson('no json here')).toThrow(/valid JSON/);
  });

  it.each([
    ['a fence with a sentence after it', '```json\n{"a":1}\n```\nHope this helps!', { a: 1 }],
    ['a fence after a sentence', 'Here you go:\n```JSON\n{"a":1}\n```', { a: 1 }],
    ['prose with braces after the JSON', '{"pick":"C"} (note: {x})', { pick: 'C' }],
    ['brackets and quotes inside strings', '{"phrase":"a } tricky ] \\"one\\"","why":"x"}', { phrase: 'a } tricky ] "one"', why: 'x' }],
    ['trailing commas', '{"a":[1,2,],}', { a: [1, 2] }],
    ['curly quotes as delimiters', '{“rewrite”: “It was fine.”}', { rewrite: 'It was fine.' }],
    ['JSON encoded twice', '"{\\"rewrite\\": \\"hi\\"}"', { rewrite: 'hi' }],
    ['a byte-order mark', '﻿{"a":1}', { a: 1 }],
    ['a bare array', 'The clues: [{"cell":3}]', [{ cell: 3 }]],
  ])('%s', (_name, text, expected) => {
    expect(parseModelJson(text)).toEqual(expected);
  });

  it('never puts the model answer in the error message (a local answer can echo the private draft)', () => {
    try {
      parseModelJson('I loved this company for three years — {oops');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ModelJsonError);
      expect((e as Error).message).toBe('The model did not return valid JSON.');
      expect((e as ModelJsonError).raw).toContain('three years');
    }
    expect(() => parseModelJson('   ')).toThrow(/empty answer/);
  });
});

describe('parseModelJsonLenient (an answer cut off mid-list)', () => {
  it('keeps the complete items and drops the cut one', () => {
    const r = parseModelJsonLenient<{ details: { phrase: string }[] }>('{"details":[{"phrase":"three years","why":"tenure"},{"phrase":"Lis');
    expect(r).toEqual({ value: { details: [{ phrase: 'three years', why: 'tenure' }] }, repaired: true });
    expect(parseModelJsonLenient('{"pick":"C","confidence":"high","reasons":["Distinctive sig').value).toEqual({ pick: 'C', confidence: 'high' });
    expect(parseModelJsonLenient('```json\n{"clues":[{"cell":3,"kind":"text"},{"cell":7,"ki').value).toEqual({ clues: [{ cell: 3, kind: 'text' }] });
  });

  it('is the strict parser when nothing was cut, and fails when nothing complete is left', () => {
    expect(parseModelJsonLenient('{"a":1}')).toEqual({ value: { a: 1 }, repaired: false });
    expect(() => parseModelJsonLenient('{"rewrite": "An attachment to this organ')).toThrow(ModelJsonError);
  });
});

describe('listAt', () => {
  it('finds the list a small model returned, in whatever shape', () => {
    expect(listAt({ details: [1, 2] }, 'details')).toEqual([1, 2]);
    expect(listAt([1], 'details')).toEqual([1]);
    expect(listAt({ details: 'none' }, 'details')).toEqual([]);
    expect(listAt(null, 'details')).toEqual([]);
  });
});
