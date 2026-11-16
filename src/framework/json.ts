// Small models often wrap JSON in markdown fences or add a sentence around it. Parse defensively.

export function parseModelJson<T = unknown>(text: string): T {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall back to the first balanced-looking object or array in the text.
    const start = cleaned.search(/[[{]/);
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T;
      } catch {
        /* fall through */
      }
    }
    throw new Error(`The model did not return valid JSON: ${text.slice(0, 120)}`);
  }
}

/** JSON Schema subset accepted by both Chrome's Prompt API (responseConstraint) and Gemini (responseJsonSchema). */
export type JsonSchema = Record<string, unknown>;
