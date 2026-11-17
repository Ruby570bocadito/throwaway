// Model adapters. Two sides with different types:
//  - LocalModel reads anything, including Private values. It must run on the device.
//  - CloudModel only accepts plain instructions, Publishable and Public values. Private does not type-check,
//    and every outgoing payload is taint-checked before it is sent.

import { isReleased, Private, Public, Publishable } from './data';
import { assertUntainted, PrivacyViolation } from './guard';
import { byteLength, type Ledger } from './ledger';
import type { JsonSchema } from './json';
import type { BusyEvent } from './fallback';
import { isTemporary, ModelTimeout, triesOf } from './retry';

export type LocalPart = string | Private<string> | Publishable<string> | Public<string> | { image: Private<Uint8Array> | Publishable<Uint8Array>; mime: string };
export type CloudPart = string | Publishable<string> | Public<string> | { image: Publishable<Uint8Array>; mime: string };

export interface GenerateOptions {
  json?: boolean;
  /** JSON Schema for structured output: Chrome's responseConstraint on-device, responseJsonSchema in the cloud. */
  schema?: JsonSchema;
  /** Short label for the ledger. */
  op: string;
  /** Cancels the call (and its retries), e.g. when the user leaves the page. */
  signal?: AbortSignal;
  /** Told while the call waits on a busy model: a retry, or a move to a backup model. */
  onBusy?: (e: BusyEvent) => void;
}

export interface ModelResult {
  text: string;
  /** Where the SDK says inference actually ran. */
  source: 'on_device' | 'in_cloud' | 'recorded';
  /** How many times the request was sent (retries after busy answers). Every try sends the bytes again. */
  tries?: number;
  /** Set when a backup model answered because the main one was busy: which one. */
  model?: string;
  backup?: boolean;
}

/** What an adapter receives after the framework has resolved the parts. */
export type ResolvedPart = { text: string } | { image: Uint8Array; mime: string };

export interface ModelBackend {
  readonly name: string;
  generate(parts: ResolvedPart[], opts: GenerateOptions): Promise<ModelResult>;
}

function resolveLocal(parts: LocalPart[]): ResolvedPart[] {
  return parts.map((p) => {
    if (typeof p === 'string') return { text: p };
    if (p instanceof Private) return { text: Private.openLocally(p) };
    if (p instanceof Publishable || p instanceof Public) return { text: p.value };
    const img = p.image instanceof Private ? Private.openLocally(p.image) : p.image.value;
    return { image: img, mime: p.mime };
  });
}

const IMAGE_MIME = /^image\/[a-z0-9.+-]{1,40}$/i;

/**
 * Resolves cloud parts and enforces the contract at run time (defence in depth: the types already forbid most of this,
 * the checks catch `as any`, plain JS callers and private text pasted into strings).
 *  - Private: always refused.
 *  - Plain strings and Public data: taint-checked against everything registered as private, one by one and then joined,
 *    so a draft cut into short parts is still the draft. The structured-output schema goes to the cloud too: checked.
 *  - Publishable: trusted only if release() minted it.
 *  - Images: only as Publishable bytes, with an image mime type (the mime string is sent as well).
 */
function resolveCloud(parts: CloudPart[], schema?: JsonSchema): ResolvedPart[] {
  const unreleased: string[] = [];
  const resolved = parts.map((raw): ResolvedPart => {
    const p = raw as unknown;
    if (p instanceof Private) throw new PrivacyViolation('cloud call', p.label);
    if (typeof p === 'string') {
      assertUntainted(p, 'cloud prompt text');
      unreleased.push(p);
      return { text: p };
    }
    if (isReleased(p)) {
      if (typeof p.value !== 'string') throw new PrivacyViolation('cloud call', 'a released image passed as text');
      return { text: p.value };
    }
    if (p instanceof Public) {
      // Text first: an object's toString() could return anything, so the string that would be sent is what gets checked.
      const text = typeof p.value === 'string' ? p.value : String(p.value);
      assertUntainted(text, `public data (${p.source})`);
      unreleased.push(text);
      return { text };
    }
    if (p && typeof p === 'object' && 'image' in p) {
      const part = p as { image: unknown; mime: unknown };
      if (!isReleased(part.image) || !(part.image.value instanceof Uint8Array)) {
        throw new PrivacyViolation('cloud call', 'an image that was not released');
      }
      if (typeof part.mime !== 'string' || !IMAGE_MIME.test(part.mime)) throw new PrivacyViolation('cloud call', 'an image part without an image mime type');
      return { image: part.image.value, mime: part.mime };
    }
    throw new PrivacyViolation('cloud call', 'unknown part type');
  });
  if (unreleased.length > 1) assertUntainted(unreleased.join('\n'), 'cloud prompt (parts joined)');
  if (schema) assertUntainted(JSON.stringify(schema), 'structured-output schema');
  return resolved;
}

const sizeOf = (parts: ResolvedPart[]) => parts.reduce((a, p) => a + ('text' in p ? byteLength(p.text) : p.image.length), 0);

/** Why a call got no answer, in the ledger's words. */
function failureNote(e: unknown): string {
  if (e instanceof ModelTimeout) return `no answer (timed out after ${Math.round(e.ms / 1000)} s)`;
  if ((e as Error)?.name === 'AbortError') return 'cancelled';
  return isTemporary(e) ? 'no answer (model busy)' : 'failed';
}

export class LocalModel {
  private backend: ModelBackend;
  private ledger: Ledger;
  constructor(backend: ModelBackend, ledger: Ledger) {
    this.backend = backend;
    this.ledger = ledger;
  }
  get name() {
    return this.backend.name;
  }
  async generate(parts: LocalPart[], opts: GenerateOptions): Promise<ModelResult> {
    const resolved = resolveLocal(parts);
    const t0 = performance.now();
    let res: ModelResult;
    try {
      res = await this.backend.generate(resolved, opts);
    } catch (e) {
      this.ledger.add({ op: opts.op, route: 'on-device', ms: Math.round(performance.now() - t0), bytesOut: 0, note: failureNote(e) });
      throw e;
    }
    if (res.source !== 'on_device' && res.source !== 'recorded') {
      // A local model must never run in the cloud. If the SDK ever did that (or cannot say where it ran), report it loudly.
      this.ledger.add({ op: opts.op, route: 'blocked', ms: 0, bytesOut: 0, note: 'local model answered from cloud' });
      throw new PrivacyViolation(opts.op, 'local call was served from the cloud');
    }
    this.ledger.add({ op: opts.op, route: 'on-device', ms: Math.round(performance.now() - t0), bytesOut: 0, note: res.source === 'recorded' ? 'recorded' : undefined });
    return res;
  }
}

export class CloudModel {
  private backend: ModelBackend;
  private ledger: Ledger;
  private busyListeners = new Set<(e: BusyEvent) => void>();
  constructor(backend: ModelBackend, ledger: Ledger) {
    this.backend = backend;
    this.ledger = ledger;
  }
  get name() {
    return this.backend.name;
  }
  /** While a call waits on a busy model, the UI can say so instead of showing a spinner that looks stuck. */
  onBusy(fn: (e: BusyEvent) => void): () => void {
    this.busyListeners.add(fn);
    return () => {
      this.busyListeners.delete(fn);
    };
  }
  async generate(parts: CloudPart[], opts: GenerateOptions): Promise<ModelResult> {
    let resolved: ResolvedPart[];
    try {
      resolved = resolveCloud(parts, opts.schema);
    } catch (e) {
      this.ledger.add({ op: opts.op, route: 'blocked', ms: 0, bytesOut: 0, note: (e as Error).message.slice(0, 90) });
      throw e;
    }
    const bytes = sizeOf(resolved);
    const t0 = performance.now();
    // The user may choose to send their original as it is ("Attack it as I would post it"): allowed, and said so.
    const asIs = parts.some((p) => (isReleased(p) && p.confirmedAsIs) || (typeof p === 'object' && 'image' in p && p.image.confirmedAsIs));
    const notes = (...more: string[]) => [asIs ? 'original, sent as-is by your choice' : '', ...more].filter(Boolean).join(' · ') || undefined;
    let res: ModelResult;
    try {
      res = await this.backend.generate(resolved, {
        ...opts,
        onBusy: (e) => {
          opts.onBusy?.(e);
          this.busyListeners.forEach((fn) => fn(e));
        },
      });
    } catch (e) {
      // A failed call may still have sent its bytes (every try did): the ledger counts them.
      const tries = triesOf(e);
      this.ledger.add({ op: opts.op, route: 'cloud', ms: Math.round(performance.now() - t0), bytesOut: bytes * tries, note: notes(failureNote(e)) });
      throw e;
    }
    const tries = Math.max(1, res.tries ?? 1);
    this.ledger.add({
      op: opts.op,
      route: 'cloud',
      ms: Math.round(performance.now() - t0),
      bytesOut: bytes * tries,
      note: notes(
        res.backup && res.model ? `answered by ${res.model}, the backup model (main model busy)` : '',
        tries > 1 ? `sent ${tries} times (model busy)` : '',
        res.source === 'recorded' ? 'recorded' : '',
      ),
    });
    return res;
  }
}
