import { cloudTrouble, errorCode, isBlocked, isDeviceError, ModelTimeout, PrivacyViolation, type Kit } from '../framework';

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s).replace(/\.$/, '');

/** The DOMException name Chrome's Prompt API threw, on the error or on the error the SDK wrapped it in. */
const deviceErrorName = (e: unknown): string => {
  const own = (e as { name?: unknown } | null)?.name;
  const cause = (e as { cause?: { name?: unknown } } | null)?.cause?.name;
  return [own, cause].find((n): n is string => typeof n === 'string' && /^(QuotaExceeded|NotAllowed|NotSupported|InvalidState|Network)Error$/.test(n)) ?? '';
};

/**
 * What happened and what to do, in plain words, with a short error code a report can quote. A raw exception string is
 * never shown alone. Each cause has its own sentence: one "the cloud is overloaded" for every failure (a Gemini Nano
 * error, a blocked request, a spent quota) sent a user looking in the wrong place (17-nov).
 */
export function friendlyError(e: unknown): string {
  // Messages the app wrote for people, with what to do in them.
  if (e instanceof Error && e.name === 'UserFacingError') return e.message;
  if (e instanceof PrivacyViolation) {
    // Without a local model the user edits by hand; release() refuses an edit that keeps a long run of the original.
    if (e.where.includes('edited by the user')) return 'Your edit still keeps a long passage of your original (about 7 words in a row). Put it in other words, then try again.';
    return e.message;
  }
  const msg = e instanceof Error ? e.message : String(e);
  const code = errorCode(e);
  const tail = code ? ` (Error ${code}.)` : '';
  // Gemini Nano, on this device: never "the cloud".
  if (e instanceof ModelTimeout && e.where === 'device') return `${e.message} Try again; if it keeps happening, restart Chrome.`;
  if (isDeviceError(e)) {
    // Chrome's Prompt API says why in the error's name: each has its own thing to do (21-nov review).
    const why = deviceErrorName(e);
    if (why === 'QuotaExceededError') return `This is too long for Gemini Nano on this device. Shorten it, then try again.${tail}`;
    if (why === 'NotAllowedError')
      return `Chrome did not let Gemini Nano start: it needs a click on this page and enough free disk space. Press the button again.${tail}`;
    if (why === 'NotSupportedError')
      return `Gemini Nano in this Chrome cannot read this input (its language, or an image). Update Chrome, or try a post in English.${tail}`;
    if (why === 'InvalidStateError') return `Gemini Nano is not ready yet; it may still be downloading. Wait a minute, then try again.${tail}`;
    if (why === 'NetworkError') return `Gemini Nano’s download stopped. Check your connection, then try again.${tail}`;
    // The SDK's word for "Chrome says this model cannot run here" (for a photo: it may read text but not images).
    if (code === 'api-not-enabled')
      return `Gemini Nano cannot do this step in this Chrome. Turn on “Try it without Gemini Nano” to go on without it.${tail}`;
    return `Gemini Nano could not finish this step on your device: ${short(msg)}. Try again; if it keeps happening, restart Chrome.${tail}`;
  }
  if (isBlocked(e))
    return `Google’s AI would not read this version: its safety filter stopped it, and the backup model’s too. Put the harshest words more mildly, then try again.${tail}`;
  if (/app ?check|\b40[13]\b|permission_denied/i.test(msg))
    return `This browser could not prove it is the real app (App Check). If you use an ad or tracker blocker, allow reCAPTCHA on this site, then reload the page.${tail}`;
  switch (cloudTrouble(e)) {
    case 'quota':
      return `The free tier’s limit on requests to Google’s AI is reached for now, for the backup model too. Wait a minute and try again; if it keeps happening, today’s limit is spent.${tail}`;
    case 'network':
      return `This browser could not reach Google’s AI servers. Check your connection, or allow this site in your ad or tracker blocker, then try again.${tail}`;
    case 'timeout':
      return `Google’s AI took too long to answer, and so did the backup model. Nothing was lost: wait a minute and try again.${tail}`;
    case 'overloaded':
      // The main model and its backup were both busy for the whole time budget: Google's side, not the user's.
      return `Google’s AI is overloaded right now, the backup model too. Nothing was lost: wait a minute and try again.${tail}`;
  }
  // Errors the core writes for people (an empty or too long post, nothing to mask) already say what to do.
  if (/^(Nothing to mask|There is nothing to rewrite|This post is too long)/.test(msg)) return msg.replace(/\.?$/, '.');
  return `That didn't work: ${msg.replace(/\.$/, '')}. Try again.`;
}

/** An error in plain words, with the paper ball in the bin: the attempt was thrown away, the page is fine. */
export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="banner error span" role="alert">
      <img src="/illus/papelera-200.webp" width="56" height="56" alt="" />
      <p>{message}</p>
    </div>
  );
}

export interface LabProps {
  kit: Kit;
  /** The local backend, to prepare Gemini Nano from a user gesture when live (for images too, if asked); reports download progress (0–1). */
  localBackend: { prepare?: (onProgress?: (p: number) => void, o?: { image?: boolean }) => Promise<void> };
  /** The dock fixed at the bottom of the screen, owned by the shell: each lab renders its actions there. */
  dock: HTMLElement | null;
  /** No local model: the lab must not run local inference and must not fall back to the cloud with private data. */
  degraded: boolean;
  /** The shell's "Try to leak" button calls the function the active lab registers here. */
  registerLeak: (fn: (() => Promise<string>) | null) => void;
  /** Recorded run (?demo): the model answers were recorded for the sample post and photo, so your own input is not offered there. */
  recorded: boolean;
  /** The user's own texts, kept by the shell across "Start over", the Gemini Nano switch and a change of tab: in memory only. */
  kept?: KeptTexts | null;
  keep?: (texts: KeptTexts) => void;
  /** Start over with the texts kept and the box for your own public writing open. */
  addWriting?: () => void;
  /** Told whether the lab is past its first step or working: the shell asks Chrome about Gemini Nano again only before. */
  onStarted?: (started: boolean) => void;
}

export interface KeptTexts {
  draft: string;
  ownPublic: string;
  /** Open the box for your own public writing when the lab mounts (set by addWriting). */
  openOwn?: boolean;
}


export const formatKm = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${Math.round(km).toLocaleString('en-US')} km`);
