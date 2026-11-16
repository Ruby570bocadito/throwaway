// Errors worth retrying, and how: rate limits, overload, transient server errors, network blips and timeouts of the
// cloud. App Check, schema, safety or privacy errors are not. Measured live (16-nov): Gemini answers [500] "This model is
// currently experiencing high demand" under load.

import { PrivacyViolation } from './guard';

/** A model call that did not answer in time. The cloud one is temporary (retry); the device one is not (Nano is stuck). */
export class ModelTimeout extends Error {
  readonly where: 'cloud' | 'device';
  readonly ms: number;
  constructor(where: 'cloud' | 'device', ms: number) {
    super(
      where === 'cloud'
        ? `The cloud model did not answer within ${Math.round(ms / 1000)} s.`
        : `Gemini Nano did not answer within ${Math.round(ms / 1000)} s on this device.`,
    );
    this.name = 'TimeoutError';
    this.where = where;
    this.ms = ms;
  }
}

const TEMPORARY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const messageOf = (e: unknown) => String((e as Error)?.message ?? e ?? '');

/** The HTTP status of an error: Firebase AI Logic's `customErrorData.status`, a `status` field, or "[503 …]" in the message. */
export function statusOf(e: unknown): number | null {
  const o = (e && typeof e === 'object' ? e : {}) as { customErrorData?: { status?: unknown }; status?: unknown };
  for (const v of [o.customErrorData?.status, o.status]) if (typeof v === 'number' && v >= 100 && v < 600) return v;
  const m = messageOf(e).match(/\[(\d{3})(?:[ \]]|$)|\bstatus(?: code)?:? (\d{3})\b/i);
  return m ? Number(m[1] ?? m[2]) : null;
}

export function isTemporary(e: unknown): boolean {
  if (!e || e instanceof PrivacyViolation) return false;
  if (e instanceof ModelTimeout) return e.where === 'cloud';
  const status = statusOf(e);
  if (status !== null) return TEMPORARY_STATUS.has(status);
  const msg = messageOf(e);
  // The SDK's own timeout is an AbortError ("Timeout has expired."); a user's cancel is an AbortError too, and is final.
  if ((e as Error).name === 'AbortError') return /time ?out|timed out|expired/i.test(msg);
  return (
    /\b(RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED)\b/.test(msg) ||
    /overloaded|high demand|try again later|temporarily unavailable|internal error|timed out|failed to fetch|networkerror|network error|load failed|err_network|err_internet_disconnected|connection (?:reset|closed)|econnreset|socket hang up/i.test(
      msg,
    )
  );
}

const durationMs = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v * 1000; // seconds
  if (v && typeof v === 'object') {
    const { seconds, nanos } = v as { seconds?: unknown; nanos?: unknown };
    if (seconds !== undefined) return Number(seconds) * 1000 + Number(nanos ?? 0) / 1e6;
  }
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)?$/i);
  if (m) return Number(m[1]) * (m[2]?.toLowerCase() === 'ms' ? 1 : 1000);
  const date = Date.parse(v); // Retry-After can be an HTTP date
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
};

/**
 * How long the server asked us to wait, if it did: Google's `RetryInfo.retryDelay` (in the error details or the message,
 * e.g. "Please retry in 17.39s"), a `retryAfter` field, or a Retry-After header.
 */
export function retryAfterMs(e: unknown): number | null {
  const o = (e && typeof e === 'object' ? e : {}) as {
    customErrorData?: { errorDetails?: unknown };
    retryAfter?: unknown;
    headers?: { get?: (k: string) => string | null };
    response?: { headers?: { get?: (k: string) => string | null } };
  };
  const details = o.customErrorData?.errorDetails;
  if (Array.isArray(details)) {
    for (const d of details) {
      if (d && typeof d === 'object' && /RetryInfo$/.test(String((d as Record<string, unknown>)['@type'] ?? ''))) {
        const ms = durationMs((d as { retryDelay?: unknown }).retryDelay);
        if (ms !== null) return ms;
      }
    }
  }
  for (const v of [o.retryAfter, o.headers?.get?.('retry-after'), o.response?.headers?.get?.('retry-after')]) {
    const ms = durationMs(v);
    if (ms !== null) return ms;
  }
  const m = messageOf(e).match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"|retry in (\d+(?:\.\d+)?)\s*(ms|s)\b|retry-after:?\s*(\d+(?:\.\d+)?)/i);
  if (!m) return null;
  if (m[1]) return Number(m[1]) * 1000;
  if (m[2]) return Number(m[2]) * (m[3].toLowerCase() === 'ms' ? 1 : 1000);
  return Number(m[4]) * 1000;
}

const abortError = (signal: AbortSignal) => signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal!));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * Runs `fn` with a deadline. The signal given to `fn` aborts at the deadline (or when `parent` aborts), so a fetch is
 * cancelled, and the wait ends even if `fn` ignores the signal (the on-device SDK path does).
 */
export async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number, onTimeout: () => Error, parent?: AbortSignal): Promise<T> {
  if (parent?.aborted) throw abortError(parent);
  const ctrl = new AbortController();
  const fromParent = () => ctrl.abort(parent?.reason);
  parent?.addEventListener('abort', fromParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = onTimeout();
      ctrl.abort(err);
      reject(err);
    }, ms);
  });
  const cancelled = new Promise<never>((_, reject) => ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason), { once: true }));
  try {
    return await Promise.race([fn(ctrl.signal), deadline, cancelled]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', fromParent);
  }
}

export interface RetryOptions {
  /** Retries after the first try (default 4). */
  retries?: number;
  /** First backoff step (default 1 s); it doubles each time, up to `maxDelayMs` (default 8 s), with jitter. */
  baseMs?: number;
  maxDelayMs?: number;
  /** Total time for every try and wait together (default: no limit). A retry that would not fit is not made. */
  budgetMs?: number;
  /** A server asking for a longer wait than this (default 20 s) is a quota, not a blip: give up and say so. */
  maxRetryAfterMs?: number;
  signal?: AbortSignal;
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
  /** For tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
}

/** How many times a failed call was sent, when withRetry gave up (the ledger counts every byte that may have left). */
export const triesOf = (e: unknown): number => {
  const t = (e as { tries?: unknown } | null)?.tries;
  return typeof t === 'number' && t > 0 ? t : 1;
};

/**
 * Retries temporary errors with exponential backoff and equal jitter, honouring the server's Retry-After / RetryInfo.
 * `fn` gets the attempt number and the time left in the budget (to cap its own timeout).
 */
export async function withRetry<T>(fn: (attempt: number, remainingMs: number) => Promise<T>, o: RetryOptions = {}): Promise<{ value: T; tries: number }> {
  const retries = o.retries ?? 4;
  const base = o.baseMs ?? 1000;
  const maxDelay = o.maxDelayMs ?? 8000;
  const budget = o.budgetMs ?? Infinity;
  const maxRetryAfter = o.maxRetryAfterMs ?? 20_000;
  const now = o.now ?? (() => Date.now());
  const random = o.random ?? Math.random;
  const sleep = o.sleep ?? defaultSleep;
  const t0 = now();
  for (let attempt = 0; ; attempt++) {
    if (o.signal?.aborted) throw abortError(o.signal);
    try {
      return { value: await fn(attempt, budget - (now() - t0)), tries: attempt + 1 };
    } catch (e) {
      const asked = retryAfterMs(e);
      const step = Math.min(maxDelay, base * 2 ** attempt);
      const delay = Math.round(asked !== null ? asked + random() * 250 : step / 2 + random() * (step / 2));
      const stop =
        !isTemporary(e) || attempt >= retries || (asked !== null && asked > maxRetryAfter) || now() - t0 + delay >= budget || !!o.signal?.aborted;
      if (stop) {
        if (e && typeof e === 'object' && Object.isExtensible(e)) (e as { tries?: number }).tries = attempt + 1;
        throw e;
      }
      o.onRetry?.({ attempt: attempt + 1, delayMs: delay, error: e });
      await sleep(delay, o.signal);
    }
  }
}
