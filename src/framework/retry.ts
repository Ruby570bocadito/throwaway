/**
 * Errors worth retrying: rate limits, overload and transient server errors. App Check or schema errors are not.
 * Measured live (16-nov): Gemini answers [500] "This model is currently experiencing high demand" under load.
 */
export function isTemporary(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e);
  return /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|overloaded|high demand|try again later/i.test(msg);
}
