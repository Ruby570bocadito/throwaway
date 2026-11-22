import type { ReactNode } from 'react';

/** The answer to "why?", folded: habits, reasons, clues and claims are there for whoever asks, not in everyone's way (21-nov plan). */
export function Why({ summary, children, open = false }: { summary: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="why" open={open}>
      <summary>
        <span className="why-q">Why?</span>
        <span className="why-s">{summary}</span>
      </summary>
      <div className="why-body">{children}</div>
    </details>
  );
}
