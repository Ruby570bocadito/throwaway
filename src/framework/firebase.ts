// Firebase AI Logic backends. The local side is ONLY_ON_DEVICE (Gemini Nano in Chrome): if there is no local model,
// it throws instead of silently falling back to the cloud with private data. The cloud side is ONLY_IN_CLOUD.

import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { CustomProvider, initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type GenerateContentRequest, type GenerativeModel, type Part } from 'firebase/ai';
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
  /** Per call, on the device (default 5 min: a laptop took 25–60 s for a rewrite, longer on first load). Not retried. */
  localTimeoutMs?: number;
}

/**
 * Cloud: within 45 s in all, so a hung or overloaded cloud ends in an error the UI can show instead of a spinner (the SDK
 * would wait 180 s per try, and its timer stops once headers arrive). A busy model gets two tries, then the call moves on
 * to the next model, and the last one gets up to five. The device is never retried.
 */
const CLOUD_RETRY: RetryOptions = { retries: 4, baseMs: 1000, maxDelayMs: 8000, budgetMs: 45_000, maxRetryAfterMs: 20_000 };
const LOCAL_RETRY: RetryOptions = { retries: 0 };

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
  /** On-device structured output is fixed per model instance (Chrome responseConstraint), so keep one per schema. */
  private makeWithSchema?: (schema: JsonSchema) => GenerativeModel;
  private bySchema = new Map<string, GenerativeModel>();
  private where: 'cloud' | 'device';
  private timeoutMs: number;
  private retry: RetryOptions;
  constructor(
    name: string,
    models: PoolModel<GenerativeModel>[],
    o: { where: 'cloud' | 'device'; timeoutMs: number; retry: RetryOptions; makeWithSchema?: (schema: JsonSchema) => GenerativeModel },
  ) {
    this.name = name;
    this.pool = new ModelPool(models);
    this.where = o.where;
    this.timeoutMs = o.timeoutMs;
    this.retry = o.retry;
    this.makeWithSchema = o.makeWithSchema;
  }
  private modelFor(model: GenerativeModel, opts: GenerateOptions): GenerativeModel {
    if (!opts.schema || !this.makeWithSchema) return model;
    const key = JSON.stringify(opts.schema);
    let m = this.bySchema.get(key);
    if (!m) {
      m = this.makeWithSchema(opts.schema);
      this.bySchema.set(key, m);
    }
    return m;
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
        const gm = this.modelFor(m.model, opts);
        return withTimeout((signal) => gm.generateContent(request, { signal }), ms, () => new ModelTimeout(this.where, ms), opts.signal);
      },
      { ...this.retry, signal: opts.signal, onBusy: opts.onBusy },
    );
    const backup = model !== this.pool.models[0].name;
    return {
      text: res.response.text(),
      source: res.response.inferenceSource === 'on_device' ? 'on_device' : 'in_cloud',
      tries,
      ...(backup ? { model, backup } : {}),
    };
  }
  /** On-device models must be initialised from a user gesture. */
  async prepare(onProgress?: (p: number) => void) {
    await this.pool.models[0].model.initializeDeviceModel(onProgress);
  }
}

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
  const local = new AILogicBackend(
    'Gemini Nano (on-device)',
    [{ name: 'gemini-nano', model: getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE, inCloudParams: { model: cfg.cloudModel } }) }],
    {
      where: 'device',
      timeoutMs: cfg.localTimeoutMs ?? 300_000,
      retry: LOCAL_RETRY,
      makeWithSchema: (schema) =>
        getGenerativeModel(ai, {
          mode: InferenceMode.ONLY_ON_DEVICE,
          inCloudParams: { model: cfg.cloudModel },
          onDeviceParams: { promptOptions: { responseConstraint: schema } },
        }),
    },
  );
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
