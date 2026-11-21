// /app/?diag: what Gemini Nano does in this Chrome, measured. It calls Chrome's Prompt API directly, then runs the app's
// own on-device steps through Firebase AI Logic on the sample post and photo, and writes a report to copy. No step calls a
// cloud model, so it works on a preview channel too (App Check only matters for the cloud).

import { useEffect, useReducer, useRef, useState } from 'react';
import './diagnostics.css';
import { errorCode, Ledger, LocalModel, PrivacyViolation, secret, type LedgerEntry, type ModelBackend } from '../framework';
import { buildAuthorship, buildKit, isLive } from '../kit';
import { DRAFT } from '../demo/scenario';
import { DEMO_TRUTH, SCENE_H, SCENE_SVG, SCENE_W } from '../demo/photo';
import { browserImageOps, svgToPng } from '../engine/image';
import { locationThreat } from '../threats/location';

type Status = 'run' | 'ok' | 'warn' | 'fail' | 'skip';
type SectionId = 'browser' | 'chrome' | 'nano' | 'app';
interface Row {
  id: string;
  section: SectionId;
  label: string;
  status: Status;
  value: string;
  ms?: number;
}
interface Problem {
  step: string;
  name: string;
  message: string;
  cause?: string;
  code?: string;
  ms?: number;
}

// The Prompt API as Chrome ships it, with the older names: Chrome 157 has none of inputQuota, maxTokens,
// measureInputUsage or countPromptTokens (the first report, 21-nov).
interface Session {
  prompt(input: unknown, o?: { signal?: AbortSignal; responseConstraint?: unknown }): Promise<string>;
  measureContextUsage?(input: unknown): Promise<number>;
  measureInputUsage?(input: unknown): Promise<number>;
  countPromptTokens?(input: unknown): Promise<number>;
  contextWindow?: number;
  inputQuota?: number;
  maxTokens?: number;
  destroy(): void;
}
interface PromptApi {
  availability(o?: unknown): Promise<string>;
  create(o?: unknown): Promise<Session>;
  params?(): Promise<Record<string, unknown> | null>;
}
const promptApi = () => (globalThis as unknown as { LanguageModel?: PromptApi }).LanguageModel;

const SECTIONS: { id: SectionId; title: string; note?: string }[] = [
  { id: 'browser', title: 'This browser' },
  { id: 'chrome', title: 'What Chrome says', note: 'LanguageModel.availability() for the inputs each step needs.' },
  { id: 'nano', title: 'Gemini Nano, directly', note: 'Chrome’s Prompt API, without Firebase.' },
  { id: 'app', title: 'The app’s own steps', note: 'Firebase AI Logic, on-device only, on the sample post and photo.' },
];

const TEXT_ONLY = { expectedInputs: [{ type: 'text' }], expectedOutputs: [{ type: 'text' }] };
const TEXT_AND_IMAGE = { expectedInputs: [{ type: 'text' }, { type: 'image' }], expectedOutputs: [{ type: 'text' }] };
const AVAILABILITY: { label: string; options?: unknown; optional?: boolean }[] = [
  { label: 'Text', options: TEXT_ONLY },
  { label: 'Text and image (the app asks this today)', options: TEXT_AND_IMAGE },
  { label: 'English', options: { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] } },
  { label: 'Spanish', options: { expectedInputs: [{ type: 'text', languages: ['es'] }], expectedOutputs: [{ type: 'text', languages: ['es'] }] }, optional: true },
  { label: 'No options', options: undefined, optional: true },
];

const MARK: Record<Status, string> = { run: '…', ok: '✓', warn: '!', fail: '✗', skip: '–' };
const WORD: Record<Status, string> = { run: 'Running', ok: 'Passed', warn: 'Needs a look', fail: 'Failed', skip: 'Skipped' };

const fmtMs = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);
const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
};
const isJson = (s: string) => {
  try {
    JSON.parse(s);
    return true;
  } catch {
    return false;
  }
};
const SAMPLE_WORDS = DRAFT.split(/\s+/);
const wordsOf = (n: number) => Array.from({ length: n }, (_, i) => SAMPLE_WORDS[i % SAMPLE_WORDS.length]).join(' ');
const countWords = (s: string) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const quotaOf = (s: Session) => s.contextWindow ?? s.inputQuota ?? s.maxTokens ?? NaN;
const usageOf = (s: Session, text: string) =>
  s.measureContextUsage
    ? s.measureContextUsage(text)
    : s.measureInputUsage
      ? s.measureInputUsage(text)
      : s.countPromptTokens
        ? s.countPromptTokens(text)
        : Promise.resolve(NaN);
/** What a session has, when none of the names above are there: its numbers, and its methods that measure or count. */
function namesOn(s: object): string {
  const out = new Set<string>();
  for (let o: object | null = s; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const k of Object.getOwnPropertyNames(o)) {
      try {
        const v = (s as Record<string, unknown>)[k];
        if (typeof v === 'number') out.add(`${k} ${v}`);
        else if (typeof v === 'function' && /measure|count|usage|token|context|quota/i.test(k)) out.add(`${k}()`);
      } catch {
        /* a getter that throws */
      }
    }
  }
  return [...out].join(', ') || 'nothing that measures';
}
const tokens = (n: number) => n.toLocaleString('en-US');

// A longer post, with the details and habits of a real one (515 words).
const LONG_POST = `To be fair, I wanted to love this place. I joined the Porto support centre in September 2021 as a team lead, back when we were 14 people on two shifts and the job felt like it mattered. Frankly, the first year was great (free lunch on Fridays, a manager who actually read our tickets, training budgets that existed). At the end of the day, that is why I stayed for four years.

Things changed after the Q2 2023 restructuring. Overnight, the Lisbon and Porto teams were merged under one director, and our headcount went from 14 to 8 while the ticket volume doubled. Frankly, nobody explained the numbers. We were told it was about "synergies", which at the end of the day meant fewer people doing more work for the same pay.

Then came Project Lighthouse, the migration from Zendesk to an in-house tool. To be fair, the idea was good. The execution was not. We had six weeks to move 40,000 open tickets, rewrite 300 macros and retrain everyone, with no extra hours approved. I worked most Saturdays that summer (unpaid, of course), and so did half my team. When the tool went live on 3 July, search did not work for nine days. Customers waited, we apologised, and the dashboard showed green the whole time because the metric only counted tickets we had touched, not tickets we had solved.

Frankly, the worst part was the culture shift. Our old manager left in January 2024 and the new one ran everything through a weekly spreadsheet. If your average handle time went above seven minutes, you got a "coaching session", which at the end of the day was a warning with a nicer name. People stopped writing long, careful answers because careful answers took time. Quality dropped, and then we were blamed for quality dropping.

To be fair, some things are still good. The benefits are above average for Portugal, the office near the river is beautiful, and most colleagues are kind and funny (the Tuesday quiz night is legendary). If you are early in your career, you will learn a lot about tools and customers very quickly.

But I would not recommend it to anyone who wants to stay more than a year or two. Promotions are frozen since the merger, the senior roles all moved to the Lisbon office, and the review cycle is a box-ticking exercise. I asked three times for a path to a specialist role and got three different answers, none of them in writing.

My advice to management, for what it is worth: count solved tickets, not touched ones; stop measuring people by the minute; and talk to the people on the floor before the next big project, not after it fails. At the end of the day, the team will carry almost anything if they understand why.

My advice to candidates: ask how many people left in the last year, ask who decides your targets, and ask to see the tool before you sign. Frankly, if they hesitate on any of those three, you have your answer.`;

/** Fails with a TimeoutError after `ms`, and aborts the signal it hands to the call. 0: no limit of its own. */
function within<T>(ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  if (!ms) return call(ctl.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new DOMException(`No answer within ${ms / 1000} s`, 'TimeoutError');
      ctl.abort(e);
      reject(e);
    }, ms);
  });
  return Promise.race([call(ctl.signal), late]).finally(() => clearTimeout(timer));
}

function describe(e: unknown): Omit<Problem, 'step' | 'ms'> {
  const err = e as { name?: unknown; message?: unknown; cause?: unknown } | null;
  const name = typeof err?.name === 'string' ? err.name : typeof e;
  let message = typeof err?.message === 'string' ? err.message : String(e);
  if (e instanceof PrivacyViolation) message = `${message} Where: ${e.where}.`;
  const c = err?.cause as { name?: unknown; message?: unknown } | undefined;
  const cause = c && typeof c === 'object' ? `${String(c.name ?? 'Error')}: ${clip(String(c.message ?? ''), 200)}` : undefined;
  const code = errorCode(e);
  return { name, message: clip(message, 300), cause, code: code && code !== name ? code : undefined };
}

async function browserName(): Promise<{ browser: string; system: string }> {
  const ua = (navigator as Navigator & { userAgentData?: { platform: string; getHighEntropyValues?: (h: string[]) => Promise<Record<string, unknown>> } }).userAgentData;
  if (ua?.getHighEntropyValues) {
    try {
      const h = await ua.getHighEntropyValues(['fullVersionList', 'platformVersion', 'architecture', 'bitness']);
      const list = (h.fullVersionList as { brand: string; version: string }[] | undefined) ?? [];
      const b = list.find((x) => /Chrome|Edge|Opera|Brave/i.test(x.brand) && !/Chromium/.test(x.brand)) ?? list.find((x) => /Chromium/.test(x.brand));
      return {
        browser: b ? `${b.brand} ${b.version}` : navigator.userAgent,
        system: `${ua.platform} ${String(h.platformVersion ?? '')} · ${String(h.architecture ?? '')} ${h.bitness ? `${String(h.bitness)}-bit` : ''}`.trim(),
      };
    } catch {
      /* the user agent string below */
    }
  }
  return { browser: navigator.userAgent, system: navigator.platform };
}

async function gpuName(): Promise<string> {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<{ info?: Record<string, string> } | null> } }).gpu;
  if (!gpu) return 'WebGPU not exposed';
  const adapter = await within(5000, () => gpu.requestAdapter());
  if (!adapter) return 'no WebGPU adapter';
  const i = adapter.info ?? {};
  return [i.vendor, i.architecture, i.description].filter(Boolean).join(' · ') || 'adapter without details';
}

/** The bundle this page runs (its hash says which deploy it is). */
const bundle = () => document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? 'dev server';

/** The same error from several steps is listed once, with every step it came from. */
function grouped(problems: Problem[]): (Problem & { steps: string[] })[] {
  const out = new Map<string, Problem & { steps: string[] }>();
  for (const p of problems) {
    const key = [p.name, p.code, p.message, p.cause].join('|');
    const g = out.get(key);
    if (g) g.steps.push(p.step);
    else out.set(key, { ...p, steps: [p.step] });
  }
  return [...out.values()];
}
const stepsOf = (steps: string[]) => (steps.length > 3 ? `${steps.slice(0, 3).join(', ')} and ${steps.length - 3} more` : steps.join(', '));

export default function Diagnostics() {
  const rows = useRef(new Map<string, Row>());
  const problems = useRef<Problem[]>([]);
  const ledgerRows = useRef<LedgerEntry[]>([]);
  const answers = useRef<{ op: string; ms: number; chars: number; blank: number }[]>([]);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const [running, setRunning] = useState(false);
  const [ran, setRan] = useState(false);
  const [current, setCurrent] = useState('');
  const [since, setSince] = useState(0);
  const [now, setNow] = useState(0);
  const [copied, setCopied] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const [showReport, setShowReport] = useState(false);

  const put = (row: Row) => {
    rows.current.set(row.id, row);
    redraw();
  };
  const patch = (id: string, p: Partial<Row>) => {
    const r = rows.current.get(id);
    if (r) put({ ...r, ...p });
  };
  const problem = (step: string, e: unknown, ms?: number) => {
    problems.current.push({ step, ...describe(e), ms });
    redraw();
  };

  /** Runs one check: its row shows it running, then what came back, or the error (also listed under Errors). */
  async function step<T>(
    section: SectionId,
    label: string,
    call: (signal: AbortSignal, progress: (text: string) => void) => Promise<T>,
    show: (v: T) => string,
    o: { timeoutMs?: number; judge?: (v: T) => Status; failAs?: Status } = {},
  ): Promise<T | undefined> {
    const id = `${section}:${label}`;
    put({ id, section, label, status: 'run', value: 'running…' });
    setCurrent(label);
    const t0 = performance.now();
    try {
      // Called at once, in the click's task: Chrome only starts a download from a user gesture.
      const v = await within(o.timeoutMs ?? 120_000, (signal) => call(signal, (text) => patch(id, { value: text })));
      put({ id, section, label, status: o.judge ? o.judge(v) : 'ok', value: show(v), ms: performance.now() - t0 });
      return v;
    } catch (e) {
      const ms = performance.now() - t0;
      const d = describe(e);
      put({ id, section, label, status: o.failAs ?? 'fail', value: `${d.name}: ${d.message}`, ms });
      problems.current.push({ step: label, ...d, ms });
      return undefined;
    }
  }

  // On load, no gesture needed: the browser and Chrome's own answers.
  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    const onError = (e: ErrorEvent) => problem('page', e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => problem('page (unhandled)', e.reason);
    addEventListener('error', onError);
    addEventListener('unhandledrejection', onRejection);
    void (async () => {
      const { browser, system } = await browserName();
      const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      put({ id: 'browser:Browser', section: 'browser', label: 'Browser', status: 'ok', value: browser });
      put({ id: 'browser:System', section: 'browser', label: 'System', status: 'ok', value: system });
      put({
        id: 'browser:Hardware',
        section: 'browser',
        label: 'Processor and memory',
        status: 'ok',
        value: `${navigator.hardwareConcurrency} threads · ${mem ? `${mem} GB or more` : 'memory not reported'}`,
      });
      await step('browser', 'Graphics', () => gpuName(), (v) => v, { timeoutMs: 6000, failAs: 'warn' });
      const api = promptApi();
      put({
        id: 'browser:Prompt API',
        section: 'browser',
        label: 'Prompt API',
        status: api ? 'ok' : 'fail',
        value: api ? 'LanguageModel is here' : 'ai' in globalThis ? 'only the old window.ai: update Chrome' : 'no LanguageModel in this browser',
      });
      put({ id: 'browser:Page', section: 'browser', label: 'Page', status: 'ok', value: `${location.host} · ${bundle()} · ${navigator.onLine ? 'online' : 'offline'}` });
      if (!api) return;
      for (const a of AVAILABILITY) {
        await step(
          'chrome',
          a.label,
          () => api.availability(a.options),
          (s) => s,
          { timeoutMs: 30_000, judge: (s) => (s === 'available' ? 'ok' : a.optional || /download/.test(s) ? 'warn' : 'fail'), failAs: a.optional ? 'warn' : 'fail' },
        );
      }
      if (api.params) {
        await step(
          'chrome',
          'Model parameters',
          () => api.params!(),
          (p) => (p ? `topK ${String(p.defaultTopK)} of ${String(p.maxTopK)} · temperature ${String(p.defaultTemperature)} of ${String(p.maxTemperature)}` : 'none given'),
          { timeoutMs: 10_000, failAs: 'warn' },
        );
      }
      setCurrent('');
    })();
    return () => {
      removeEventListener('error', onError);
      removeEventListener('unhandledrejection', onRejection);
    };
    // Once per page load; the helpers only touch refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  async function runAll() {
    for (const [id, r] of rows.current) if (r.section === 'nano' || r.section === 'app') rows.current.delete(id);
    problems.current = problems.current.filter((p) => p.step.startsWith('page'));
    ledgerRows.current = [];
    answers.current = [];
    setRunning(true);
    setSince(Date.now());
    setNow(Date.now());
    try {
      await directly();
      await appSteps();
    } finally {
      setRunning(false);
      setRan(true);
      setCurrent('');
    }
  }

  async function directly() {
    const api = promptApi();
    if (!api) {
      put({ id: 'nano:none', section: 'nano', label: 'Prompt API', status: 'skip', value: 'not in this browser' });
      return;
    }
    const downloading = (progress: (t: string) => void) => (m: EventTarget) =>
      m.addEventListener('downloadprogress', (e) => progress(`downloading Gemini Nano: ${Math.round(((e as unknown as { loaded: number }).loaded ?? 0) * 100)} %`));
    const once = async (text: string, signal: AbortSignal) => {
      const s = await api.create({ ...TEXT_ONLY, signal });
      try {
        return await s.prompt(text, { signal });
      } finally {
        s.destroy();
      }
    };

    const s = await step(
      'nano',
      'Open a text session',
      (signal, progress) => api.create({ ...TEXT_ONLY, signal, monitor: downloading(progress) }),
      (v) => (Number.isFinite(quotaOf(v)) ? `ready · a context of ${tokens(quotaOf(v))} tokens` : `ready · it does not say its size (it has: ${namesOn(v)})`),
      { timeoutMs: 600_000 },
    );
    if (s) {
      await step(
        'nano',
        'Size of a 300- and a 1,500-word post',
        async () => [await usageOf(s, wordsOf(300)), await usageOf(s, wordsOf(1500))] as const,
        ([a, b]) =>
          Number.isFinite(a) ? `${tokens(a)} and ${tokens(b)} tokens, of ${Number.isFinite(quotaOf(s)) ? tokens(quotaOf(s)) : 'an unknown number'}` : `not measured (it has: ${namesOn(s)})`,
        { judge: ([a, b]) => (!Number.isFinite(a) ? 'warn' : b > quotaOf(s) * 0.8 ? 'warn' : 'ok') },
      );
      await step('nano', 'A short answer', (signal) => s.prompt('Answer with one word: are you ready?', { signal }), (t) => `“${clip(t, 50)}”`);
      await step(
        'nano',
        'A JSON answer (responseConstraint)',
        (signal) =>
          s.prompt('Is the sky blue on a clear day? Answer in JSON.', {
            signal,
            responseConstraint: { type: 'object', properties: { answer: { type: 'boolean' } }, required: ['answer'] },
          }),
        (t) => `${isJson(t) ? 'valid JSON' : 'not JSON'}: ${clip(t, 50)}`,
        { judge: (t) => (isJson(t) ? 'ok' : 'fail') },
      );
      s.destroy();
    }
    await step(
      'nano',
      '5 calls in a row, a new session each',
      async (signal) => {
        const times: number[] = [];
        let failed = 0;
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          try {
            await once(`Say the number ${i + 1}, nothing else.`, signal);
          } catch (e) {
            failed++;
            problem(`5 in a row, call ${i + 1}`, e, performance.now() - t0);
          }
          times.push(performance.now() - t0);
        }
        return { times, failed };
      },
      ({ times, failed }) => `${5 - failed} of 5 answered · ${times.map(fmtMs).join(', ')}`,
      { timeoutMs: 300_000, judge: (r) => (r.failed ? 'fail' : 'ok') },
    );
    await step(
      'nano',
      '2 calls at the same time',
      async (signal) => {
        const t0 = performance.now();
        const r = await Promise.allSettled([once('Say A, nothing else.', signal), once('Say B, nothing else.', signal)]);
        r.forEach((x, i) => x.status === 'rejected' && problem(`2 at once, call ${i + 1}`, x.reason, performance.now() - t0));
        return r.filter((x) => x.status === 'fulfilled').length;
      },
      (n) => `${n} of 2 answered`,
      { judge: (n) => (n === 2 ? 'ok' : 'fail') },
    );
    const img = await step(
      'nano',
      'Open a text-and-image session',
      (signal, progress) => api.create({ ...TEXT_AND_IMAGE, signal, monitor: downloading(progress) }),
      () => 'ready',
      { timeoutMs: 600_000 },
    );
    if (img) {
      await step(
        'nano',
        'Describe the sample photo',
        async (signal) => {
          const png = await svgToPng(SCENE_SVG, SCENE_W, SCENE_H);
          const image = new Blob([png.slice()], { type: 'image/png' });
          return img.prompt(
            [
              {
                role: 'user',
                content: [
                  { type: 'text', value: 'Describe this picture in at most eight words.' },
                  { type: 'image', value: image },
                ],
              },
            ],
            { signal },
          );
        },
        (t) => `“${clip(t, 60)}”`,
      );
      img.destroy();
    }
  }

  async function appSteps() {
    if (!isLive()) {
      put({ id: 'app:none', section: 'app', label: 'Firebase AI Logic', status: 'skip', value: 'this build has no Firebase configuration' });
      return;
    }
    const ledger = new Ledger();
    const built = buildKit(ledger);
    const backends = built.backends;
    const local = backends.local as { prepare?: (onProgress?: (p: number) => void) => Promise<void> };
    // Each of Gemini Nano's answers as it arrives: how long it took, how long it is, and how much of it is blank space.
    // In the second report one rewrite took 118 s for 202 words: a long run of blanks inside the JSON would explain it.
    const measured: ModelBackend = {
      name: backends.local.name,
      generate: async (parts, opts) => {
        const t0 = performance.now();
        const r = await backends.local.generate(parts, opts);
        answers.current.push({ op: opts.op, ms: performance.now() - t0, chars: r.text.length, blank: (r.text.match(/\s/g) ?? []).length });
        return r;
      },
    };
    const kit = { ...built.kit, local: new LocalModel(measured, ledger) };
    const ready = await step(
      'app',
      'Load Firebase AI Logic and prepare Gemini Nano',
      async (_signal, progress) => {
        await local.prepare?.((p) => progress(`downloading Gemini Nano: ${Math.round(p * 100)} %`));
        return true;
      },
      () => 'ready',
      { timeoutMs: 600_000 },
    );
    if (ready) {
      // The model calls have the app's own time limits (5 min each); these steps add none of their own.
      const threat = buildAuthorship(() => undefined);
      const clues = await step(
        'app',
        'Scan the sample post',
        () => threat.findClues(secret(DRAFT, 'sample post'), kit),
        (c) => {
          const d = c.filter((x) => x.kind === 'content').map((x) => x.phrase);
          return `${d.length} details: ${d.join(', ') || 'none'}`;
        },
        { timeoutMs: 0, judge: (c) => (c.some((x) => x.kind === 'content') ? 'ok' : 'warn') },
      );
      for (const n of [1, 2]) {
        await step(
          'app',
          `Rewrite the sample post (${n} of 2)`,
          () => threat.sanitize(secret(DRAFT, 'sample post'), clues ?? [], null, kit),
          (p) => {
            const r = threat.lastRewrite;
            return `released · ${countWords(p.value)} words · ${r?.detailsLeft.length ?? 0} details left · meaning check ${r?.meaningCheck ?? '?'} · “${clip(p.value, 70)}”`;
          },
          { timeoutMs: 0, judge: () => (threat.lastRewrite?.detailsLeft.length || threat.lastRewrite?.meaningCheck === 'failed' ? 'warn' : 'ok') },
        );
      }
      await step(
        'app',
        'Scan the sample photo',
        async () => {
          const png = await svgToPng(SCENE_SVG, SCENE_W, SCENE_H);
          const photo = locationThreat({ ops: browserImageOps, truth: secret(DEMO_TRUTH, 'where the sample photo was taken') });
          return photo.findClues(secret(png, 'sample photo'), kit);
        },
        (c) => `${c.length} cells: ${c.map((x) => `${x.cell} ${x.kind} (${clip(x.what, 24)})`).join(', ') || 'none'}`,
        { timeoutMs: 0, judge: (c) => (c.length ? 'ok' : 'warn') },
      );
      // A longer post, and one in Spanish: what someone pastes, rather than the 80-word sample.
      const longer = buildAuthorship(() => undefined);
      const longClues = await step(
        'app',
        `Scan a longer post (${countWords(LONG_POST)} words)`,
        () => longer.findClues(secret(LONG_POST, 'longer post'), kit),
        (c) => {
          const d = c.filter((x) => x.kind === 'content').map((x) => x.phrase);
          return `${d.length} details: ${clip(d.join(', '), 160) || 'none'}`;
        },
        { timeoutMs: 0, judge: (c) => (c.filter((x) => x.kind === 'content').length >= 5 ? 'ok' : 'warn') },
      );
      await step(
        'app',
        'Rewrite the longer post',
        () => longer.sanitize(secret(LONG_POST, 'longer post'), longClues ?? [], null, kit),
        (p) => {
          const r = longer.lastRewrite;
          return `released · ${countWords(p.value)} of ${countWords(LONG_POST)} words · ${r?.detailsLeft.length ?? 0} details left · meaning check ${r?.meaningCheck ?? '?'} (${r?.claims.filter((x) => x.kept).length ?? 0} of ${r?.claims.length ?? 0} claims kept) · “${clip(p.value, 70)}”`;
        },
        { timeoutMs: 0, judge: (p) => (longer.lastRewrite?.detailsLeft.length || countWords(p.value) < 0.4 * countWords(LONG_POST) ? 'warn' : 'ok') },
      );
    }
    ledgerRows.current = ledger.all.slice();
    redraw();
  }

  const all = [...rows.current.values()];
  const rowsOf = (s: SectionId) => all.filter((r) => r.section === s);
  const checked = all.filter((r) => r.section === 'nano' || r.section === 'app');
  const failed = checked.filter((r) => r.status === 'fail').length;
  const toLook = checked.filter((r) => r.status === 'warn').length;

  function report(): string {
    const lines = [`Throwaway · Gemini Nano check · ${new Date().toISOString()}`, `${location.origin}${location.pathname} · ${bundle()}`];
    for (const s of SECTIONS) {
      const rs = rowsOf(s.id);
      if (!rs.length) continue;
      lines.push('', s.title.toUpperCase());
      for (const r of rs) lines.push(`  ${MARK[r.status]} ${r.label}: ${r.value}${r.ms != null ? ` (${fmtMs(r.ms)})` : ''}`);
    }
    if (ledgerRows.current.length) {
      lines.push('', 'THE APP’S LEDGER');
      for (const e of ledgerRows.current) lines.push(`  ${e.op} · ${e.route} · ${fmtMs(e.ms)} · ${e.bytesOut} B out${e.note ? ` · ${e.note}` : ''}`);
    }
    if (answers.current.length) {
      lines.push('', 'GEMINI NANO’S ANSWERS, AS THEY CAME');
      for (const a of answers.current) lines.push(`  ${a.op} · ${fmtMs(a.ms)} · ${a.chars.toLocaleString('en-US')} characters, ${a.blank.toLocaleString('en-US')} of them blank`);
    }
    lines.push('', problems.current.length ? `ERRORS (${problems.current.length})` : 'ERRORS: none');
    for (const p of grouped(problems.current)) {
      const times = p.steps.length > 1 ? ` (${p.steps.length} times)` : '';
      lines.push(`  [${p.steps.join(', ')}]${times} ${p.name}${p.code ? ` (${p.code})` : ''}: ${p.message}${p.cause ? ` · cause ${p.cause}` : ''}${p.ms != null ? ` · first after ${fmtMs(p.ms)}` : ''}`);
    }
    return lines.join('\n');
  }

  async function copy() {
    const text = report();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard permission: show the report selected, ready for Ctrl+C.
      setShowReport(true);
      requestAnimationFrame(() => {
        const pre = preRef.current;
        if (!pre) return;
        const range = document.createRange();
        range.selectNodeContents(pre);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
      });
    }
  }

  return (
    <main className="dg">
      <header className="dg-head">
        <p className="dg-kicker">
          <a href="/app/">Throwaway</a> · device check
        </p>
        <h1>Does Gemini Nano work in this Chrome?</h1>
        <p className="dg-lede">Every model call on this page runs on this device. Nothing goes to a cloud model.</p>
        <div className="dg-actions">
          <button className="dg-btn primary" onClick={runAll} disabled={running}>
            {running ? 'Checking…' : ran ? 'Run it again' : 'Run the check'}
          </button>
          <button className="dg-btn" onClick={copy}>
            {copied ? 'Copied' : 'Copy report'}
          </button>
        </div>
        <p className="dg-status" role="status">
          {running
            ? `${current || 'Starting'} · ${Math.max(0, Math.round((now - since) / 1000))} s`
            : ran
              ? failed || toLook
                ? `${failed} failed, ${toLook} to look at. Copy the report and send it.`
                : `All ${checked.length} checks passed.`
              : 'Takes 2 to 6 minutes. Keep this tab in front while it runs.'}
        </p>
      </header>

      {SECTIONS.map((s) => {
        const rs = rowsOf(s.id);
        return (
          <section className="dg-card" key={s.id} aria-labelledby={`dg-${s.id}`}>
            <h2 id={`dg-${s.id}`}>{s.title}</h2>
            {s.note && <p className="dg-note">{s.note}</p>}
            {rs.length ? (
              <ul className="dg-rows">
                {rs.map((r) => (
                  <li key={r.id} className={`dg-row ${r.status}`}>
                    <span className="dg-dot" aria-hidden="true" />
                    <span className="dg-sr">{WORD[r.status]}: </span>
                    <span className="dg-label">{r.label}</span>
                    <span className="dg-value">{r.value}</span>
                    <span className="dg-ms">{r.ms != null ? fmtMs(r.ms) : ''}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="dg-empty">{s.id === 'nano' || s.id === 'app' ? 'Runs when you press “Run the check”.' : 'Looking…'}</p>
            )}
          </section>
        );
      })}

      {answers.current.length > 0 && (
        <section className="dg-card" aria-labelledby="dg-answers">
          <h2 id="dg-answers">Gemini Nano’s answers, as they came</h2>
          <p className="dg-note">How long each answer is, and how much of it is blank space.</p>
          <ul className="dg-rows">
            {answers.current.map((a, i) => (
              <li key={i} className={`dg-row ${a.blank > 0.5 * a.chars && a.chars > 400 ? 'warn' : 'ok'}`}>
                <span className="dg-dot" aria-hidden="true" />
                <span className="dg-label">{a.op}</span>
                <span className="dg-value">
                  {a.chars.toLocaleString('en-US')} characters, {a.blank.toLocaleString('en-US')} blank
                </span>
                <span className="dg-ms">{fmtMs(a.ms)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {ledgerRows.current.length > 0 && (
        <section className="dg-card" aria-labelledby="dg-ledger">
          <h2 id="dg-ledger">The app’s ledger</h2>
          <ul className="dg-rows">
            {ledgerRows.current.map((e, i) => (
              <li key={i} className={`dg-row ${e.note && /fail|no answer|unreadable/.test(e.note) ? 'warn' : 'ok'}`}>
                <span className="dg-dot" aria-hidden="true" />
                <span className="dg-label">{e.op}</span>
                <span className="dg-value">
                  {e.route} · {e.bytesOut} B out{e.note ? ` · ${e.note}` : ''}
                </span>
                <span className="dg-ms">{fmtMs(e.ms)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="dg-card" aria-labelledby="dg-errors">
        <h2 id="dg-errors">Errors</h2>
        {problems.current.length ? (
          <ul className="dg-errors">
            {grouped(problems.current).map((p, i) => (
              <li key={i}>
                <strong>
                  {stepsOf(p.steps)}
                  {p.steps.length > 1 ? ` · ${p.steps.length} times` : ''}
                </strong>
                <code>
                  {p.name}
                  {p.code ? ` (${p.code})` : ''}: {p.message}
                  {p.cause ? ` · cause ${p.cause}` : ''}
                </code>
              </li>
            ))}
          </ul>
        ) : (
          <p className="dg-empty">None so far.</p>
        )}
      </section>

      <details className="dg-card dg-report" open={showReport} onToggle={(e) => setShowReport((e.target as HTMLDetailsElement).open)}>
        <summary>The report, as it will be copied</summary>
        <pre ref={preRef}>{report()}</pre>
      </details>
    </main>
  );
}
