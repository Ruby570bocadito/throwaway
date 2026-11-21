// Firebase AI Logic backends. The local side is ONLY_ON_DEVICE (Gemini Nano in Chrome): if there is no local model,
// it throws instead of silently falling back to the cloud with private data. The cloud side is ONLY_IN_CLOUD.

import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { CustomProvider, initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import {
  getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type GenerateContentRequest, type GenerativeModel, type LanguageModelCreateOptions, type Part,
} from 'firebase/ai';
import type { GenerateOptions, ModelBackend, ModelResult, ResolvedPart } from './models';
import type { JsonSchema } from './json';
import { ModelPool, type PoolModel } from './fallback';
import { ModelTimeout, withTimeout, type RetryOptions } from './retry';

export interface FirebaseHybridConfig {
  firebase: FirebaseOptions;
  cloudModel: string;
  /**
   * Cloud models to move on to, in order, while the main one is busy (Gemini answers "high demand" for minutes at a
   * time). The attacker is then another Gemini model; the ledger says which one answered.
   */
  cloudFallbackModels?: string[];
  recaptchaSiteKey?: string;
  debugAppCheck?: boolean;
  /** Per try, for the cloud (default 30 s; Flash-Lite answers in ~1 s). The SDK's own default is 180 s. */
  cloudTimeoutMs?: number;
  /**
   * Per call, on the device (default 2 min). A laptop took 25–60 s for a whole rewrite; now a post goes part by part, a
   * few seconds each. Five minutes left a hung call (one did hang, on the photo bench, 21-nov) on a spinner. Not retried.
   */
  localTimeoutMs?: number;
}

/**
 * Cloud: within 45 s in all, so a hung or overloaded cloud ends in an error the UI can show instead of a spinner (the SDK
 * would wait 180 s per try, and its timer stops once headers arrive). A busy model gets two tries, then the call moves on
 * to the next model, and the last one gets up to five. The device is never retried.
 */
const CLOUD_RETRY: RetryOptions = { retries: 4, baseMs: 1000, maxDelayMs: 8000, budgetMs: 45_000, maxRetryAfterMs: 20_000 };
const LOCAL_RETRY: RetryOptions = { retries: 0 };

/**
 * What a session on the device says it will read: text alone for a post, text and an image for a photo. The SDK's default
 * asks for image input in every session (21-nov review), so a Chrome that reads text but not images could not rewrite a
 * post. English, as the SDK's default; the prompts ask for answers in the language of the post.
 */
const deviceIO = (image: boolean): LanguageModelCreateOptions => ({
  expectedInputs: image ? [{ type: 'text', languages: ['en'] }, { type: 'image' }] : [{ type: 'text', languages: ['en'] }],
  expectedOutputs: [{ type: 'text', languages: ['en'] }],
});
type DeviceModelKind = { image: boolean; schema?: JsonSchema };

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

const toParts = (parts: ResolvedPart[]): Part[] =>
  parts.map((p) => ('text' in p ? { text: p.text } : { inlineData: { data: toBase64(p.image), mimeType: p.mime } }));

class AILogicBackend implements ModelBackend {
  readonly name: string;
  /** One model on the device; in the cloud, the main model and its backups, in order. */
  private pool: ModelPool<GenerativeModel>;
  /**
   * On the device, Chrome fixes what a session reads (text, or text and an image) and its structured output
   * (responseConstraint) when the session is created: one model instance for each, made when first needed.
   */
  private makeOnDevice?: (kind: DeviceModelKind) => GenerativeModel;
  private onDevice = new Map<string, GenerativeModel>();
  private where: 'cloud' | 'device';
  private timeoutMs: number;
  private retry: RetryOptions;
  constructor(
    name: string,
    models: PoolModel<GenerativeModel>[],
    o: { where: 'cloud' | 'device'; timeoutMs: number; retry: RetryOptions; makeOnDevice?: (kind: DeviceModelKind) => GenerativeModel },
  ) {
    this.name = name;
    this.pool = new ModelPool(models);
    this.where = o.where;
    this.timeoutMs = o.timeoutMs;
    this.retry = o.retry;
    this.makeOnDevice = o.makeOnDevice;
    // The pool's own model is the text-only one without a schema.
    if (o.makeOnDevice) this.onDevice.set(keyOf({ image: false }), models[0].model);
  }
  private deviceModel(kind: DeviceModelKind): GenerativeModel {
    const key = keyOf(kind);
    let m = this.onDevice.get(key);
    if (!m) {
      m = this.makeOnDevice!(kind);
      this.onDevice.set(key, m);
    }
    return m;
  }
  private modelFor(model: GenerativeModel, parts: ResolvedPart[], opts: GenerateOptions): GenerativeModel {
    if (!this.makeOnDevice) return model;
    return this.deviceModel({ image: parts.some((p) => 'image' in p), schema: opts.schema });
  }
  async generate(parts: ResolvedPart[], opts: GenerateOptions): Promise<ModelResult> {
    // In the cloud, structured output goes in generationConfig. On-device, the SDK ignores generationConfig and uses
    // the promptOptions given at creation (see modelFor).
    const generationConfig = opts.schema
      ? { responseMimeType: 'application/json', responseJsonSchema: opts.schema }
      : opts.json
        ? { responseMimeType: 'application/json' }
        : undefined;
    const request: GenerateContentRequest = { contents: [{ role: 'user', parts: toParts(parts) }], generationConfig };
    // Free-tier limits are low: retry temporary errors with exponential backoff and jitter, as the hackathon FAQ suggests,
    // honouring the server's RetryInfo, and move on to a backup model while the main one is busy. Measured live
    // (16-nov): Gemini also answers [500] "This model is currently experiencing high demand". Each try has a deadline;
    // its signal also cancels a response body that stalls.
    const { value: res, tries, model } = await this.pool.run(
      (m, remaining) => {
        const ms = Math.max(1000, Math.min(this.timeoutMs, remaining));
        const gm = this.modelFor(m.model, parts, opts);
        return withTimeout(
          async (signal) => {
            const r = await gm.generateContent(request, { signal });
            // Read inside the try: a blocked answer then reaches the backup model, as a busy one does (21-nov review).
            return { text: r.response.text(), source: r.response.inferenceSource };
          },
          ms,
          () => new ModelTimeout(this.where, ms),
          opts.signal,
        );
      },
      { ...this.retry, signal: opts.signal, onBusy: opts.onBusy },
    );
    const backup = model !== this.pool.models[0].name;
    return {
      text: res.text,
      source: res.source === 'on_device' ? 'on_device' : 'in_cloud',
      tries,
      ...(backup ? { model, backup } : {}),
    };
  }
  /** On-device models must be initialised from a user gesture: the text one, or the one that also reads images. */
  async prepare(onProgress?: (p: number) => void, o: { image?: boolean } = {}) {
    const m = this.makeOnDevice ? this.deviceModel({ image: !!o.image }) : this.pool.models[0].model;
    await m.initializeDeviceModel(onProgress);
  }
}

const keyOf = (kind: DeviceModelKind) => `${kind.image ? 'image' : 'text'} ${kind.schema ? JSON.stringify(kind.schema) : ''}`;

let app: FirebaseApp | null = null;

export function firebaseHybrid(cfg: FirebaseHybridConfig) {
  const first = !app;
  app ??= initializeApp(cfg.firebase);
  if (first) {
    // App Check is enforced for Firebase AI Logic. In local development the debug provider is used: the SDK prints a debug
    // token in the browser console, the developer registers it in the Firebase console. It never goes into a file.
    if (cfg.debugAppCheck) (self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN: boolean }).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    const provider = cfg.recaptchaSiteKey
      ? new ReCaptchaEnterpriseProvider(cfg.recaptchaSiteKey)
      : new CustomProvider({
          // Only reached outside debug mode with no production provider configured.
          getToken: () => Promise.reject(new Error('No App Check provider: set VITE_RECAPTCHA_SITE_KEY (production) or run in dev mode with a debug token.')),
        });
    initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled: true });
  }
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  const onDevice = ({ image, schema }: DeviceModelKind) =>
    getGenerativeModel(ai, {
      mode: InferenceMode.ONLY_ON_DEVICE,
      inCloudParams: { model: cfg.cloudModel },
      onDeviceParams: { createOptions: deviceIO(image), ...(schema ? { promptOptions: { responseConstraint: schema } } : {}) },
    });
  const local = new AILogicBackend('Gemini Nano (on-device)', [{ name: 'gemini-nano', model: onDevice({ image: false }) }], {
    where: 'device',
    timeoutMs: cfg.localTimeoutMs ?? 120_000,
    retry: LOCAL_RETRY,
    makeOnDevice: onDevice,
  });
  const cloudModels = [cfg.cloudModel, ...(cfg.cloudFallbackModels ?? []).filter((m) => m && m !== cfg.cloudModel)];
  const cloud = new AILogicBackend(
    `${cfg.cloudModel} (cloud)`,
    cloudModels.map((name) => ({ name, model: getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams: { model: name } }) })),
    { where: 'cloud', timeoutMs: cfg.cloudTimeoutMs ?? 30_000, retry: CLOUD_RETRY },
  );
  return { local, cloud };
}

// Kept next to the Firebase code for older imports; it lives in ./device so the demo never loads Firebase.
export { deviceModelStatus } from './device';
