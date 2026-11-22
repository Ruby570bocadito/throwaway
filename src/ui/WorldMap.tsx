import { tr } from '../i18n';
import { LAND } from './worldLand';

export interface MapPoint {
  lat: number;
  lon: number;
}

const toXY = (p: MapPoint) => ({ x: p.lon + 180, y: 90 - p.lat });

/**
 * Where you are and where the attacker guessed, on a map of the world drawn on this device (no map service sees either).
 * The view frames both points with room around them, from a region (30° wide) to the whole world. In place of rings of
 * distance, which said "10,559 km" without saying where (21-nov plan).
 */
export function WorldMap({
  you,
  youLabel,
  guess,
  guessLabel,
  distance,
  level,
}: {
  you: MapPoint | null;
  youLabel: string;
  guess: MapPoint | null;
  guessLabel: string;
  distance?: string;
  level: 'good' | 'warn' | 'bad';
}) {
  const points = [you, guess].filter((p): p is MapPoint => !!p).map(toXY);
  // The world without most of Antarctica, until there is something to frame.
  let view = { x: 0, y: 8, w: 360, h: 150 };
  if (points.length) {
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    let w = Math.max(30, (maxX - minX) * 1.5 + 12);
    let h = Math.max(15, (maxY - minY) * 1.5 + 8);
    if (w / h > 2) h = w / 2;
    else w = h * 2;
    if (w > 360) [w, h] = [360, 180];
    const x = Math.max(0, Math.min(360 - w, (minX + maxX) / 2 - w / 2));
    const y = Math.max(0, Math.min(180 - h, (minY + maxY) / 2 - h / 2));
    view = { x, y, w, h };
  }
  // Where a point sits in the frame, in percent: the markers are HTML, so they stay crisp and the same size at any zoom.
  const place = (p: MapPoint) => {
    const { x, y } = toXY(p);
    return { left: `${((x - view.x) / view.w) * 100}%`, top: `${((y - view.y) / view.h) * 100}%` };
  };
  const a = you && toXY(you);
  const b = guess && toXY(guess);
  // Labels away from each other (yours on the side away from the guess), and never off the map's edge.
  const side = (p: { x: number }, left: boolean) => {
    const pct = ((p.x - view.x) / view.w) * 100;
    return pct < 22 ? '' : pct > 78 ? 'flip' : left ? 'flip' : '';
  };
  const youSide = a ? side(a, !b || a.x <= b.x) : '';
  const guessSide = b ? side(b, !!a && a.x > b.x) : '';
  const label = [
    you && `${youLabel}`,
    guess && tr(`the AI’s guess, ${guessLabel}`, `lo que adivina la IA, ${guessLabel}`),
    distance && tr(`${distance} apart`, `a ${distance} de distancia`),
  ]
    .filter(Boolean)
    .join('; ');
  return (
    <div className="world" role="img" aria-label={label ? tr(`Map: ${label}`, `Mapa: ${label}`) : tr('Map of the world', 'Mapa del mundo')}>
      <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} aria-hidden="true">
        <rect className="world-sea" x="0" y="0" width="360" height="180" />
        <path className="world-land" d={LAND} />
        {a && b && <line className={`world-line ${level}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />}
      </svg>
      {you && (
        <span className={`world-pin you ${youSide}`} style={place(you)}>
          <i aria-hidden="true" />
          <span>{youLabel}</span>
        </span>
      )}
      {guess && (
        <span className={`world-pin guess ${level} ${guessSide}`} style={place(guess)}>
          <i aria-hidden="true" />
          <span>{guessLabel}</span>
        </span>
      )}
      {a && b && distance && (
        <span className="world-distance" style={place({ lon: (a.x + b.x) / 2 - 180, lat: 90 - (a.y + b.y) / 2 })}>
          {distance}
        </span>
      )}
    </div>
  );
}
