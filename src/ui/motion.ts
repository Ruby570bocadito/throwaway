import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

const REDUCE = '(prefers-reduced-motion: reduce)';
const subscribe = (cb: () => void) => {
  const m = matchMedia(REDUCE);
  m.addEventListener('change', cb);
  return () => m.removeEventListener('change', cb);
};

/** True when the user asked the system for less motion. Every animation here has a still version. */
export const useReducedMotion = () => useSyncExternalStore(subscribe, () => matchMedia(REDUCE).matches, () => false);

/**
 * A number that eases to each new value, so a score or a distance is seen changing rather than swapped. `log` interpolates
 * on a log scale (a distance going from 500 m to 869 km). It jumps straight to the value under reduced motion.
 */
export function useAnimatedNumber(value: number, { duration = 800, log = false } = {}): number {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(value);
  const current = useRef(value);
  useEffect(() => {
    if (reduce) return;
    const a = current.current;
    if (a === value) return;
    const f = log ? (x: number) => Math.log10(Math.max(x, 1e-3)) : (x: number) => x;
    const g = log ? (y: number) => 10 ** y : (y: number) => y;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      const eased = 1 - (1 - t) ** 3;
      const v = t < 1 ? g(f(a) + (f(value) - f(a)) * eased) : value;
      current.current = v;
      setShown(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration, log, reduce]);
  if (reduce) {
    current.current = value;
    return value;
  }
  return shown;
}

/** Whole seconds since `since` (a Date.now() timestamp), ticking while it is set. */
export function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((Math.max(now, since) - since) / 1000));
}

export const formatSeconds = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`);
