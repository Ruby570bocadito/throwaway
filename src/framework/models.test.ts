import { beforeEach, describe, expect, it } from 'vitest';
import { clearTaint, CloudModel, Ledger, LocalModel, ModelTimeout, release, secret, type ModelBackend } from './index';

beforeEach(() => clearTaint());

describe('the ledger counts every byte that may have left', () => {
  const prompt = 'Which writer wrote this?'; // 24 bytes

  it('a call that was retried sent its bytes once per try', async () => {
    const ledger = new Ledger();
    const busyTwice: ModelBackend = { name: 'cloud', generate: async () => ({ text: '{}', source: 'in_cloud', tries: 3 }) };
    await new CloudModel(busyTwice, ledger).generate([prompt], { op: 'Attack' });
    expect(ledger.all[0]).toMatchObject({ route: 'cloud', bytesOut: 72, note: 'sent 3 times (model busy)' });
  });

  it('a call that failed is in the ledger too, with what it sent', async () => {
    const ledger = new Ledger();
    const down: ModelBackend = {
      name: 'cloud',
      generate: async () => {
        throw Object.assign(new Error('[503] UNAVAILABLE'), { tries: 5 });
      },
    };
    await expect(new CloudModel(down, ledger).generate([prompt], { op: 'Attack' })).rejects.toThrow(/UNAVAILABLE/);
    expect(ledger.all[0]).toMatchObject({ op: 'Attack', route: 'cloud', bytesOut: 120, note: 'no answer (model busy)' });

    const hung: ModelBackend = { name: 'cloud', generate: async () => Promise.reject(new ModelTimeout('cloud', 30_000)) };
    await expect(new CloudModel(hung, ledger).generate([release('A post.', 'p', {})], { op: 'Attack' })).rejects.toBeInstanceOf(ModelTimeout);
    expect(ledger.all[0].note).toBe('no answer (timed out after 30 s)');
  });

  it('a stuck local model is in the ledger, still with 0 bytes out', async () => {
    const ledger = new Ledger();
    const stuck: ModelBackend = { name: 'nano', generate: async () => Promise.reject(new ModelTimeout('device', 300_000)) };
    await expect(new LocalModel(stuck, ledger).generate([secret('my draft')], { op: 'Rewrite on-device' })).rejects.toBeInstanceOf(ModelTimeout);
    expect(ledger.all[0]).toMatchObject({ route: 'on-device', bytesOut: 0, note: 'no answer (timed out after 300 s)' });
  });
});

describe('Gemini Nano runs one call at a time', () => {
  const slowNano = () => {
    let running = 0;
    let most = 0;
    const order: string[] = [];
    const backend: ModelBackend = {
      name: 'nano',
      generate: async (_parts, opts) => {
        running++;
        most = Math.max(most, running);
        order.push(`start ${opts.op}`);
        await new Promise((r) => setTimeout(r, 5));
        running--;
        order.push(`end ${opts.op}`);
        if (opts.op === 'fails') throw new Error('The model crashed.');
        return { text: 'ok', source: 'on_device' };
      },
    };
    return { backend, order, most: () => most };
  };

  it('a second call waits for the first, in order, even when the first fails', async () => {
    const nano = slowNano();
    const local = new LocalModel(nano.backend, new Ledger());
    const calls = [local.generate(['a'], { op: 'fails' }), local.generate(['b'], { op: 'second' }), local.generate(['c'], { op: 'third' })];
    const settled = await Promise.allSettled(calls);
    expect(settled.map((s) => s.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(nano.most()).toBe(1);
    expect(nano.order).toEqual(['start fails', 'end fails', 'start second', 'end second', 'start third', 'end third']);
  });

  it('says when it is busy and when it is idle again, and whether the last call failed', async () => {
    const local = new LocalModel(slowNano().backend, new Ledger());
    const seen: string[] = [];
    const off = local.onActivity((busy, failed) => seen.push(busy ? 'busy' : failed ? 'idle after a failure' : 'idle'));
    const one = local.generate(['a'], { op: 'one' });
    const two = local.generate(['b'], { op: 'two' });
    expect(local.busy).toBe(true);
    await Promise.all([one, two]);
    await local.generate(['c'], { op: 'fails' }).catch(() => undefined);
    off();
    await local.generate(['d'], { op: 'unheard' });
    expect(seen).toEqual(['busy', 'idle', 'busy', 'idle after a failure']);
    expect(local.busy).toBe(false);
  });

  it('a call cancelled while it waited never reaches the device', async () => {
    const nano = slowNano();
    const local = new LocalModel(nano.backend, new Ledger());
    const stop = new AbortController();
    const first = local.generate(['a'], { op: 'first' });
    const waiting = local.generate(['b'], { op: 'cancelled', signal: stop.signal });
    stop.abort();
    await first;
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(nano.order).toEqual(['start first', 'end first']);
  });
});
