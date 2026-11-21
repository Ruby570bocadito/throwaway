// Recorded model responses for the reproducible demo. They run through the real framework (privacy guard, ledger,
// lineup shuffling, image masking), only the model answers are replayed.

import { recordedBackend } from '../framework';
import { ATTACK_AFTER, ATTACK_BEFORE, CLAIMS, CONTENT_DETAILS, LINEUP, REWRITE } from './scenario';
import { PHOTO_CLUES, recordedGeo, SCENE_READS } from './photo';

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
      // REAL readings, cell by cell, by Gemini Nano in the author's Chrome (?diag photo bench, 21-nov).
      if (prompt.startsWith('Write every piece of text')) {
        const cell = Number(prompt.match(/cell (\d+) of a photo/)?.[1]);
        return JSON.stringify({ texts: SCENE_READS[cell] ?? [] });
      }
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
      const pick = letterFor(prompt, run.picks[i]);
      // The recorded reasons name the writer they picked by its letter in that run; this lineup is shuffled again.
      const reasons = run.reasons.map((r) => r.replace(/\bWriter [A-J]\b/g, `Writer ${pick}`));
      return JSON.stringify({ pick, confidence: isRewrite ? 'low' : 'high', reasons });
    },
    220,
  );
  return { local, cloud };
}
