import { formatSeconds, useElapsed } from './motion';

export interface StepDef {
  label: string;
  /** Where the step runs: on your device, in the cloud. */
  where: string;
}

/**
 * Scan → Attack → Fix → Attack again. `current` is the step to do next (steps.length once the loop is over), `busySince` marks
 * it as running (and since when), `outcome` colours the last step, `skipped` lists steps the run did not need, `round` counts
 * fix-and-attack loops.
 */
export function Stepper({
  steps,
  current,
  busySince,
  outcome = null,
  skipped = [],
  round = 1,
}: {
  steps: StepDef[];
  current: number;
  busySince: number | null;
  outcome?: 'good' | 'warn' | 'bad' | null;
  skipped?: number[];
  round?: number;
}) {
  const elapsed = useElapsed(busySince);
  const over = current >= steps.length;
  return (
    <ol className={`stepper ${over ? 'over' : ''}`} aria-label="Progress">
      {steps.map((s, i) => {
        const state = skipped.includes(i) ? 'skip' : i < current ? 'done' : i === current ? (busySince !== null ? 'busy' : 'now') : 'todo';
        const end = over && i === steps.length - 1 && outcome ? outcome : '';
        return (
          <li key={s.label} className={`st ${state} ${end}`} aria-current={i === current ? 'step' : undefined}>
            <span className="st-dot" aria-hidden="true">
              {state === 'busy' ? <span className="spinner" /> : state === 'done' ? (end === 'warn' || end === 'bad' ? '!' : '✓') : state === 'skip' ? '–' : i + 1}
            </span>
            <span className="st-text">
              <span className="st-label">
                {s.label}
                {round > 1 && i >= 2 && i === current && <span className="st-round"> · round {round}</span>}
              </span>
              <span className="st-where">
                {state === 'busy' ? `running · ${formatSeconds(elapsed)}` : state === 'skip' ? 'not needed' : s.where}
              </span>
            </span>
            <span className="sr-only">
              {state === 'done' ? ', done' : state === 'busy' ? ', running' : state === 'now' ? ', next' : state === 'skip' ? ', not needed' : ''}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
