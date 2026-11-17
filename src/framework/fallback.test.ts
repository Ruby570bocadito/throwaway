import { describe, expect, it } from 'vitest';
import { CloudModel, isDeviceError, isTemporary, Ledger, LocalModel, ModelTimeout, publicData, type BusyEvent, type LedgerEntry, type ModelBackend } from '.';
import { ModelPool } from './fallback';

// Gemini's own answers when it is busy (measured live, 16-nov) and when the request itself is wrong.
const busy = () => Object.assign(new Error('[500] This model is currently experiencing high demand.'), { status: 500 });
const bad = () => Object.assign(new Error('[400] Request contains an invalid argument.'), { status: 400 });
const missing = () => Object.assign(new Error('[404] models/gemini-x is not found.'), { status: 404 });

function clock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}
const fast = { sleep: async () => undefined, random: () => 0 };

describe('a pool of cloud models', () => {
  it('moves a busy call on to the backup, and goes to the backup first for a minute', async () => {
    const c = clock();
    const pool = new ModelPool(
      [
        { name: 'main', model: 'main' },
        { name: 'backup', model: 'backup' },
      ],
      { now: c.now },
    );
    const calls: string[] = [];
    const call = async (m: { model: string }) => {
      calls.push(m.model);
      if (m.model === 'main') throw busy();
      return `answer from ${m.model}`;
    };
    const events: BusyEvent[] = [];
    const r = await pool.run(call, { ...fast, onBusy: (e) => events.push(e) });
    expect(r).toEqual({ value: 'answer from backup', tries: 3, model: 'backup' });
    expect(calls).toEqual(['main', 'main', 'backup']); // two tries on a busy model, then the backup
    expect(events).toEqual([
      { kind: 'retry', model: 'main', delayMs: expect.any(Number) },
      { kind: 'switch', from: 'main', to: 'backup' },
    ]);

    // The next attempt of the lineup does not wait on the busy model again.
    calls.length = 0;
    expect((await pool.run(call, fast)).model).toBe('backup');
    expect(calls).toEqual(['backup']);

    // A minute later the main model gets its turn back.
    c.advance(61_000);
    expect(pool.order().map((m) => m.name)).toEqual(['main', 'backup']);
  });

  it('says a real error from the main model at once, without trying the backup', async () => {
    const pool = new ModelPool([
      { name: 'main', model: 'main' },
      { name: 'backup', model: 'backup' },
    ]);
    const calls: string[] = [];
    await expect(
      pool.run(async (m) => {
        calls.push(m.model);
        throw bad();
      }, fast),
    ).rejects.toThrow('[400]');
    expect(calls).toEqual(['main']);
  });

  it('skips a broken backup and reports the main model being busy, with every try counted for the ledger', async () => {
    const pool = new ModelPool([
      { name: 'main', model: 'main' },
      { name: 'backup', model: 'backup' },
    ]);
    const err = await pool
      .run(async (m) => {
        throw m.model === 'main' ? busy() : missing();
      }, fast)
      .catch((e) => e);
    expect(err.message).toMatch(/high demand/);
    expect(err.tries).toBe(3); // two on the main model, one on the broken backup
  });

  it('gives the last model the remaining retries when every model is busy, within one time budget', async () => {
    const c = clock();
    const pool = new ModelPool(
      [
        { name: 'main', model: 'main' },
        { name: 'backup', model: 'backup' },
      ],
      { now: c.now },
    );
    let tries = 0;
    const err = await pool
      .run(
        async () => {
          tries++;
          throw busy();
        },
        { ...fast, retries: 4 },
      )
      .catch((e) => e);
    expect(tries).toBe(2 + 5);
    expect(err.tries).toBe(7);

    // With the time budget spent, no backup is tried at all.
    tries = 0;
    const budgeted = new ModelPool(
      [
        { name: 'main', model: 'main' },
        { name: 'backup', model: 'backup' },
      ],
      { now: c.now },
    );
    await budgeted
      .run(
        async () => {
          tries++;
          c.advance(50_000); // a try that hangs until its deadline
          throw busy();
        },
        { ...fast, budgetMs: 45_000, now: c.now },
      )
      .catch(() => undefined);
    expect(tries).toBe(1);
  });

  it('leaves the backup its time when the main model is slow rather than failing', async () => {
    // Overloaded, Gemini often answers late instead of fast with an error: two slow tries spent the budget (17-nov).
    const c = clock();
    const pool = new ModelPool(
      [
        { name: 'main', model: 'main' },
        { name: 'backup', model: 'backup' },
      ],
      { now: c.now },
    );
    const seen: { model: string; ms: number }[] = [];
    const r = await pool.run(
      async (m, remainingMs) => {
        seen.push({ model: m.model, ms: Math.round(remainingMs) });
        if (m.model === 'main') {
          c.advance(remainingMs); // hangs until its deadline
          throw new ModelTimeout('cloud', remainingMs);
        }
        return 'ok';
      },
      { ...fast, budgetMs: 45_000, now: c.now },
    );
    expect(r.model).toBe('backup');
    expect(seen).toEqual([
      { model: 'main', ms: 20_000 }, // one try is capped at 20 s
      { model: 'main', ms: 10_000 }, // the second only gets what is left of its 30 s
      { model: 'backup', ms: 15_000 }, // the backup keeps its reserve
    ]);
  });

  it('stops when the caller cancels', async () => {
    const pool = new ModelPool([
      { name: 'main', model: 'main' },
      { name: 'backup', model: 'backup' },
    ]);
    const ctrl = new AbortController();
    const calls: string[] = [];
    await expect(
      pool.run(
        async (m) => {
          calls.push(m.model);
          ctrl.abort();
          throw busy();
        },
        { ...fast, signal: ctrl.signal },
      ),
    ).rejects.toThrow();
    expect(calls).toEqual(['main']);
  });
});

describe('a Gemini Nano failure', () => {
  it('is the device’s, never "the cloud is busy", whatever its message says', async () => {
    const backend: ModelBackend = {
      name: 'nano',
      generate: async () => {
        throw new Error('Network error while loading the on-device model.');
      },
    };
    const err = await new LocalModel(backend, new Ledger()).generate(['Find details'], { op: 'Find identifying details' }).catch((e) => e);
    expect(isDeviceError(err)).toBe(true);
    expect(isTemporary(err)).toBe(false);
  });
});

describe('the cloud model and a busy backend', () => {
  it('writes in the ledger which backup answered, and tells the UI while it waits', async () => {
    const ledger = new Ledger();
    let entries: LedgerEntry[] = [];
    ledger.subscribe((e) => (entries = e));
    const backend: ModelBackend = {
      name: 'main (cloud)',
      generate: async (_parts, opts) => {
        opts.onBusy?.({ kind: 'switch', from: 'main', to: 'backup' });
        return { text: '{"pick":"A"}', source: 'in_cloud', tries: 3, model: 'backup', backup: true };
      },
    };
    const cloud = new CloudModel(backend, ledger);
    const seen: BusyEvent[] = [];
    const off = cloud.onBusy((e) => seen.push(e));
    await cloud.generate(['Who wrote this?', publicData('A public text.', 'test')], { op: 'Attack attempt 1 of 10' });
    off();
    await cloud.generate(['Who wrote this?', publicData('A public text.', 'test')], { op: 'Attack attempt 2 of 10' });
    expect(seen).toEqual([{ kind: 'switch', from: 'main', to: 'backup' }]); // one listener, removed after the first call
    const entry = entries.find((e) => e.op === 'Attack attempt 1 of 10')!;
    expect(entry.note).toMatch(/answered by backup, the backup model \(main model busy\)/);
    expect(entry.note).toMatch(/sent 3 times \(model busy\)/);
  });
});
