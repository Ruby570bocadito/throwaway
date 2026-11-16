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
