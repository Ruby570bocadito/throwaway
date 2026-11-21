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

  it('say what to do for each error Chrome’s Prompt API names, on the error or on the one the SDK wrapped', () => {
    const chrome = (name: string) => markDeviceError(new DOMException('The operation failed.', name));
    const wrapped = (name: string) => markDeviceError(Object.assign(new Error('Error in on-device inference.'), { cause: new DOMException('x', name) }));
    expect(friendlyError(chrome('QuotaExceededError'))).toMatch(/^This is too long for Gemini Nano on this device\. Shorten it/);
    expect(friendlyError(wrapped('QuotaExceededError'))).toMatch(/^This is too long for Gemini Nano/);
    expect(friendlyError(chrome('NotAllowedError'))).toMatch(/^Chrome did not let Gemini Nano start/);
    expect(friendlyError(chrome('NotSupportedError'))).toMatch(/cannot read this input/);
    expect(friendlyError(chrome('InvalidStateError'))).toMatch(/not ready yet/);
    expect(friendlyError(wrapped('NetworkError'))).toMatch(/download stopped/);
    // Any other name keeps the general message, with Chrome's own words in it.
    expect(friendlyError(chrome('UnknownError'))).toMatch(/^Gemini Nano could not finish this step on your device: The operation failed\./);
    // The SDK's "this model cannot run in this Chrome" (a photo where Chrome reads text but not images).
    const notHere = markDeviceError(Object.assign(new Error('AI: Local LanguageModel API not available in this environment. (AI/api-not-enabled)'), { code: 'api-not-enabled' }));
    expect(friendlyError(notHere)).toMatch(/^Gemini Nano cannot do this step in this Chrome\. Turn on “Try it without Gemini Nano”/);
  });

  it('say a cloud answer was withheld by a safety filter, not “try again”', () => {
    const e = Object.assign(new Error('AI: Response error: Candidate was blocked due to SAFETY. (AI/response-error)'), { code: 'response-error' });
    expect(friendlyError(e)).toMatch(/^Google’s AI would not read this version: its safety filter stopped it/);
  });

  it('send a refused App Check to the blocker, not to "wait a minute"', () => {
    const e = Object.assign(new Error('AppCheck: ReCAPTCHA error. (appCheck/recaptcha-error).'), { code: 'appCheck/recaptcha-error' });
    expect(friendlyError(e)).toMatch(/App Check.*allow reCAPTCHA on this site/);
  });
});

describe('a message the app wrote for people', () => {
  it('is shown as it is', () => {
    const e = Object.assign(new Error('Your edit still keeps this passage of your original: “I loved this company”. Change it a little more, then try again.'), {
      name: 'UserFacingError',
    });
    expect(friendlyError(e)).toBe(e.message);
  });
});
