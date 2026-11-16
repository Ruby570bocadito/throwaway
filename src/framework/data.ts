// The privacy contract, enforced twice:
//  1. At compile time: cloud models only accept `Publishable` or `Public` values. A `Private` value does not type-check.
//  2. At run time: every outgoing cloud payload is checked against a taint registry of private data, so a private
//     string that was copied into a plain string still gets blocked.
//
// Three kinds of data:
//  - Private<T>:     the user's original (a draft, a photo). Only local models may read it.
//  - Publishable<T>: something the user explicitly released for publication (the world will see it anyway).
//  - Public<T>:      data that is already public (a public blog, a decoy corpus).

import { registerTaint, assertUntainted, PrivacyViolation } from './guard';

// Only release() may mint a Publishable. The flag makes `new Publishable(...)` throw anywhere else, even from plain JS.
let minting = false;

export class Private<T> {
  readonly #value: T;
  readonly label: string;
  constructor(value: T, label: string) {
    this.#value = value;
    this.label = label;
    registerTaint(value);
  }
  /** Only local adapters call this. Grep for `openLocally` to audit every place private data is read. */
  static openLocally<T>(p: Private<T>): T {
    return p.#value;
  }
}

export class Publishable<T> {
  readonly value: T;
  readonly reason: string;
  readonly releasedAt: number;
  /** True when the user confirmed they would publish the original untouched (the taint check was skipped). */
  readonly confirmedAsIs: boolean;
  /** @internal Use release(). */
  constructor(value: T, reason: string, releasedAt: number, confirmedAsIs: boolean) {
    if (!minting) throw new PrivacyViolation('Publishable', 'constructed outside release()');
    this.value = value;
    this.reason = reason;
    this.releasedAt = releasedAt;
    this.confirmedAsIs = confirmedAsIs;
  }
}

export class Public<T> {
  readonly value: T;
  readonly source: string;
  constructor(value: T, source: string) {
    this.value = value;
    this.source = source;
  }
}

export const secret = <T>(value: T, label = 'private input') => new Private(value, label);
export const publicData = <T>(value: T, source = 'public') => new Public(value, source);

export interface ReleaseOptions {
  /** Derived from content the user already confirmed as publishable as-is (e.g. a grid drawn on it): inherits that confirmation. */
  userConfirmedAsIs?: boolean;
}

/**
 * The only door from local to publishable. A sanitizer calls it with the rewritten / blurred version.
 * It refuses content that still carries long verbatim spans of the private original, unless the user confirmed
 * they would publish it as-is (for example, to measure the risk of the untouched draft).
 */
export function release<T>(value: T, reason: string, opts: ReleaseOptions = {}): Publishable<T> {
  if (!opts.userConfirmedAsIs) assertUntainted(value, `release: ${reason}`);
  minting = true;
  try {
    return new Publishable(value, reason, Date.now(), Boolean(opts.userConfirmedAsIs));
  } finally {
    minting = false;
  }
}
