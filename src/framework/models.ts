// Model adapters. Two sides with different types:
//  - LocalModel reads anything, including Private values. It must run on the device.
//  - CloudModel only accepts plain instructions, Publishable and Public values. Private does not type-check,
//    and every outgoing payload is taint-checked before it is sent.

import { Private, Public, Publishable } from './data';
import { assertUntainted, PrivacyViolation } from './guard';
import { byteLength, type Ledger } from './ledger';
import type { JsonSchema } from './json';

export type LocalPart = string | Private<string> | Publishable<string> | Public<string> | { image: Private<Uint8Array> | Publishable<Uint8Array>; mime: string };
export type CloudPart = string | Publishable<string> | Public<string> | { image: Publishable<Uint8Array>; mime: string };

export interface GenerateOptions {
  json?: boolean;
  /** JSON Schema for structured output: Chrome's responseConstraint on-device, responseJsonSchema in the cloud. */
  schema?: JsonSchema;
  /** Short label for the ledger. */
  op: string;
}

export interface ModelResult {
  text: string;
  /** Where the SDK says inference actually ran. */
  source: 'on_device' | 'in_cloud' | 'recorded';
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

/**
 * Resolves cloud parts and enforces the contract at run time (defence in depth: the types already forbid most of this,
 * the checks catch `as any`, plain JS callers and private text pasted into strings).
 *  - Private: always refused.
 *  - Plain strings and Public data: taint-checked against everything registered as private.
 *  - Publishable: trusted, it already went through release().
 *  - Images: only as Publishable.
 */
function resolveCloud(parts: CloudPart[]): ResolvedPart[] {
  return parts.map((raw) => {
    const p = raw as unknown;
    if (p instanceof Private) throw new PrivacyViolation('cloud call', p.label);
    if (typeof p === 'string') {
      assertUntainted(p, 'cloud prompt text');
      return { text: p };
    }
    if (p instanceof Publishable) {
      if (typeof p.value !== 'string') throw new PrivacyViolation('cloud call', 'a released image passed as text');
      return { text: p.value };
    }
    if (p instanceof Public) {
      assertUntainted(p.value, `public data (${p.source})`);
      return { text: String(p.value) };
    }
    if (p && typeof p === 'object' && 'image' in p) {
      const part = p as { image: unknown; mime: string };
      if (!(part.image instanceof Publishable) || !(part.image.value instanceof Uint8Array)) {
        throw new PrivacyViolation('cloud call', 'an image that was not released');
      }
      return { image: part.image.value, mime: part.mime };
    }
    throw new PrivacyViolation('cloud call', 'unknown part type');
  });
}

const sizeOf = (parts: ResolvedPart[]) => parts.reduce((a, p) => a + ('text' in p ? byteLength(p.text) : p.image.length), 0);

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
    const res = await this.backend.generate(resolved, opts);
    if (res.source === 'in_cloud') {
      // A local model must never run in the cloud. If the SDK ever did that, report it loudly.
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
  constructor(backend: ModelBackend, ledger: Ledger) {
    this.backend = backend;
    this.ledger = ledger;
  }
  get name() {
    return this.backend.name;
  }
  async generate(parts: CloudPart[], opts: GenerateOptions): Promise<ModelResult> {
    let resolved: ResolvedPart[];
    try {
      resolved = resolveCloud(parts);
    } catch (e) {
      this.ledger.add({ op: opts.op, route: 'blocked', ms: 0, bytesOut: 0, note: (e as Error).message.slice(0, 90) });
      throw e;
    }
    const bytes = sizeOf(resolved);
    const t0 = performance.now();
    const res = await this.backend.generate(resolved, opts);
    // The user may choose to send their original as it is ("Attack it as I would post it"): allowed, and said so.
    const asIs = parts.some((p) => (p instanceof Publishable && p.confirmedAsIs) || (typeof p === 'object' && 'image' in p && p.image.confirmedAsIs));
    const note = [asIs ? 'original, sent as-is by your choice' : '', res.source === 'recorded' ? 'recorded' : ''].filter(Boolean).join(' · ');
    this.ledger.add({ op: opts.op, route: 'cloud', ms: Math.round(performance.now() - t0), bytesOut: bytes, note: note || undefined });
    return res;
  }
}
