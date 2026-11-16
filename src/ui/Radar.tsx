import { formatKm } from './shared';

// Log-scale "attacker's map": the circle is how far the attacker's guess landed from you (or, without ground truth,
// the precision it claims). Small and red: it found you. Large and green: wrong place.
const MIN = Math.log10(0.05);
const MAX = Math.log10(5000);
const R0 = 16;
const R1 = 168;
const radius = (km: number) => R0 + ((Math.log10(Math.min(Math.max(km, 0.05), 5000)) - MIN) / (MAX - MIN)) * (R1 - R0);
const RINGS = [0.1, 1, 10, 100, 1000];

const DOT = { good: '#35d98f', warn: '#ffb020', bad: '#ff4b3e' };

/** `level`: good (wrong place), warn (it knows your city, not your street) or bad (it found you). */
export function Radar({ km, title, subtitle, level, history }: { km: number | null; title: string; subtitle: string; level: 'good' | 'warn' | 'bad'; history: number[] }) {
  return (
    <div className="radar">
      <svg viewBox="0 0 360 360" role="img" aria-label={km === null ? 'Not attacked yet' : `${title}. ${subtitle}`}>
        <defs>
          <pattern id="dots" width="12" height="12" patternUnits="userSpaceOnUse">
            <circle cx="2" cy="2" r="1" fill="rgba(255,255,255,0.07)" />
          </pattern>
        </defs>
        <rect width="360" height="360" fill="url(#dots)" />
        {RINGS.map((r) => (
          <g key={r}>
            <circle cx="180" cy="180" r={radius(r)} fill="none" stroke="rgba(255,255,255,0.12)" strokeDasharray="3 5" />
            <text x={180 + radius(r) * 0.71 + 4} y={180 - radius(r) * 0.71 - 4} className="ring-label">
              {formatKm(r)}
            </text>
          </g>
        ))}
        <line x1="180" y1="6" x2="180" y2="354" stroke="rgba(255,255,255,0.08)" />
        <line x1="6" y1="180" x2="354" y2="180" stroke="rgba(255,255,255,0.08)" />
        {history.slice(0, -1).map((h, i) => (
          <circle key={i} cx="180" cy="180" r={radius(h)} fill="none" stroke="rgba(255,75,62,0.35)" strokeDasharray="2 4" />
        ))}
        {km !== null && <circle className={`blast ${level === 'good' ? 'safe' : level}`} cx="180" cy="180" r={radius(km)} />}
        <circle cx="180" cy="180" r="5" fill={km === null ? '#8d919b' : DOT[level]} />
      </svg>
      <div className="radar-caption">
        {km === null ? (
          <span>Not attacked yet</span>
        ) : (
          <>
            <strong className={level}>{title}</strong>
            <span>{subtitle}</span>
          </>
        )}
      </div>
    </div>
  );
}
