import { describe, expect, it } from 'vitest';
import { ModelTimeout } from '../framework';
import { markDeviceError } from '../framework/retry';
import { friendlyError } from './shared';

const withStatus = (message: string, status: number) => Object.assign(new Error(message), { status });

describe('error messages for people', () => {
  it('name the cause and quote the code, so a report says which failure it was', () => {
    expect(friendlyError(withStatus('[503] The model is overloaded.', 503))).toMatch(/^Google’s AI is overloaded right now, the backup model too\..*\(Error 503\.\)$/);
    expect(friendlyError(withStatus('[429] Resource has been exhausted.', 429))).toMatch(/limit on requests.*\(Error 429\.\)$/);
    expect(friendlyError(new TypeError('Failed to fetch'))).toMatch(/^This browser could not reach Google’s AI servers/);
    expect(friendlyError(new ModelTimeout('cloud', 30_000))).toMatch(/took too long to answer/);
  });

  it('never blame the cloud for Gemini Nano', () => {
    const msg = friendlyError(markDeviceError(new Error('Network error while loading the on-device model.')));
    expect(msg).toMatch(/^Gemini Nano could not finish this step on your device: Network error while loading the on-device model\./);
    expect(msg).not.toMatch(/Google’s AI/);
    expect(friendlyError(new ModelTimeout('device', 300_000))).toMatch(/^Gemini Nano did not answer within 300 s on this device\. Try again/);
  });

  it('send a refused App Check to the blocker, not to "wait a minute"', () => {
    const e = Object.assign(new Error('AppCheck: ReCAPTCHA error. (appCheck/recaptcha-error).'), { code: 'appCheck/recaptcha-error' });
    expect(friendlyError(e)).toMatch(/App Check.*allow reCAPTCHA on this site/);
  });
});
