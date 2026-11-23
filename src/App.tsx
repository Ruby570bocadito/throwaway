import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { clearTaint, Ledger, type LedgerEntry } from './framework';
import { deviceModelStatus } from './framework/device';
import { count, lang, num, setLang, tr } from './i18n';
import { buildKit, isConfigured } from './kit';
import { TextLab } from './labs/TextLab';
// The photo lab is not on screen at first: it loads after the first paint, before anyone can click its tab.
const loadPhotoLab = () => import('./labs/PhotoLab');
const PhotoLab = lazy(() => loadPhotoLab().then((m) => ({ default: m.PhotoLab })));
import { Logo } from './ui/Logo';
import { preloadMascot } from './ui/Mascot';
import { LedgerSummary, LedgerTable } from './ui/Ledger';
import type { KeptTexts, LabProps } from './ui/shared';

type Tab = 'text' | 'photo';
type Device = 'checking' | 'available' | 'downloadable' | 'unavailable';

// Without Chrome's Prompt API the answer is known before the first paint, so the degraded notice never pushes the page down.
const firstDeviceGuess = (): Device => ('LanguageModel' in globalThis ? 'checking' : 'unavailable');

/** Bytes, short: the top bar has room for "220 KB", not "220,502 bytes" (the receipt has the exact count). */
const shortBytes = (n: number) => (n < 1000 ? `${n} B` : n < 1_000_000 ? `${Math.round(n / 1000)} KB` : `${num(n / 1_000_000, 1)} MB`);

/** What Chrome says about Gemini Nano, in the menu. */
const DEVICE_WORD: Record<Device, string> = {
  checking: tr('checking', 'comprobando'),
  available: tr('available', 'disponible'),
  downloadable: tr('downloadable', 'se puede descargar'),
  unavailable: tr('unavailable', 'no disponible'),
};

export default function App() {
  const ledger = useMemo(() => new Ledger(), []);
  const { live, kit, backends } = useMemo(() => buildKit(ledger), [ledger]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  useEffect(() => {
    // subscribe() calls back at once with the (empty) ledger: keep the same array so the app does not render twice on load
    const off = ledger.subscribe((e) => setEntries((prev) => (prev.length === 0 && e.length === 0 ? prev : [...e])));
    return () => {
      off();
    };
  }, [ledger]);

  // While Gemini Nano works, nothing may start a second call: Start over, the tabs and the switch wait (21-nov review).
  const [deviceBusy, setDeviceBusy] = useState(false);
  useEffect(() => kit.local.onActivity((busy) => setDeviceBusy(busy)), [kit]);

  // Chrome is asked again on Start over, when you come back to this tab, and after a first step that failed: one slow
  // answer at load (it was 10 s) left a whole visit without Gemini Nano (21-nov review). Never in the middle of a run.
  const [device, setDevice] = useState<Device>(firstDeviceGuess);
  const labStarted = useRef(false);
  const checkSeq = useRef(0);
  const checkDevice = useCallback((timeoutMs?: number) => {
    if (!('LanguageModel' in globalThis)) return;
    const seq = ++checkSeq.current;
    void deviceModelStatus(timeoutMs).then((s) => {
      if (seq !== checkSeq.current) return; // a newer look answers instead
      // A run never switches between "with Gemini Nano" and "without" halfway: that waits for Start over.
      setDevice((prev) => (labStarted.current && (prev === 'unavailable') !== (s === 'unavailable') ? prev : s));
    });
  }, []);
  const onStarted = useCallback(
    (started: boolean) => {
      const was = labStarted.current;
      labStarted.current = started;
      if (was && !started) checkDevice(); // a first step ended without moving on: is Gemini Nano still there?
    },
    [checkDevice],
  );
  useEffect(() => {
    checkDevice(30_000);
    let last = Date.now();
    const lookAgain = () => {
      if (document.visibilityState !== 'visible' || kit.local.busy || labStarted.current || Date.now() - last < 5000) return;
      last = Date.now();
      checkDevice();
    };
    document.addEventListener('visibilitychange', lookAgain);
    window.addEventListener('focus', lookAgain);
    // Fetch the photo lab once the page has settled and the browser is idle (or as soon as someone reaches for its tab).
    const t = setTimeout(() => {
      const later = () => {
        void loadPhotoLab();
        preloadMascot();
      };
      if ('requestIdleCallback' in window) requestIdleCallback(later, { timeout: 4000 });
      else later();
    }, 3000);
    return () => {
      clearTimeout(t);
      document.removeEventListener('visibilitychange', lookAgain);
      window.removeEventListener('focus', lookAgain);
    };
  }, [kit, checkDevice]);

  // "Check a photo" on the landing page opens /app/?photo.
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).has('photo') ? 'photo' : 'text'));
  const [simulateNoNano, setSimulateNoNano] = useState(false);
  // Live on a device without Gemini Nano (e.g. most Android phones): degrade, never fall back to the cloud with private data.
  const degraded = simulateNoNano || (live && device === 'unavailable');
  const [labKey, setLabKey] = useState(0);
  const [leakMsg, setLeakMsg] = useState('');
  const leakFn = useRef<(() => Promise<string>) | null>(null);
  const registerLeak = useCallback((fn: (() => Promise<string>) | null) => {
    leakFn.current = fn;
  }, []);
  // Each lab renders its next action into this element (a portal), at the end of the step, next to "Start over". It
  // exists from the first render, so the labs can portal into it at once (state set from a ref would render twice).
  const [dock] = useState(() => {
    const el = document.createElement('div');
    el.className = 'dock-slot';
    return el;
  });
  const mountDock = useCallback(
    (host: HTMLDivElement | null) => {
      if (host) host.appendChild(dock);
    },
    [dock],
  );

  // Your post and your public writing survive "Start over", the Gemini Nano switch and a change of tab: the switch wiped a
  // tester's pasted post, and "Start over to add yours" would have too (17-nov). In memory only: a reload clears them.
  const kept = useRef<KeptTexts | null>(null);
  const keep = useCallback((texts: KeptTexts) => {
    kept.current = texts;
  }, []);
  const reset = () => {
    if (kit.local.busy) return; // Gemini Nano is still on a step; the buttons that lead here are held meanwhile
    ledger.clear();
    clearTaint();
    setLeakMsg('');
    labStarted.current = false;
    setLabKey((k) => k + 1);
    checkDevice();
  };
  // Start over with your post kept and the box for your public writing open: without writing of your own, a tester could
  // not find where to add it, four rounds running (17-nov).
  const addWriting = () => {
    kept.current = { draft: kept.current?.draft ?? '', ownPublic: kept.current?.ownPublic ?? '', openOwn: true };
    reset();
  };
  const switchTab = (t: Tab) => {
    if (t !== tab && !kit.local.busy) {
      setTab(t);
      reset();
    }
  };

  // The receipt: a sheet over the page, opened from its count in the top bar (it was a card under everything, 21-nov plan).
  const sheet = useRef<HTMLDialogElement>(null);
  const receiptButton = useRef<HTMLButtonElement>(null);

  const blocked = entries.filter((e) => e.route === 'blocked' && e.op.startsWith('Leak')).length;
  const sentAsIs = entries.some((e) => e.note?.includes('sent as-is by your choice'));
  const sentOut = entries.reduce((a, e) => a + e.bytesOut, 0);
  // Split by version: two testers read "your original" in the total as if it had left again after their edit (17-nov).
  const asIsBytes = entries.filter((e) => e.note?.includes('sent as-is by your choice')).reduce((a, e) => a + e.bytesOut, 0);
  const releasedBytes = sentOut - asIsBytes;
  const fmt = (n: number) => num(n);
  const status = blocked ? 'blocked' : sentAsIs ? 'asis' : 'private';
  const statusText = blocked
    ? count(blocked, ['leak attempt blocked', 'leak attempts blocked'], ['intento de filtración bloqueado', 'intentos de filtración bloqueados'])
    : sentAsIs
      ? tr('original sent only for your as-is test', 'el original solo se ha enviado para tu prueba tal cual')
      : tr('original never left the device', 'el original no ha salido del dispositivo');
  const labProps: LabProps = {
    kit,
    localBackend: backends.local as LabProps['localBackend'],
    degraded,
    registerLeak,
    recorded: !live,
    dock,
    kept: kept.current,
    keep,
    addWriting,
    onStarted,
  };
  const held = deviceBusy ? tr('Gemini Nano is finishing a step on your device', 'Gemini Nano está terminando un paso en tu dispositivo') : undefined;
  // "off (simulated)" meant nothing to a tester (17-nov).
  const nano = simulateNoNano ? tr('off for this test', 'desactivado para esta prueba') : DEVICE_WORD[device];

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/" aria-label={tr('Throwaway home: what it is and how it works', 'Inicio de Throwaway: qué es y cómo funciona')}>
            <Logo size={28} />
            <span className="wordmark">throwaway</span>
          </a>
          <nav className="seg" aria-label={tr('What to check', 'Qué revisar')}>
            <button aria-pressed={tab === 'text'} onClick={() => switchTab('text')} disabled={deviceBusy} title={held}>
              <TextIcon />
              {tr('Check a post', 'Revisar un post')}
            </button>
            <button
              aria-pressed={tab === 'photo'}
              onClick={() => switchTab('photo')}
              disabled={deviceBusy}
              title={held}
              onPointerEnter={() => void loadPhotoLab()}
              onFocus={() => void loadPhotoLab()}
            >
              <PinIcon />
              {tr('Check a photo', 'Revisar una foto')}
            </button>
          </nav>
          <div className="topbar-end">
            {/* "Recorded run" left two testers asking whether the AI was real (22-nov). */}
            <span
              className={`mode-badge ${live ? 'live' : 'demo'}`}
              title={
                live
                  ? tr('Live: Gemini Nano on this device, Gemini in the cloud', 'En vivo: Gemini Nano en este dispositivo, Gemini en la nube')
                  : tr(
                      'Real runs in Chrome, replayed: the AI answers were recorded between 15 and 23 November; nothing is sent, and everything else runs in this tab',
                      'Revisiones reales en Chrome, repetidas: las respuestas de la IA se grabaron entre el 15 y el 23 de noviembre; no se envía nada, y todo lo demás funciona en esta pestaña',
                    )
              }
            >
              <i className="dot" aria-hidden="true" />
              {live ? tr('Live', 'En vivo') : tr('Demo: a recorded run', 'Demo: una revisión grabada')}
            </span>
            {/* Before anything is sent it says so in words, not "Sent to the cloud 0 B" (22-nov). */}
            <button
              ref={receiptButton}
              className={`receipt-button ${status}`}
              onClick={() => sheet.current?.showModal()}
              aria-haspopup="dialog"
            >
              <i className="dot" aria-hidden="true" />
              {/* A replay sends nothing: "Sent to the cloud 44 KB" in the recorded demo contradicted "nothing is sent" (the judge
                  and four testers, round 6, 23-nov). The receipt says what the real run sent. */}
              {!live ? (
                <>
                  <span className="receipt-word">{tr('Nothing sent: a recorded run', 'Nada enviado: revisión grabada')}</span>
                  <span className="receipt-short">{tr('Nothing sent', 'Nada enviado')}</span>
                </>
              ) : sentOut === 0 ? (
                <>
                  <span className="receipt-word">{tr('Nothing sent yet', 'Aún no se ha enviado nada')}</span>
                  <span className="receipt-short">{tr('Nothing sent', 'Nada enviado')}</span>
                </>
              ) : (
                <>
                  <span className="receipt-word">{tr('Sent to the cloud', 'Enviado a la nube')}</span>
                  <span className="receipt-num">{shortBytes(sentOut)}</span>
                </>
              )}
              {/* The name read aloud starts with the words on screen, whichever fit (WCAG 2.5.3; Lighthouse, 22-nov), then says
                  what the button opens. */}
              <span className="sr-only">{tr(` · receipt, ${statusText}`, ` · recibo, ${statusText}`)}</span>
            </button>
            <Menu
              live={live}
              nano={nano}
              degraded={degraded}
              device={device}
              simulateNoNano={simulateNoNano}
              held={held}
              deviceBusy={deviceBusy}
              onSimulate={(on) => {
                setSimulateNoNano(on);
                reset();
              }}
            />
          </div>
        </div>
      </header>

      <main className={`main ${tab}-lab`}>
        {degraded && (
          // What still runs and what does not: "will not analyse" next to a scan button confused two testers (16-nov).
          <p className="notice mode-note">
            <span>
              <strong>{tr('No on-device AI here.', 'Sin IA en este dispositivo.')}</strong>{' '}
              {tab === 'text'
                ? tr(
                    'Throwaway checks your habits, counts, dates and capitalised names with fixed rules; you rewrite the style.',
                    'Throwaway revisa con reglas fijas tus hábitos, cifras, fechas y nombres con mayúscula; el estilo lo reescribes tú.',
                  )
                : tr(
                    'Throwaway cannot look for clues in your photo: you tap the cells to hide.',
                    'Throwaway no puede buscar pistas en tu foto: tú tocas las casillas que quieras difuminar.',
                  )}{' '}
              {tr('Nothing goes to the cloud unless you choose to test it.', 'No se envía nada a la nube salvo que decidas probarlo.')}
              {live && !simulateNoNano && (
                <>
                  {' '}
                  <a href="?demo">{tr('Replay a run recorded with Gemini Nano', 'Ver una revisión grabada con Gemini Nano')}</a>.
                </>
              )}
            </span>
          </p>
        )}
        {tab === 'text' ? (
          <TextLab key={labKey} {...labProps} />
        ) : (
          <Suspense
            fallback={
              <p className="lab-loading">
                <span className="spinner" aria-hidden="true" /> {tr('Opening the photo check…', 'Abriendo la revisión de fotos…')}
              </p>
            }
          >
            <PhotoLab key={labKey} {...labProps} />
          </Suspense>
        )}

        <div className="actions" role="region" aria-label={tr('Next step', 'Siguiente paso')}>
          <div className="dock-host" ref={mountDock} />
          <button className="ghost restart" onClick={reset} disabled={deviceBusy} title={held}>
            <RestartIcon />
            <span className="restart-label">{tr('Start over', 'Empezar de nuevo')}</span>
          </button>
        </div>
      </main>

      <dialog
        ref={sheet}
        className="sheet"
        aria-labelledby="ledger-title"
        onClose={() => receiptButton.current?.focus()}
        onClick={(e) => e.target === e.currentTarget && sheet.current?.close()}
      >
        <div className="sheet-body">
          <header className="sheet-head">
            <div>
              <h2 id="ledger-title">{tr('What left your device', 'Qué ha salido de tu dispositivo')}</h2>
              <span className={`chip ${status}`}>{statusText}</span>
            </div>
            <button className="icon-button" onClick={() => sheet.current?.close()} aria-label={tr('Close the receipt', 'Cerrar el recibo')}>
              <CloseIcon />
            </button>
          </header>
          <LedgerSummary entries={entries} replay={!live} />
          {/* "· recorded" on every model step read as a fake to a judge, without a word on what is replayed (17-nov). */}
          {!live && (
            <p className="hint">
              {tr(
                'Recorded run: Gemini’s answers are replayed from real runs in Chrome (15 to 23 November), so nothing leaves this tab; the bytes below are what the real run sent. The fingerprint, the fixed rules, the privacy guard, the shuffled lineups and this receipt run live, in this tab.',
                'Revisión grabada: las respuestas de Gemini vienen de revisiones reales en Chrome (del 15 al 23 de noviembre) y se reproducen aquí, así que nada sale de esta pestaña; los bytes de abajo son los que envió la revisión real. La huella de escritura, las reglas fijas, la protección de privacidad, el orden al azar de las personas y este recibo funcionan en vivo, en esta pestaña.',
              )}
            </p>
          )}
          {entries.length === 0 ? (
            <div className="ledger-empty">
              <img src="/brand/mascara-112.webp" width="48" height="48" alt="" loading="lazy" />
              <p>
                {tr(
                  'Nothing has run yet. Every step will show up here: where it ran, how long it took and how many bytes left your device.',
                  'Aún no se ha hecho nada. Cada paso aparecerá aquí: dónde se hizo, cuánto tardó y cuántos bytes salieron de tu dispositivo.',
                )}
              </p>
            </div>
          ) : (
            <LedgerTable entries={entries} />
          )}
          {/* A replay sends nothing: "sent" next to "nothing is sent" read as a contradiction to a judge (22-nov). */}
          <p className="total">
            {live ? tr('Sent to the cloud', 'Enviado a la nube') : tr('In the real run this replays, sent to the cloud', 'En la revisión real que se reproduce aquí, enviado a la nube')}:{' '}
            {fmt(sentOut)} bytes,{' '}
            {sentAsIs
              ? tr(
                  `${fmt(asIsBytes)} for the as-is test of your original that you chose${releasedBytes > 0 ? ` and ${fmt(releasedBytes)} for the version you released` : ''}.${
                    tab === 'text' ? ' Each attack also sends the public texts of the other writers.' : ''
                  } Without that choice, private originals cannot reach a cloud model: the types forbid it and a run-time guard blocks it.`,
                  `${fmt(asIsBytes)} para probar tu original tal cual, por decisión tuya${releasedBytes > 0 ? `, y ${fmt(releasedBytes)} para la versión que publicarías` : ''}.${
                    tab === 'text' ? ' Cada prueba envía también los textos públicos de las otras personas.' : ''
                  } Sin esa decisión, los originales privados no pueden llegar a un modelo en la nube: los tipos del código lo prohíben y una protección lo bloquea al ejecutarse.`,
                )
              : tr(
                  'only what you released for publication, plus public data. Private originals cannot reach a cloud model: the types forbid it and a run-time guard blocks it.',
                  'solo la versión que publicarías, más datos públicos. Los originales privados no pueden llegar a un modelo en la nube: los tipos del código lo prohíben y una protección lo bloquea al ejecutarse.',
                )}
          </p>
          {/* What happens to it there, in Google's own terms for the free plan (22-nov): the reason the original is never sent. */}
          {live && (
            <p className="hint">
              {tr(
                'Tests run on Gemini’s free plan: Google may use what is sent to improve its products, and people may review it. That is why only the version you would post is sent, never your original: what Google sees is what everyone will see once you post it.',
                'Las pruebas usan el plan gratuito de Gemini: Google puede usar lo que se envía para mejorar sus productos, y una persona puede revisarlo. Por eso solo se envía la versión que publicarías, nunca tu original: lo que ve Google es lo que verá todo el mundo cuando lo publiques.',
              )}
            </p>
          )}
          {/* A proof for developers and judges, not a step for someone checking a post (review, 16-nov). */}
          <details className="disclosure devtools">
            <summary>{tr('For developers: try to break it', 'Para desarrolladores: intenta romperlo')}</summary>
            <div className="disclosure-body">
              <p id="leak-help" className="hint">
                {tr(
                  'Simulates a developer mistake: the private original pushed into a cloud call. The framework refuses it, and the attempt shows up in this receipt.',
                  'Simula un error de programación: el original privado metido en una llamada a la nube. Throwaway lo rechaza, y el intento aparece en este recibo.',
                )}
              </p>
              <button
                className="mini"
                onClick={async () => setLeakMsg(leakFn.current ? await leakFn.current() : tr('Nothing to leak yet.', 'Aún no hay nada que filtrar.'))}
                aria-describedby="leak-help"
              >
                {tr('Try to leak the original', 'Intentar filtrar el original')}
              </button>
              {/* The labs' blocked message starts with "Blocked", or with "Bloqueado" in Spanish. */}
              {leakMsg && (
                <p className={`leak ${/^(Blocked|Bloqueado)/.test(leakMsg) ? 'good' : 'bad'}`} role="status">
                  {leakMsg}
                </p>
              )}
            </div>
          </details>
        </div>
      </dialog>
    </div>
  );
}

/** Settings and help, out of the way: the mode, Gemini Nano, the switch to test without it (21-nov plan: a menu). */
function Menu({
  live,
  nano,
  degraded,
  device,
  simulateNoNano,
  held,
  deviceBusy,
  onSimulate,
}: {
  live: boolean;
  nano: string;
  degraded: boolean;
  device: Device;
  simulateNoNano: boolean;
  held?: string;
  deviceBusy: boolean;
  onSimulate: (on: boolean) => void;
}) {
  const menu = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (menu.current?.open && !menu.current.contains(e.target as Node)) menu.current.open = false;
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !menu.current?.open) return;
      menu.current.open = false;
      menu.current.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', escape);
    };
  }, []);
  // The other language. A link styled like the items around it (a button would take the page's navy button style): a
  // click switches with setLang, which remembers the choice and reloads the page as it is; a new tab gets it from the address.
  const other = lang === 'es' ? 'en' : 'es';
  const otherHref = new URL(location.href);
  otherHref.searchParams.set('lang', other);
  return (
    <details className="menu" ref={menu}>
      <summary aria-label={tr('Settings and help', 'Ajustes y ayuda')}>
        <DotsIcon />
      </summary>
      <div className="menu-panel">
        <p className={`menu-status ${live ? 'live' : 'demo'}`}>
          <i className="dot" aria-hidden="true" />
          {live ? tr('Live · Firebase AI Logic', 'En vivo · Firebase AI Logic') : tr('Recorded run: replayed answers', 'Revisión grabada: respuestas reproducidas')}
        </p>
        {live ? (
          <a className="menu-item" href="?demo">
            {tr('Replay a recorded run', 'Ver una revisión grabada')}
          </a>
        ) : (
          isConfigured() && (
            <a className="menu-item" href={location.pathname}>
              {tr('Go live', 'Usar en vivo')}
            </a>
          )
        )}
        <div className="menu-sep" />
        <p className={`menu-status ${degraded || device !== 'available' ? 'warn' : 'ok'}`}>
          <i className="dot" aria-hidden="true" />
          Gemini Nano: {nano}
        </p>
        <label className="switch menu-item">
          <input type="checkbox" role="switch" checked={simulateNoNano} disabled={deviceBusy} title={held} onChange={(e) => onSimulate(e.target.checked)} />
          <span className="switch-track" aria-hidden="true" />
          {tr('Try it without Gemini Nano', 'Probar sin Gemini Nano')}
        </label>
        <div className="menu-sep" />
        <a className="menu-item" href={lang === 'es' ? '/es/#how' : '/#how'}>
          {tr('How it works', 'Cómo funciona')}
        </a>
        <a
          className="menu-item"
          href={otherHref.toString()}
          hrefLang={other}
          lang={other}
          onClick={(e) => {
            if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // a new tab or window: the address says it
            e.preventDefault();
            setLang(other);
          }}
        >
          {other === 'es' ? 'Español' : 'English'}
        </a>
      </div>
    </details>
  );
}

const icon = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const TextIcon = () => (
  <svg {...icon}>
    <path d="M3 4h10M3 8h10M3 12h6" />
  </svg>
);
const PinIcon = () => (
  <svg {...icon}>
    <path d="M8 14s4.5-4.1 4.5-7.6a4.5 4.5 0 0 0-9 0C3.5 9.9 8 14 8 14z" />
    <circle cx="8" cy="6.4" r="1.6" />
  </svg>
);
const RestartIcon = () => (
  <svg {...icon}>
    <path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.8h2.8" />
  </svg>
);
const CloseIcon = () => (
  <svg {...icon}>
    <path d="M4 4l8 8M12 4l-8 8" />
  </svg>
);
const DotsIcon = () => (
  <svg {...icon} stroke="none" fill="currentColor">
    <circle cx="3.5" cy="8" r="1.4" />
    <circle cx="8" cy="8" r="1.4" />
    <circle cx="12.5" cy="8" r="1.4" />
  </svg>
);
