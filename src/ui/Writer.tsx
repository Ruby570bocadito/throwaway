import { count as counted, tr } from '../i18n';

/** The labels a lab puts on your seat, in the reader's language (a label already translated is shown as it is). */
const SEAT = new Map([
  ['You', tr('You', 'Tú')],
  ['Sample', tr('Sample', 'Ejemplo')],
]);

export function WriterCard({
  letter,
  glyph,
  you,
  count,
  pointed,
  found,
}: {
  letter: string;
  glyph: number[];
  /** The label on your seat ("You", or "Sample" while the sample writer stands in for you); none on the others. */
  you?: string;
  /** How many times the attacker picked this writer so far. */
  count: number;
  /** The attacker is pointing at this writer right now. */
  pointed: boolean;
  /** Your seat, picked often enough to call it found. */
  found: boolean;
}) {
  const seat = you && (SEAT.get(you) ?? you);
  const times = counted(count, ['time', 'times'], ['vez', 'veces']);
  const label = `${tr(`Writer ${letter}`, `Persona ${letter}`)}${seat ? `, ${seat.toLowerCase()}` : ''}${count ? tr(`, picked ${times}`, `, elegida ${times}`) : ''}`;
  return (
    <div role="listitem" aria-label={label} className={`writer${you ? ' you' : ''}${pointed ? ' pointed' : ''}${count ? ' picked' : ''}${found ? ' found' : ''}`}>
      <span className="writer-letter" aria-hidden="true">
        {letter}
      </span>
      <svg className="writer-glyph" viewBox={`0 0 ${Math.max(glyph.length, 1) * 4} 24`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1="12" x2={Math.max(glyph.length, 1) * 4} y2="12" />
        {glyph.map((z, i) => (
          <rect key={i} x={i * 4 + 0.6} width="2.8" y={z > 0 ? 12 - z * 5 : 12} height={Math.max(0.8, Math.abs(z) * 5)} />
        ))}
      </svg>
      {you && (
        <span className="writer-you" aria-hidden="true">
          {seat}
        </span>
      )}
      {count > 0 && (
        <span className="writer-count" key={count} aria-hidden="true">
          {count}
        </span>
      )}
    </div>
  );
}
