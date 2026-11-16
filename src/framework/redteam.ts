// The pattern: a local defender and a cloud attacker.
// A Threat says how to find clues and sanitize locally, and how to attack what will be published.
// `redTeam` runs the loop: attack → if exposed, sanitize with the attacker's feedback → attack again.

import type { Private, Publishable } from './data';
import type { Ledger } from './ledger';
import type { CloudModel, LocalModel } from './models';

export interface Kit {
  local: LocalModel;
  cloud: CloudModel;
  ledger: Ledger;
}

export interface Threat<Input, Clue, Verdict> {
  id: string;
  /** What the attacker is trying to learn, in one line ("who wrote this", "where this photo was taken"). */
  question: string;
  /** Local only: what in the private input gives you away. */
  findClues(input: Private<Input>, kit: Kit): Promise<Clue[]>;
  /** Local only: produce a version without those clues, released for publication via `release()`. */
  sanitize(input: Private<Input>, clues: Clue[], feedback: Verdict | null, kit: Kit): Promise<Publishable<Input>>;
  /** Cloud: attack only what will be published. */
  attack(published: Publishable<Input>, kit: Kit): Promise<Verdict>;
  /** Is the user still exposed according to this verdict? */
  exposed(verdict: Verdict): boolean;
}

export type RedTeamEvent<Input, Clue, Verdict> =
  | { type: 'clues'; clues: Clue[] }
  | { type: 'sanitized'; round: number; published: Publishable<Input> }
  | { type: 'attacked'; round: number; verdict: Verdict; exposed: boolean }
  | { type: 'safe'; round: number; published: Publishable<Input> }
  | { type: 'gave-up'; round: number; published: Publishable<Input> };

/**
 * Runs the defend/attack loop. `asIs` is the untouched input, released only if the user confirmed they would publish it
 * that way; it gives a baseline. Without it, the first attack is on the first sanitized version.
 */
export async function* redTeam<I, C, V>(
  threat: Threat<I, C, V>,
  input: Private<I>,
  kit: Kit,
  opts: { maxRounds?: number; asIs?: Publishable<I> } = {},
): AsyncGenerator<RedTeamEvent<I, C, V>> {
  const maxRounds = opts.maxRounds ?? 3;
  const clues = await threat.findClues(input, kit);
  yield { type: 'clues', clues };

  let feedback: V | null = null;
  let current: Publishable<I> | undefined = opts.asIs;
  if (current) {
    feedback = await threat.attack(current, kit);
    const exposed = threat.exposed(feedback);
    yield { type: 'attacked', round: 0, verdict: feedback, exposed };
    if (!exposed) return yield { type: 'safe', round: 0, published: current };
  }
  for (let round = 1; round <= maxRounds; round++) {
    current = await threat.sanitize(input, clues, feedback, kit);
    yield { type: 'sanitized', round, published: current };
    feedback = await threat.attack(current, kit);
    const exposed = threat.exposed(feedback);
    yield { type: 'attacked', round, verdict: feedback, exposed };
    if (!exposed) return yield { type: 'safe', round, published: current };
  }
  yield { type: 'gave-up', round: maxRounds, published: current! };
}
