import { useState, type ReactNode } from 'react';
import type { LedgerEntry, Route } from '../framework';
import { useAnimatedNumber } from './motion';

type Row = { kind: 'one'; key: string; e: LedgerEntry } | { kind: 'group'; key: string; items: LedgerEntry[] };

/** Same operation, numbers aside: "Attack attempt 3 of 10" and "Attack attempt 4 of 10" are one family. */
const family = (op: string) => op.replace(/\d+/g, '#');

/**
 * Newest first, with runs of 3+ calls of the same kind folded into one row (the ten attempts of an attack). Keys count from
 * the oldest entry, so rows keep their identity as new entries arrive on top and only the new ones animate in.
 */
function groupEntries(entries: LedgerEntry[]): Row[] {
  const rows: Row[] = [];
  const n = entries.length;
  for (let i = 0; i < n; ) {
    const f = family(entries[i].op);
    let j = i + 1;
    while (j < n && family(entries[j].op) === f && entries[j].route === entries[i].route) j++;
    if (j - i >= 3) rows.push({ kind: 'group', key: `g${n - j}`, items: entries.slice(i, j) });
    else for (let k = i; k < j; k++) rows.push({ kind: 'one', key: `e${n - k}`, e: entries[k] });
    i = j;
  }
  return rows;
}

const ROUTE_LABEL: Record<Route, string> = { 'on-device': 'on-device', 'local-js': 'local-js', cloud: 'cloud', blocked: 'blocked' };
const bytes = (b: number) => `${b.toLocaleString('en-US')} B`;
const clean = (note?: string) => note?.replace(/( · )?recorded$/, '').trim() || '';

function Note({ note, recorded }: { note?: string; recorded: boolean }) {
  const text = clean(note);
  if (!text && !recorded) return null;
  return (
    <>
      {text && <em className="l-note"> · {text}</em>}
      {recorded && <em className="l-rec"> · recorded</em>}
    </>
  );
}

function Cells({ op, note, route, ms, out, recorded }: { op: ReactNode; note?: string; route: Route; ms: number; out: number; recorded: boolean }) {
  return (
    <>
      <span role="cell" className="l-op">
        {op}
        <Note note={note} recorded={recorded} />
      </span>
      <span role="cell" className="l-where">
        <span className={`route ${route}`}>{ROUTE_LABEL[route]}</span>
      </span>
      <span role="cell" className="l-ms">{ms.toLocaleString('en-US')} ms</span>
      <span role="cell" className={`l-out ${out ? 'some' : ''}`}>{bytes(out)}</span>
    </>
  );
}

function Group({ items }: { items: LedgerEntry[] }) {
  const [open, setOpen] = useState(false);
  const first = items[items.length - 1];
  const isAttack = /^Attack attempt/.test(first.op);
  const notes = [...new Set(items.map((e) => clean(e.note)))];
  const recorded = items.every((e) => e.note?.endsWith('recorded'));
  const label = isAttack ? `Attack · ${items.length} attempts` : `${family(first.op).replace(/#/g, '…')} · ×${items.length}`;
  return (
    <>
      <div role="row" className="l-row group">
        <Cells
          op={
            <button type="button" className="l-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              <span className="l-caret" aria-hidden="true" />
              {label}
            </button>
          }
          note={notes.length === 1 ? notes[0] : 'answers differ, open to see each'}
          route={first.route}
          ms={items.reduce((a, e) => a + e.ms, 0)}
          out={items.reduce((a, e) => a + e.bytesOut, 0)}
          recorded={recorded}
        />
      </div>
      {open &&
        items.map((e, i) => (
          <div role="row" className="l-row sub" key={i}>
            <Cells op={e.op} note={e.note} route={e.route} ms={e.ms} out={e.bytesOut} recorded={!!e.note?.endsWith('recorded')} />
          </div>
        ))}
    </>
  );
}

/** The route ledger as a receipt: every step, where it ran, how long it took, and what left the device. */
export function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
  const rows = groupEntries(entries);
  return (
    <div role="table" aria-label="Route ledger: every step, where it ran, how long it took and how many bytes left your device" className="ltable">
      <div role="rowgroup" className="l-head">
        <div role="row" className="l-row">
          <span role="columnheader">Operation</span>
          <span role="columnheader">Where</span>
          <span role="columnheader">Time</span>
          <span role="columnheader">Bytes out</span>
        </div>
      </div>
      <div role="rowgroup" className="l-body">
        {rows.map((r) =>
          r.kind === 'group' ? (
            <Group key={r.key} items={r.items} />
          ) : (
            <div role="row" className="l-row" key={r.key}>
              <Cells op={r.e.op} note={r.e.note} route={r.e.route} ms={r.e.ms} out={r.e.bytesOut} recorded={!!r.e.note?.endsWith('recorded')} />
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/** Totals for the top of the receipt: steps on the device, calls to the cloud and their bytes, blocked attempts. */
export function LedgerSummary({ entries }: { entries: LedgerEntry[] }) {
  const local = entries.filter((e) => e.route === 'on-device' || e.route === 'local-js').length;
  const cloud = entries.filter((e) => e.route === 'cloud');
  const blocked = entries.filter((e) => e.route === 'blocked').length;
  const sent = useAnimatedNumber(
    cloud.reduce((a, e) => a + e.bytesOut, 0),
    { duration: 900 },
  );
  return (
    <dl className="l-sum">
      <div className="device">
        <dt>On your device</dt>
        <dd>
          {local} step{local === 1 ? '' : 's'} · 0 B
        </dd>
      </div>
      <div className="cloud">
        <dt>To the cloud</dt>
        <dd>
          {cloud.length} call{cloud.length === 1 ? '' : 's'} · {bytes(Math.round(sent))}
        </dd>
      </div>
      <div className={blocked ? 'blocked' : ''}>
        <dt>Blocked</dt>
        <dd>{blocked}</dd>
      </div>
    </dl>
  );
}
