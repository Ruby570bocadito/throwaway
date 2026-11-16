// Firebase AI Logic backends. The local side is ONLY_ON_DEVICE (Gemini Nano in Chrome): if there is no local model,
// it throws instead of silently falling back to the cloud with private data. The cloud side is ONLY_IN_CLOUD.

import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import { CustomProvider, initializeAppCheck, ReCaptchaEnterpriseProvider } from 'firebase/app-check';
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type GenerativeModel, type Part } from 'firebase/ai';
import type { GenerateOptions, ModelBackend, ModelResult, ResolvedPart } from './models';
import type { JsonSchema } from './json';
import { isTemporary } from './retry';

export interface FirebaseHybridConfig {
  firebase: FirebaseOptions;
  cloudModel: string;
  recaptchaSiteKey?: string;
  debugAppCheck?: boolean;
}

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

const toParts = (parts: ResolvedPart[]): Part[] =>
  parts.map((p) => ('text' in p ? { text: p.text } : { inlineData: { data: toBase64(p.image), mimeType: p.mime } }));

class AILogicBackend implements ModelBackend {
  readonly name: string;
  private model: GenerativeModel;
  /** On-device structured output is fixed per model instance (Chrome responseConstraint), so keep one per schema. */
  private makeWithSchema?: (schema: JsonSchema) => GenerativeModel;
  private bySchema = new Map<string, GenerativeModel>();
  constructor(name: string, model: GenerativeModel, makeWithSchema?: (schema: JsonSchema) => GenerativeModel) {
    this.name = name;
    this.model = model;
    this.makeWithSchema = makeWithSchema;
  }
  private modelFor(opts: GenerateOptions): GenerativeModel {
    if (!opts.schema || !this.makeWithSchema) return this.model;
    const key = JSON.stringify(opts.schema);
    let m = this.bySchema.get(key);
    if (!m) {
      m = this.makeWithSchema(opts.schema);
      this.bySchema.set(key, m);
    }
    return m;
  }
  async generate(parts: ResolvedPart[], opts: GenerateOptions): Promise<ModelResult> {
    const model = this.modelFor(opts);
    // In the cloud, structured output goes in generationConfig. On-device, the SDK ignores generationConfig and uses
    // the promptOptions given at creation (see modelFor).
    const generationConfig = opts.schema
      ? { responseMimeType: 'application/json', responseJsonSchema: opts.schema }
      : opts.json
        ? { responseMimeType: 'application/json' }
        : undefined;
    // Free-tier limits are low: retry temporary errors with exponential backoff and jitter, as the hackathon FAQ suggests.
    // Measured live (16-nov): Gemini also answers [500] "This model is currently experiencing high demand".
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await model.generateContent({
          contents: [{ role: 'user', parts: toParts(parts) }],
          generationConfig,
        });
        return { text: res.response.text(), source: res.response.inferenceSource === 'on_device' ? 'on_device' : 'in_cloud' };
      } catch (e) {
        if (!isTemporary(e) || attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 1200 * 2 ** attempt + Math.random() * 400));
      }
    }
  }
  /** On-device models must be initialised from a user gesture. */
  async prepare(onProgress?: (p: number) => void) {
    await this.model.initializeDeviceModel(onProgress);
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
    getGenerativeModel(ai, { mode: InferenceMode.ONLY_ON_DEVICE, inCloudParams: { model: cfg.cloudModel } }),
    (schema) =>
      getGenerativeModel(ai, {
        mode: InferenceMode.ONLY_ON_DEVICE,
        inCloudParams: { model: cfg.cloudModel },
        onDeviceParams: { promptOptions: { responseConstraint: schema } },
      }),
  );
  const cloud = new AILogicBackend(
    `${cfg.cloudModel} (cloud)`,
    getGenerativeModel(ai, { mode: InferenceMode.ONLY_IN_CLOUD, inCloudParams: { model: cfg.cloudModel } }),
  );
  return { local, cloud };
}

// Kept next to the Firebase code for older imports; it lives in ./device so the demo never loads Firebase.
export { deviceModelStatus } from './device';
