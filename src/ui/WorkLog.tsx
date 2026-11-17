import { useEffect, useState } from 'react';
import type { Ledger, LedgerEntry, Route } from '../framework';
import { formatSeconds, useElapsed } from './motion';

/** One expected sub-step of a long action, recognised by the ledger entry it leaves when it finishes. */
export interface PlanStep {
  match: RegExp;
  label: string;
  route: Route;
  /** Gemini Nano: 15–40 s each on a laptop (measured 16-nov). */
  slow?: boolean;
  /** Only happens sometimes (e.g. no detail to generalise). */
  optional?: boolean;
}

interface Row {
  key: string;
  label: string;
  route: Route;
  state: 'done' | 'now' | 'todo';
  ms?: number;
  slow?: boolean;
}

const WHERE: Record<Route, string> = { 'on-device': 'Gemini Nano', 'local-js': 'plain JavaScript', cloud: 'cloud', blocked: 'blocked', skipped: 'not run: no local model' };

/**
 * Honest progress for the long on-device steps: what has finished (read from the ledger, with its real duration), what is
 * running now and for how long, and what comes next. Anything the plan does not know is still listed as it finishes.
 */
export function WorkLog({
  ledger,
  since,
  plan,
  title,
  recorded,
  download,
}: {
  ledger: Ledger;
  since: number;
  plan: PlanStep[];
  title: string;
  recorded: boolean;
  /** Gemini Nano download progress (0–1), the first time only. */
  download: number | null;
}) {
  const [done, setDone] = useState<LedgerEntry[]>([]);
  useEffect(() => {
    const off = ledger.subscribe((all) => setDone(all.filter((e) => e.at >= since).reverse()));
    return () => {
      off();
    };
  }, [ledger, since]);
  const elapsed = useElapsed(since);
  const lastAt = done.length ? done[done.length - 1].at : since;
  const stepElapsed = useElapsed(lastAt);

  const rows: Row[] = [];
  let cursor = 0;
  done.forEach((e, n) => {
    const k = plan.findIndex((s, i) => i >= cursor && s.match.test(e.op));
    if (k === -1) {
      rows.push({ key: `x${n}`, label: e.op, route: e.route, state: 'done', ms: e.ms });
      return;
    }
    rows.push({ key: `p${k}`, label: plan[k].label, route: e.route, state: 'done', ms: e.ms });
    cursor = k + 1;
  });
  // What is left, keyed by its place in the plan so a row keeps its identity from "now" to "done". An optional step that
  // has not happened is not shown as running: it may never happen.
  const rest = plan
    .map((s, idx) => ({ s, idx }))
    .slice(cursor)
    .filter(({ s }, i) => !s.optional || i > 0);
  rest.forEach(({ s, idx }, i) => rows.push({ key: `p${idx}`, label: s.label, route: s.route, state: i === 0 ? 'now' : 'todo', slow: s.slow }));
  const now = rows.find((r) => r.state === 'now');

  return (
    <div className="worklog">
      {/* Announce the step, not the ticking clock. */}
      <p className="sr-only" role="status">
        {now ? `${title}: ${now.label}` : title}
      </p>
      <div className="worklog-head" aria-hidden="true">
        <strong>{title}</strong>
        <span className="worklog-time">{formatSeconds(elapsed)}</span>
      </div>
      <ol aria-label="Steps">
        {download !== null && (
          <li className={download >= 1 ? 'done' : 'now'}>
            <span className="wl-mark" aria-hidden="true">{download >= 1 ? '✓' : <span className="spinner" />}</span>
            <span className="wl-label">Download Gemini Nano, the first time only</span>
            <span className="wl-meta">
              <span className="wl-bar" aria-hidden="true">
                <i style={{ transform: `scaleX(${Math.min(1, download)})` }} />
              </span>
              {Math.round(Math.min(1, download) * 100)}%
            </span>
          </li>
        )}
        {rows.map((r) => (
          <li key={r.key} className={`${r.state} ${r.route === 'blocked' || r.route === 'skipped' ? r.route : ''}`}>
            {/* a step the guard stopped did not succeed, and a skipped one did not run: no tick for either */}
            <span className="wl-mark" aria-hidden="true">
              {r.state === 'done' ? (r.route === 'blocked' ? '✕' : r.route === 'skipped' ? '–' : '✓') : r.state === 'now' ? <span className="spinner" /> : ''}
            </span>
            <span className="wl-label">
              {r.label}
              <span className="wl-where"> · {WHERE[r.route]}</span>
            </span>
            <span className="wl-meta">{r.state === 'done' ? `${r.ms ?? 0} ms` : r.state === 'now' ? formatSeconds(stepElapsed) : ''}</span>
          </li>
        ))}
      </ol>
      {now?.slow && (
        <p className="worklog-note">
          {recorded
            ? 'Recorded run: the answer is replayed in about a second. Live, Gemini Nano takes 15–40 s for this step on a laptop.'
            : 'Gemini Nano runs on this device: 15–40 s for this step on a laptop. Nothing is sent while it works.'}
        </p>
      )}
    </div>
  );
}
