// Cloud models in order of preference, for when one is busy. Measured live (16-nov): Gemini answers [500] "This model is
// currently experiencing high demand" for a minute or more at a time, and a whole lineup attack failed with it. Another
// model has its own capacity, so a busy call moves on to the next model instead of waiting on the same one.

import { isBlocked, isTemporary, triesOf, withRetry, type RetryOptions } from './retry';

export interface PoolModel<M> {
  name: string;
  model: M;
}

/** What a waiting caller is told: a retry on the same model, or a switch to the next one. */
export type BusyEvent = { kind: 'retry'; model: string; delayMs: number } | { kind: 'switch'; from: string; to: string };

export interface PoolOptions extends RetryOptions {
  /** Tries on a model before moving on, when there is another one to move on to (default 2). */
  triesPerModel?: number;
  /**
   * Time kept for each model further down the list (default 15 s), and the longest a single try may take on a model
   * that has a backup (default 20 s). An overloaded model often answers slowly instead of failing fast: without these,
   * two slow tries on the main model spent the whole budget and the backup was never asked (17-nov).
   */
  reserveMs?: number;
  tryCapMs?: number;
  onBusy?: (e: BusyEvent) => void;
}

function stamp(e: unknown, tries: number) {
  if (e && typeof e === 'object' && Object.isExtensible(e)) (e as { tries?: number }).tries = tries;
  return e;
}

/**
 * Runs a call on the first model that answers. A busy model (overloaded, rate-limited or timing out) is skipped for
 * `coolDownMs` (default 60 s), so the ten attempts of a lineup do not each wait on it first. The last model in the order
 * gets the remaining retries; the whole call keeps one time budget.
 */
export class ModelPool<M> {
  readonly models: PoolModel<M>[];
  private busyUntil = new Map<string, number>();
  private coolDownMs: number;
  private now: () => number;

  constructor(models: PoolModel<M>[], o: { coolDownMs?: number; now?: () => number } = {}) {
    if (!models.length) throw new Error('A model pool needs at least one model.');
    this.models = models;
    this.coolDownMs = o.coolDownMs ?? 60_000;
    this.now = o.now ?? (() => Date.now());
  }

  /** The order to try now: the models that are answering, in order of preference, then the busy ones, soonest free first. */
  order(): PoolModel<M>[] {
    const t = this.now();
    const until = (m: PoolModel<M>) => this.busyUntil.get(m.name) ?? 0;
    const free = this.models.filter((m) => until(m) <= t);
    const busy = this.models.filter((m) => until(m) > t).sort((a, b) => until(a) - until(b));
    return [...free, ...busy];
  }

  async run<T>(call: (m: PoolModel<M>, remainingMs: number) => Promise<T>, o: PoolOptions = {}): Promise<{ value: T; tries: number; model: string }> {
    const now = o.now ?? this.now;
    const budget = o.budgetMs ?? Infinity;
    const t0 = now();
    const list = this.order();
    let tries = 0;
    let firstError: unknown = null;
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      const last = i === list.length - 1;
      const remaining = budget - (now() - t0);
      if (remaining <= 0) break;
      // A model with backups after it leaves them their share of the budget, and no single try of it may run long.
      const mine = last ? remaining : remaining - (list.length - 1 - i) * (o.reserveMs ?? 15_000);
      if (mine <= 0) continue;
      const cap = last ? Infinity : (o.tryCapMs ?? 20_000);
      try {
        const r = await withRetry((_attempt, rem) => call(m, Math.min(rem, cap)), {
          ...o,
          retries: last ? (o.retries ?? 4) : Math.max(0, (o.triesPerModel ?? 2) - 1),
          budgetMs: mine,
          onRetry: (info) => {
            o.onRetry?.(info);
            o.onBusy?.({ kind: 'retry', model: m.name, delayMs: info.delayMs });
          },
        });
        this.busyUntil.delete(m.name);
        return { value: r.value, tries: tries + r.tries, model: m.name };
      } catch (e) {
        tries += triesOf(e);
        firstError ??= e;
        // A real error from the first model (a bad request, App Check) is not the model being busy: say it. A safety block
        // goes on to the backup, which has filters of its own (21-nov review). From a backup any error is skipped like a busy
        // one, and the caller hears the first model's error, which says more.
        if ((!isTemporary(e) && !isBlocked(e) && i === 0) || o.signal?.aborted) throw stamp(e, tries);
        this.busyUntil.set(m.name, now() + this.coolDownMs);
        if (!last) o.onBusy?.({ kind: 'switch', from: m.name, to: list[i + 1].name });
      }
    }
    throw stamp(firstError ?? new Error('No model answered in time.'), tries);
  }
}
