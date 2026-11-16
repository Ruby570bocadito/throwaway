import type { Kit } from '../framework';

export interface LabProps {
  kit: Kit;
  /** The local backend, to prepare Gemini Nano from a user gesture when live. */
  localBackend: { prepare?: () => Promise<void> };
  /** No local model: the lab must not run local inference and must not fall back to the cloud with private data. */
  degraded: boolean;
  /** The shell's "Try to leak" button calls the function the active lab registers here. */
  registerLeak: (fn: (() => Promise<string>) | null) => void;
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
