// Builds the framework kit for the app: real Firebase AI Logic when configured, recorded responses otherwise.

import { CloudModel, Ledger, LocalModel, publicData, type ModelBackend } from './framework';
import type { FirebaseHybridConfig } from './framework/firebase';
import { demoBackends } from './demo/recorded';
import { DECOYS, MARTA_PUBLIC, SELF_ID } from './demo/scenario';
import type { DecoyPackId } from './demo/fields';
import type { Candidate } from './engine/stylometry';
import { authorshipThreat } from './threats/authorship';

const env = import.meta.env;

export const isConfigured = () => Boolean(env.VITE_FIREBASE_API_KEY && env.VITE_FIREBASE_PROJECT_ID && env.VITE_FIREBASE_APP_ID);
/** `?demo` replays recorded model answers: for anyone without Gemini Nano in Chrome, and for the demo video. */
export const demoRequested = () => typeof location !== 'undefined' && new URLSearchParams(location.search).has('demo');
export const isLive = () => isConfigured() && !demoRequested();

export function buildKit(ledger: Ledger) {
  const live = isLive();
  const backends = live
    ? lazyFirebase({
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

/**
 * The authorship threat. `ownPublic` is writing the user has already published under their name: with it, the fingerprint
 * and the lineup compare the anonymous post with the user, not with the demo persona. It is public by definition, so it may
 * go to the attacker as one of the ten candidates (and the guard still blocks it if it carries the private draft).
 *
 * `decoys` are the nine public writers who stand next to the user: by default the recorded run's (design), or a pack of
 * the post's own field from `loadDecoyPacks()`. With off-topic decoys the attacker finds the author by subject, not style.
 */
export function buildAuthorship(onAttempt: (pickId: string, i: number) => void, ownPublic = '', decoys: readonly Candidate[] = DECOYS) {
  const own = ownPublic.trim();
  return authorshipThreat({
    selfId: SELF_ID,
    self: own ? publicData(own, 'your public writing') : publicData(MARTA_PUBLIC, 'your public blog'),
    decoys: decoys.map((d) => ({ id: d.id, text: publicData(d.corpus, 'public decoy') })),
    onAttempt,
  });
}

/**
 * The decoy packs of every field and the local chooser (about 35 KB of text): loaded only when the user's own post needs
 * a lineup, so the recorded demo and the first paint never download them. Choosing runs in plain JS on the device.
 */
export const loadDecoyPacks = () => import('./demo/decoys');
export type DecoyPacks = Awaited<ReturnType<typeof loadDecoyPacks>>;

/**
 * The field of the nine decoys: the field of the writing that stands for the user in the lineup, so that all ten write
 * about one subject and only style can single the user out. The post's field does not decide it. Decoys off the user's
 * subject let the attacker find the user by subject (3/9 times in the live run on 15-nov); decoys on the post's subject
 * next to writing of the user's that is not would hide the user the same way, and the attack would look safe. Until the
 * user adds their own public writing, the sample writer (a designer) stands in for them, and so do the designers.
 *
 * `matched` is the field found in the user's writing, `clear` says whether one stood out (with none, the designers stay),
 * `wanted` is the user's pick or the match, and `field` is the lineup in use: the designers until the packs have loaded.
 */
export function lineupField(ownPublic: string, packs: DecoyPacks | null, choice: DecoyPackId | 'auto' = 'auto') {
  const own = ownPublic.trim();
  const found = own && packs ? packs.choosePack(own) : null;
  const matched: DecoyPackId = found?.id ?? 'design';
  // choosePack falls back to design when no field has two of its own words in the text.
  const clear = !found || found.id !== 'design' || found.matched.length >= 2;
  const wanted: DecoyPackId = !own ? 'design' : choice === 'auto' ? matched : choice;
  const field: DecoyPackId = packs ? wanted : 'design';
  return { matched, clear, wanted, field };
}

type Hybrid = ReturnType<typeof import('./framework/firebase').firebaseHybrid>;

/**
 * Live backends that load the Firebase SDK on demand: the recorded demo (what most visitors open) never downloads it,
 * and live mode starts loading it right after the first paint, so App Check has a token before the first click.
 */
function lazyFirebase(cfg: FirebaseHybridConfig) {
  let loaded: Promise<Hybrid> | null = null;
  const load = () =>
    (loaded ??= import('./framework/firebase')
      .then((m) => m.firebaseHybrid(cfg))
      .catch((e) => {
        loaded = null; // let the next call retry
        throw e;
      }));
  setTimeout(() => void load().catch(() => undefined), 0);
  const local: ModelBackend & { prepare: (onProgress?: (p: number) => void) => Promise<void> } = {
    name: 'Gemini Nano (on-device)',
    generate: async (parts, opts) => (await load()).local.generate(parts, opts),
    prepare: async (onProgress) => (await load()).local.prepare(onProgress),
  };
  const cloud: ModelBackend = {
    name: `${cfg.cloudModel} (cloud)`,
    generate: async (parts, opts) => (await load()).cloud.generate(parts, opts),
  };
  return { local, cloud };
}
