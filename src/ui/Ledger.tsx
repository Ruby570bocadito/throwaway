import { useState, type ReactNode } from 'react';
import type { LedgerEntry, Route } from '../framework';
import { count, lang, num, tr } from '../i18n';
import { useAnimatedNumber } from './motion';
import { translateMessage } from './shared';

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

const ROUTE_LABEL: Record<Route, string> = {
  'on-device': tr('on-device', 'en el dispositivo'),
  'local-js': tr('local-js', 'JS local'),
  cloud: tr('cloud', 'nube'),
  blocked: tr('blocked', 'bloqueado'),
  skipped: tr('not run', 'sin hacer'),
};
const bytes = (b: number) => `${num(b)} B`;
const clean = (note?: string) => note?.replace(/( · )?recorded$/, '').trim() || '';

// The receipt in Spanish. Operations and notes are written in English by the framework, the threats and the labs, and code
// and tests match them ("Leak…", "sent as-is by your choice", the work logs' plans): the data stays English and is
// translated here, on screen only. Anything not listed is shown as it is.
type Say = [RegExp, (...groups: string[]) => string];
const nounEs = (n: string, one: string, many: string) => `${n} ${n === '1' ? one : many}`;
const cellsEs = (what: string) => (what.startsWith('cell ') ? `la casilla ${what.slice(5)}` : nounEs(what.replace(/ cells$/, ''), 'casilla', 'casillas'));

const OPS_ES = new Map([
  ['Fingerprint (Burrows’ Delta)', 'Huella de escritura (Burrows’ Delta)'],
  ['Find identifying details', 'Buscar detalles que te identifican'],
  ['Find counts and dates (fixed rules)', 'Buscar cifras y fechas (reglas fijas)'],
  ['Find counts, dates and names (fixed rules)', 'Buscar cifras, fechas y nombres (reglas fijas)'],
  ['Rewrite on-device', 'Reescribir en el dispositivo'],
  ['Reword a copied sentence', 'Decir con otras palabras una frase copiada'],
  ['Check the final text for details', 'Buscar detalles en el texto final'],
  ['Meaning check', 'Comprobar que dice lo mismo'],
  ['Check your edit for passages of the original', 'Buscar en tu edición trozos del original'],
  ['Leak test: draft in a cloud prompt', 'Intento de filtración: el borrador en una petición a la nube'],
  ['Load your photo (EXIF stripped, resized)', 'Abrir tu foto (sin datos EXIF y a menor tamaño)'],
  ['Read your location from #truth (for local scoring only)', 'Leer tu ubicación de #truth (solo para puntuar en el dispositivo)'],
  ['Read your location (for local scoring only)', 'Leer tu ubicación (solo para puntuar en el dispositivo)'],
  ['Leak test: original photo to the cloud', 'Intento de filtración: la foto original a la nube'],
  ['Find location clues', 'Buscar pistas del lugar'],
  ['Find faces (MediaPipe, on the device)', 'Buscar caras (MediaPipe, en el dispositivo)'],
  ['Blur the faces too, by your choice', 'Difuminar también las caras, por decisión tuya'],
  ['Show the faces again', 'Volver a mostrar las caras'],
  ['Geolocation attack', 'Prueba de ubicación'],
]);
const OP_PATTERNS: Say[] = [
  [/^Rewrite part (\d+) of (\d+) on-device$/, (i, n) => `Reescribir la parte ${i} de ${n} en el dispositivo`],
  [/^Fixed rules generalised (\d+) details?$/, (n) => `Reglas fijas: ${nounEs(n, 'detalle generalizado', 'detalles generalizados')}`],
  [/^Attack attempt (\d+) of (\d+)$/, (i, n) => `Prueba: intento ${i} de ${n}`],
  [/^Attack attempts (\d+)–(\d+) skipped$/, (a, b) => `Prueba: intentos ${a}–${b} sin hacer`],
  [/^Find location clues \(scan (\d+)\/(\d+)\)$/, (i, n) => `Buscar pistas del lugar (pasada ${i}/${n})`],
  [/^Read the text in cell (\d+)$/, (cell) => `Leer el texto de la casilla ${cell}`],
  [/^Hide (\d+) clues? in the photo, around the faces$/, (n) => `Ocultar ${nounEs(n, 'pista', 'pistas')} de la foto, alrededor de las caras`],
  [/^Hide (\d+) cells? you chose, around the faces$/, (n) => `Ocultar ${nounEs(n, 'casilla elegida', 'casillas elegidas')} por ti, alrededor de las caras`],
  // One tap or more on a blurred photo (threats/location.ts toggleCells): "Hide cell 5 and show 2 cells again, around the faces".
  [
    /^(?:Hide (cell \d+|\d+ cells)(?: and show (cell \d+|\d+ cells) again)?|Show (cell \d+|\d+ cells) again), around the faces$/,
    (hide, alsoShow, show) =>
      `${[hide && `ocultar ${cellsEs(hide)}`, (alsoShow || show) && `volver a mostrar ${cellsEs(alsoShow || show)}`]
        .filter(Boolean)
        .join(' y ')
        .replace(/^./, (ch) => ch.toUpperCase())}, alrededor de las caras`,
  ],
];
// A step asked again after an answer it could not use (threats/authorship.ts, threats/location.ts).
const AGAIN_ES: [RegExp, string][] = [
  [/ \(again: unreadable answer\)$/, ' (otra vez: respuesta ilegible)'],
  [/ \(again: repeated answer\)$/, ' (otra vez: respuesta repetitiva)'],
  [/ \(again: refused answer\)$/, ' (otra vez: se negó)'],
  [/ \(again\)$/, ' (otra vez)'],
];

const NOTES_ES = new Map([
  ['cancelled', 'cancelado'],
  ['failed', 'ha fallado'],
  ['no answer (model busy)', 'sin respuesta (modelo ocupado)'],
  ['local model answered from cloud', 'el modelo local respondió desde la nube'],
  ['original, sent as-is by your choice', 'original, enviado tal cual por decisión tuya'],
  ['no model', 'sin modelo'],
  ['no local model, and not sent to the cloud instead', 'sin modelo local, y no se envía a la nube en su lugar'],
  ['no local model: you tap the cells to mask', 'sin modelo local: tú eliges qué casillas difuminar'],
  ['none left', 'no queda ninguno'],
  ['released', 'lista para publicar'],
  ['unreadable answer', 'respuesta ilegible'],
  ['read the final text yourself', 'lee tú el texto final'],
  ['the cloud model is not answering', 'el modelo de la nube no responde'],
  ['no face found', 'ninguna cara encontrada'],
  ['never hidden', 'nunca se ocultan'],
  ['faces not protected', 'caras sin proteger'],
  ['answers differ, open to see each', 'respuestas distintas, ábrelo para ver cada una'],
]);
const NOTE_PATTERNS: Say[] = [
  [/^no answer \(timed out after (\d+) s\)$/, (s) => `sin respuesta (tiempo agotado a los ${s} s)`],
  [/^answered by (.+), the backup model \(main model busy\)$/, (model) => `respondió ${model}, el modelo de reserva (el principal estaba ocupado)`],
  [/^sent (\d+) times \(model busy\)$/, (n) => `enviado ${n} veces (modelo ocupado)`],
  [/^(\d+) found$/, (n) => nounEs(n, 'encontrado', 'encontrados')],
  [/^found (\d+) that Nano missed$/, (n) => (n === '0' ? 'ninguno que Nano no viera' : `${n} más que Nano no vio`)],
  [/^Nano's answer was unreadable, the rules found (\d+)$/, (n) => `la respuesta de Nano no se podía leer; las reglas encontraron ${n}`],
  [/^generalised (\d+) details? the rewrite added$/, (n) => `${nounEs(n, 'detalle generalizado', 'detalles generalizados')} que añadió la reescritura`],
  [/^(\d+) faces?$/, (n) => nounEs(n, 'cara', 'caras')],
  [/^could not run \((.*)\)$/s, (why) => `no pudo funcionar (${why})`],
  [/^(\d+)% of the photo$/, (p) => `${p}\u00a0% de la foto`],
  [
    /^kept (\d+) clues? visible: all face, or past the budget$/,
    (n) => (n === '1' ? 'queda 1 pista a la vista: es todo cara, o pasa del límite' : `quedan ${n} pistas a la vista: son todo cara, o pasan del límite`),
  ],
  [/^(\d+) faces? blurred, by your choice$/, (n) => `${nounEs(n, 'cara difuminada', 'caras difuminadas')}, por decisión tuya`],
];

const say = (text: string, exact: Map<string, string>, patterns: Say[]): string | null => {
  const known = exact.get(text);
  if (known !== undefined) return known;
  for (const [pattern, words] of patterns) {
    const m = pattern.exec(text);
    if (m) return words(...m.slice(1));
  }
  return null;
};

/** A ledger operation as the reader reads it: "Attack attempt 3 of 10" is "Prueba: intento 3 de 10" in Spanish. */
export function opText(op: string): string {
  if (lang !== 'es') return op;
  const again = AGAIN_ES.find(([pattern]) => pattern.test(op));
  const base = again ? op.replace(again[0], '') : op;
  const known = say(base, OPS_ES, OP_PATTERNS);
  return known === null ? op : known + (again ? again[1] : '');
}

/** A ledger note, piece by piece (the framework joins them with " · "). */
const noteText = (note: string) =>
  lang !== 'es' ? note : note.split(' · ').map((piece) => say(piece, NOTES_ES, NOTE_PATTERNS) ?? translateMessage(piece)).join(' · ');

function Note({ note, recorded }: { note?: string; recorded: boolean }) {
  const text = clean(note);
  if (!text && !recorded) return null;
  return (
    <>
      {text && <em className="l-note"> · {noteText(text)}</em>}
      {recorded && <em className="l-rec"> · {tr('recorded', 'grabado')}</em>}
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
      <span role="cell" className="l-ms">{num(ms)} ms</span>
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
  const label = isAttack
    ? tr(`Attack · ${items.length} attempts`, `Prueba · ${items.length} intentos`)
    : `${family(opText(first.op)).replace(/#/g, '…')} · ×${items.length}`;
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
            <Cells op={opText(e.op)} note={e.note} route={e.route} ms={e.ms} out={e.bytesOut} recorded={!!e.note?.endsWith('recorded')} />
          </div>
        ))}
    </>
  );
}

/** The route ledger as a receipt: every step, where it ran, how long it took, and what left the device. */
export function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
  const rows = groupEntries(entries);
  return (
    <div
      role="table"
      aria-label={tr(
        'Receipt: every step, where it ran, how long it took and how many bytes left your device',
        'Recibo: cada paso, dónde se hizo, cuánto tardó y cuántos bytes salieron de tu dispositivo',
      )}
      className="ltable"
    >
      <div role="rowgroup" className="l-head">
        <div role="row" className="l-row">
          <span role="columnheader">{tr('Step', 'Paso')}</span>
          <span role="columnheader">{tr('Where', 'Dónde')}</span>
          <span role="columnheader">{tr('Time', 'Tiempo')}</span>
          <span role="columnheader">{tr('Bytes out', 'Bytes enviados')}</span>
        </div>
      </div>
      <div role="rowgroup" className="l-body">
        {rows.map((r) =>
          r.kind === 'group' ? (
            <Group key={r.key} items={r.items} />
          ) : (
            <div role="row" className="l-row" key={r.key}>
              <Cells op={opText(r.e.op)} note={r.e.note} route={r.e.route} ms={r.e.ms} out={r.e.bytesOut} recorded={!!r.e.note?.endsWith('recorded')} />
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
        <dt>{tr('On your device', 'En tu dispositivo')}</dt>
        <dd>{count(local, ['step', 'steps'], ['paso', 'pasos'])} · 0 B</dd>
      </div>
      <div className="cloud">
        <dt>{tr('To the cloud', 'A la nube')}</dt>
        <dd>
          {count(cloud.length, ['call', 'calls'], ['llamada', 'llamadas'])} · {bytes(Math.round(sent))}
        </dd>
      </div>
      <div className={blocked ? 'blocked' : ''}>
        <dt>{tr('Blocked', 'Bloqueados')}</dt>
        <dd>{blocked}</dd>
      </div>
    </dl>
  );
}
