import { afterEach, describe, expect, it } from 'vitest';
import { deviceModelStatus } from './device';

const g = globalThis as unknown as { LanguageModel?: unknown };
afterEach(() => {
  delete g.LanguageModel;
});

describe('deviceModelStatus', () => {
  it('maps Chrome’s answers, and treats no Prompt API or an error as unavailable', async () => {
    expect(await deviceModelStatus()).toBe('unavailable');
    for (const [answer, expected] of [['available', 'available'], ['downloading', 'downloadable'], ['downloadable', 'downloadable'], ['unavailable', 'unavailable']]) {
      g.LanguageModel = { availability: async () => answer };
      expect(await deviceModelStatus()).toBe(expected);
    }
    g.LanguageModel = { availability: async () => Promise.reject(new Error('NotSupportedError')) };
    expect(await deviceModelStatus()).toBe('unavailable');
  });

  it('does not wait forever: a Chrome that never answers counts as no local model (degraded mode, nothing sent)', async () => {
    g.LanguageModel = { availability: () => new Promise(() => undefined) };
    const t0 = Date.now();
    expect(await deviceModelStatus(30)).toBe('unavailable');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
