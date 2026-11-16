import { useMemo } from 'react';
import { diffWords } from './diff';

/** Your original and the version you would post, side by side: what was taken out, and what was put in. Shown only on this device. */
export function Compare({ original, final }: { original: string; final: string }) {
  const parts = useMemo(() => diffWords(original, final), [original, final]);
  return (
    <div className="compare">
      <div>
        <h3>Your original · stays on this device</h3>
        <p>{parts.map((p, i) => (p.op === 'added' ? null : p.op === 'removed' ? <del key={i}>{p.text}</del> : <span key={i}>{p.text}</span>))}</p>
      </div>
      <div>
        <h3>What you would post</h3>
        <p>{parts.map((p, i) => (p.op === 'removed' ? null : p.op === 'added' ? <ins key={i}>{p.text}</ins> : <span key={i}>{p.text}</span>))}</p>
      </div>
    </div>
  );
}
