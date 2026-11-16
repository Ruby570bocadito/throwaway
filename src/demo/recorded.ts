// Recorded model responses for the reproducible demo. They run through the real framework (privacy guard, ledger,
// lineup shuffling, image masking), only the model answers are replayed.

import { recordedBackend } from '../framework';
import { ATTACK_AFTER, ATTACK_BEFORE, CLAIMS, CONTENT_DETAILS, LINEUP, REWRITE } from './scenario';
import { PHOTO_CLUES, recordedGeo } from './photo';

/** Finds the lineup letter the prompt assigned to a candidate (the lineup is shuffled on every attempt). */
function letterFor(prompt: string, id: string): string {
  const corpus = LINEUP.find((c) => c.id === id)?.corpus.slice(0, 40);
  const m = [...prompt.matchAll(/Writer ([A-J]):\n/g)].find((x) => corpus && prompt.slice((x.index ?? 0) + x[0].length).trimStart().startsWith(corpus));
  return m?.[1] ?? 'A';
}

export function demoBackends() {
  const local = recordedBackend(
    'Gemini Nano (on-device)',
    (prompt) => {
      // The five real details Gemini Nano found in the draft. Fixed rules generalise them before the rewrite.
      if (prompt.startsWith('List details')) return JSON.stringify({ details: CONTENT_DETAILS });
      if (prompt.startsWith('This photo')) return JSON.stringify({ clues: PHOTO_CLUES });
      if (prompt.startsWith('Rewrite the DRAFT')) return JSON.stringify({ rewrite: REWRITE });
      if (prompt.startsWith('Compare the ORIGINAL')) return JSON.stringify({ claims: CLAIMS.map((claim) => ({ claim, kept: true })) });
      return '{}';
    },
    900,
  );
  let beforeCall = 0;
  let afterCall = 0;
  const cloud = recordedBackend(
    'Gemini (cloud)',
    (prompt) => {
      if (prompt.startsWith('You are an OSINT geolocation analyst')) {
        const m = prompt.match(/Masked cells: ([\d, ]+|none)/);
        const masked = !m || m[1] === 'none' ? [] : m[1].split(',').map((x) => Number(x.trim()));
        return JSON.stringify(recordedGeo(masked));
      }
      const isRewrite = prompt.includes(REWRITE.slice(0, 40));
      const run = isRewrite ? ATTACK_AFTER : ATTACK_BEFORE;
      const i = isRewrite ? afterCall++ % run.picks.length : beforeCall++ % run.picks.length;
      return JSON.stringify({ pick: letterFor(prompt, run.picks[i]), confidence: isRewrite ? 'low' : 'high', reasons: run.reasons });
    },
    220,
  );
  return { local, cloud };
}
