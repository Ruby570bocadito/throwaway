import { describe, expect, it } from 'vitest';
import { PrivacyViolation } from './guard';
import { isTemporary, ModelTimeout, retryAfterMs, statusOf, withRetry, withTimeout } from './retry';

/** What Firebase AI Logic throws for an HTTP error (AIError with customErrorData). */
const aiError = (status: number, message: string, errorDetails?: unknown[]) =>
  Object.assign(new Error(`AI: Error fetching from https://firebasevertexai.googleapis.com/v1beta/projects/demo-500/models/x:generateContent: [${status} ] ${message} (AI/fetch-error)`), {
    code: 'fetch-error',
    customErrorData: { status, statusText: '', errorDetails },
  });

describe('isTemporary', () => {
  it.each([
    ['the live 500 "high demand"', new Error('[500 ] This model is currently experiencing high demand. Please try again later.'), true],
    ['a 429 quota error', aiError(429, 'Resource has been exhausted (e.g. check quota).'), true],
    ['a 503 with no message', aiError(503, ''), true],
    ['the SDK timeout (AbortError "Timeout has expired.")', new DOMException('Timeout has expired.', 'AbortError'), true],
    ['our cloud timeout', new ModelTimeout('cloud', 30_000), true],
    ['a network failure', new Error('AI: Error fetching from https://x: Failed to fetch (AI/error)'), true],
    ['the App Check 401', new Error('[401 ] Firebase App Check token is invalid.'), false],
    ['a 401 even with "500" in the project id', aiError(401, 'Unauthenticated'), false],
    ['a 400 that says INTERNAL', aiError(400, 'INTERNAL: bad schema'), false],
    ['a JSON error quoting "Internal project name"', new Error('The model did not return valid JSON: {"why":"Internal project name"}'), false],
    ['Gemini Nano stuck on the device', new ModelTimeout('device', 300_000), false],
    ['the user cancelling', new DOMException('The operation was aborted.', 'AbortError'), false],
    ['a privacy block', new PrivacyViolation('cloud call', 'x'), false],
    ['nothing', undefined, false],
  ])('%s → %s', (_name, e, expected) => {
    expect(isTemporary(e)).toBe(expected);
  });

  it('reads the status from the SDK error data first, then from the message', () => {
    expect(statusOf(aiError(429, 'x'))).toBe(429);
    expect(statusOf(new Error('[503] UNAVAILABLE'))).toBe(503);
    expect(statusOf(new Error('Error at /projects/app-500/models'))).toBeNull();
  });
});

describe('retryAfterMs', () => {
  it('honours what the server asked for, in any of its forms', () => {
    const retryInfo = [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure' }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17s' }];
    expect(retryAfterMs(aiError(429, 'quota', retryInfo))).toBe(17_000);
    expect(retryAfterMs(new Error('[429 ] Quota exceeded. Please retry in 2.5s.'))).toBe(2500);
    expect(retryAfterMs(new Error('[429 ] {"retryDelay": "4s"}'))).toBe(4000);
    expect(retryAfterMs({ retryAfter: 3 })).toBe(3000);
    expect(retryAfterMs({ headers: { get: (k: string) => (k === 'retry-after' ? '5' : null) } })).toBe(5000);
    expect(retryAfterMs(new Error('[500 ] busy'))).toBeNull();
  });
});

describe('withRetry', () => {
  const fake = () => {
    let t = 0;
    const waits: number[] = [];
    return { waits, opts: { now: () => t, random: () => 0.5, sleep: async (ms: number) => void (waits.push(ms), (t += ms)) } };
  };

  it('retries temporary errors with exponential backoff and jitter, then succeeds', async () => {
    const f = fake();
    let calls = 0;
    const r = await withRetry(async () => {
      if (++calls < 4) throw new Error('[500 ] high demand');
      return 'ok';
    }, f.opts);
    expect(r).toEqual({ value: 'ok', tries: 4 });
    expect(f.waits).toEqual([750, 1500, 3000]); // half the step plus a random half (0.5 here)
  });

  it('gives up at once on an error that will not go away, and says how many times it tried', async () => {
    const f = fake();
    const err = new Error('[401 ] App Check');
    await expect(withRetry(async () => Promise.reject(err), f.opts)).rejects.toBe(err);
    expect(f.waits).toEqual([]);
    expect((err as unknown as { tries: number }).tries).toBe(1);
  });

  it('waits as long as the server asks, but not for a quota that resets in minutes', async () => {
    const f = fake();
    let calls = 0;
    await withRetry(async () => {
      if (++calls === 1) throw aiError(429, 'Please retry in 3s.');
      return 'ok';
    }, f.opts);
    expect(f.waits[0]).toBeGreaterThanOrEqual(3000);
    const g = fake();
    await expect(withRetry(async () => Promise.reject(aiError(429, 'Please retry in 600s.')), g.opts)).rejects.toThrow(/600s/);
    expect(g.waits).toEqual([]);
  });

  it('stops within its time budget and after its retries', async () => {
    const f = fake();
    let calls = 0;
    await expect(withRetry(async () => (calls++, Promise.reject(new Error('[503] UNAVAILABLE'))), { ...f.opts, budgetMs: 2000 })).rejects.toThrow();
    expect(calls).toBe(2); // 750 ms + 1500 ms would not fit in 2 s
    const g = fake();
    calls = 0;
    await expect(withRetry(async () => (calls++, Promise.reject(new Error('[503] UNAVAILABLE'))), { ...g.opts, retries: 2 })).rejects.toThrow();
    expect(calls).toBe(3);
  });

  it('stops when the caller cancels', async () => {
    const ctrl = new AbortController();
    let calls = 0;
    const run = withRetry(
      async () => {
        calls++;
        ctrl.abort();
        throw new Error('[503] UNAVAILABLE');
      },
      { signal: ctrl.signal, sleep: async () => undefined },
    );
    await expect(run).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('withTimeout', () => {
  it('returns a fast answer', async () => {
    await expect(withTimeout(async () => 'ok', 1000, () => new ModelTimeout('cloud', 1000))).resolves.toBe('ok');
  });

  it('ends a call that hangs, aborting its signal, even if the call ignores the signal (the on-device SDK path)', async () => {
    let seen: AbortSignal | null = null;
    const hang = (signal: AbortSignal) => {
      seen = signal;
      return new Promise<string>(() => undefined);
    };
    const t0 = Date.now();
    await expect(withTimeout(hang, 30, () => new ModelTimeout('cloud', 30))).rejects.toBeInstanceOf(ModelTimeout);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(seen!.aborted).toBe(true);
  });

  it('a hung cloud ends in a temporary error after the retries, within the budget', async () => {
    let calls = 0;
    const t0 = Date.now();
    const run = withRetry(
      (_attempt, remaining) => {
        calls++;
        const ms = Math.min(40, remaining);
        return withTimeout(() => new Promise<string>(() => undefined), ms, () => new ModelTimeout('cloud', ms));
      },
      { retries: 2, baseMs: 5, budgetMs: 500 },
    );
    const err = await run.catch((e) => e);
    expect(err).toBeInstanceOf(ModelTimeout);
    expect(isTemporary(err)).toBe(true);
    expect(calls).toBe(3);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('a cancel from the caller is final, not a timeout', async () => {
    const ctrl = new AbortController();
    const run = withTimeout(() => new Promise<string>(() => undefined), 5000, () => new ModelTimeout('cloud', 5000), ctrl.signal);
    ctrl.abort();
    const err = await run.catch((e) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(isTemporary(err)).toBe(false);
  });
});
