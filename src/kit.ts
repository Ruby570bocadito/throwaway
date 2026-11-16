// Builds the framework kit for the app: real Firebase AI Logic when configured, recorded responses otherwise.

import { CloudModel, Ledger, LocalModel, publicData } from './framework';
import { firebaseHybrid } from './framework/firebase';
import { demoBackends } from './demo/recorded';
import { DECOYS, MARTA_PUBLIC, SELF_ID } from './demo/scenario';
import { authorshipThreat } from './threats/authorship';

const env = import.meta.env;

export const isConfigured = () => Boolean(env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_APP_ID);
/** `?demo` replays recorded model answers: for anyone without Gemini Nano in Chrome, and for the demo video. */
export const demoRequested = () => typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo');
export const isLive = () => isConfigured() && !demoRequested();

export function buildKit(ledger: Ledger) {
  const live = isLive();
  const backends = live
    ? firebaseHybrid({
        firebase: {
          apiKey: env.VITE_FIREBASE_API_KEY,
          authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
          projectId: env.VITE_FIREBASE_PROJECT_ID,
          appId: env.VITE_FIREBASE_APP_ID,
        },
        // Measured 16-nov-2026 on the free tier: gemini-3.5-flash-lite answers in ~1 s and found the author 9/9 times before
        // rewriting; gemini-3.8-flash took 40–60 s per call (too slow for a 10-attempt lineup). Override with VITE_ATTACKER_MODEL.
        cloudModel: env.VITE_ATTACKER_MODEL || 'gemini-3.5-flash-lite',
        recaptchaSiteKey: env.VITE_RECAPTCHA_SITE_KEY,
        debugAppCheck: env.DEV,
      })
    : demoBackends();
  return { live, kit: { local: new LocalModel(backends.local, ledger), cloud: new CloudModel(backends.cloud, ledger), ledger }, backends };
}

export function buildAuthorship(onAttempt: (pickId: string, i: number) => void) {
  return authorshipThreat({
    selfId: SELF_ID,
    self: publicData(MARTA_PUBLIC, 'your public blog'),
    decoys: DECOYS.map((d) => ({ id: d.id, text: publicData(d.corpus, 'public decoy') })),
    onAttempt,
  });
}
