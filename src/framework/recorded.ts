// A backend that replays recorded responses. Used for reproducible demos and tests.
// It goes through the same LocalModel / CloudModel wrappers, so the privacy guard and the ledger still apply.

import type { GenerateOptions, ModelBackend, ModelResult, ResolvedPart } from './models';

export type Script = (prompt: string, opts: GenerateOptions, call: number) => string;

export function recordedBackend(name: string, script: Script, delayMs = 300): ModelBackend {
  let call = 0;
  return {
    name: `${name} (recorded)`,
    async generate(parts: ResolvedPart[], opts: GenerateOptions): Promise<ModelResult> {
      const prompt = parts.map((p) => ('text' in p ? p.text : `[image ${p.image.length} bytes]`)).join('\n');
      await new Promise((r) => setTimeout(r, delayMs));
      return { text: script(prompt, opts, call++), source: 'recorded' };
    },
  };
}
