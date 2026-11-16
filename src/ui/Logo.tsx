/** The mark: a face with its eyes struck out by a marker. Anonymous, done by hand, like the rewrite. */
export function Logo({ size = 46 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className="logo-mark" aria-hidden>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="var(--slate)" />
      <circle cx="32" cy="25" r="11" fill="var(--paper)" />
      <path d="M12 60c2-13 10-19 20-19s18 6 20 19z" fill="var(--paper)" />
      <path
        className="logo-stroke"
        d="M15.5 26.5c6.2-2.8 12.4-3.7 18.6-3.4 5.1.2 9.6 1 14.4 2.5"
        stroke="var(--ink)"
        strokeWidth="6.5"
        strokeLinecap="round"
        fill="none"
        pathLength={1}
      />
    </svg>
  );
}
