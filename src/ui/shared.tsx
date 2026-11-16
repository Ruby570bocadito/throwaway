import { isTemporary, PrivacyViolation, type Kit } from '../framework';

/** What happened and what to do, in plain words. A raw exception string is never shown alone. */
export function friendlyError(e: unknown): string {
  if (e instanceof PrivacyViolation) {
    // Without a local model the user edits by hand; release() refuses an edit that keeps a long run of the original.
    if (e.where.includes('edited by the user')) return 'Your edit still keeps a long passage of your original (about 7 words or more). Change it a little more, then try again.';
    return e.message;
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (isTemporary(e)) return 'The cloud model is busy right now. Wait a minute and try again.';
  if (/app ?check|\b40[13]\b|permission_denied/i.test(msg)) return 'This browser could not prove it is the real app (App Check). Reload the page and try again.';
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
  /** The local backend, to prepare Gemini Nano from a user gesture when live; reports download progress (0–1). */
  localBackend: { prepare?: (onProgress?: (p: number) => void) => Promise<void> };
  /** The dock fixed at the bottom of the screen, owned by the shell: each lab renders its actions there. */
  dock: HTMLElement | null;
  /** No local model: the lab must not run local inference and must not fall back to the cloud with private data. */
  degraded: boolean;
  /** The shell's "Try to leak" button calls the function the active lab registers here. */
  registerLeak: (fn: (() => Promise<string>) | null) => void;
  /** Recorded run (?demo): the model answers were recorded for the sample post and photo, so your own input is not offered there. */
  recorded: boolean;
}

export function Silhouette({ hot }: { hot: boolean }) {
  return (
    <svg viewBox="0 0 64 64" className={`sil ${hot ? 'hot' : ''}`} aria-hidden>
      <circle cx="32" cy="22" r="11" />
      <path d="M10 60c2-14 11-21 22-21s20 7 22 21z" />
    </svg>
  );
}

export const formatKm = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${Math.round(km).toLocaleString('en-US')} km`);
