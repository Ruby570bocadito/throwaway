import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { clearTaint, Ledger, type LedgerEntry } from './framework';
import { deviceModelStatus } from './framework/device';
import { buildKit, isConfigured } from './kit';
import { TextLab } from './labs/TextLab';
// The photo lab is not on screen at first: it loads after the first paint, before anyone can click its tab.
const loadPhotoLab = () => import('./labs/PhotoLab');
const PhotoLab = lazy(() => loadPhotoLab().then((m) => ({ default: m.PhotoLab })));
import { Logo } from './ui/Logo';
import { LedgerSummary, LedgerTable } from './ui/Ledger';
import type { LabProps } from './ui/shared';

type Tab = 'text' | 'photo';
type Device = 'checking' | 'available' | 'downloadable' | 'unavailable';

// Without Chrome's Prompt API the answer is known before the first paint, so the degraded notice never pushes the page down.
const firstDeviceGuess = (): Device => ('LanguageModel' in globalThis ? 'checking' : 'unavailable');

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

  const [device, setDevice] = useState<Device>(firstDeviceGuess);
  useEffect(() => {
    deviceModelStatus().then(setDevice);
    // Fetch the photo lab once the page has settled and the browser is idle (or as soon as someone reaches for its tab).
    const t = setTimeout(() => {
      if ('requestIdleCallback' in window) requestIdleCallback(() => void loadPhotoLab(), { timeout: 4000 });
      else void loadPhotoLab();
    }, 3000);
    return () => clearTimeout(t);
  }, []);

  const [tab, setTab] = useState<Tab>('text');
  const [simulateNoNano, setSimulateNoNano] = useState(false);
  // Live on a device without Gemini Nano (e.g. most Android phones): degrade, never fall back to the cloud with private data.
  const degraded = simulateNoNano || (live && device === 'unavailable');
  const [labKey, setLabKey] = useState(0);
  const [leakMsg, setLeakMsg] = useState('');
  const leakFn = useRef<(() => Promise<string>) | null>(null);
  const registerLeak = useCallback((fn: (() => Promise<string>) | null) => {
    leakFn.current = fn;
  }, []);
  // The dock at the bottom of the screen: each lab renders its next action there (a portal), next to "Start over". The
  // element exists from the first render, so the labs can portal into it at once (state set from a ref would render twice).
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

  const reset = () => {
    ledger.clear();
    clearTaint();
    setLeakMsg('');
    setLabKey((k) => k + 1);
  };
  const switchTab = (t: Tab) => {
    if (t !== tab) {
      setTab(t);
      reset();
    }
  };

  const blocked = entries.filter((e) => e.route === 'blocked' && e.op.startsWith('Leak')).length;
  const sentAsIs = entries.some((e) => e.note?.includes('sent as-is by your choice'));
  const sentOut = entries.reduce((a, e) => a + e.bytesOut, 0);
  const labProps: LabProps = {
    kit,
    localBackend: backends.local as LabProps['localBackend'],
    degraded,
    registerLeak,
    recorded: !live,
    dock,
  };
  const nano = simulateNoNano ? 'off (simulated)' : device;

  return (
    <div className="app">
      <header className="appbar">
        <a className="brand" href="/" aria-label="Throwaway home: what it is and how it works">
          <Logo size={36} />
          <span className="wordmark">throwaway</span>
        </a>
        <span className={`mode ${live ? 'live' : 'demo'}`}>
          <i className="dot" aria-hidden="true" />
          {live ? (
            <>
              Live<span className="mode-more"> · Firebase AI Logic</span>
            </>
          ) : (
            'Recorded run'
          )}
        </span>
        <nav className="appnav" aria-label="Mode and help">
          {live ? (
            <a href="?demo">Replay a recorded run</a>
          ) : (
            isConfigured() && <a href={location.pathname}>Go live</a>
          )}
          <a href="/#how">How it works</a>
        </nav>
      </header>

      <div className="intro">
        <h1>
          Before you post anonymously, let an AI try to <span className="marker">unmask you</span>.
        </h1>
        <div className="device-row">
          <span className={`nano ${degraded || device !== 'available' ? 'warn' : 'ok'}`}>
            <i className="dot" aria-hidden="true" />
            Gemini Nano: {nano}
          </span>
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              checked={simulateNoNano}
              onChange={(e) => {
                setSimulateNoNano(e.target.checked);
                reset();
              }}
            />
            <span className="switch-track" aria-hidden="true" />
            Try it without Gemini Nano
          </label>
        </div>
      </div>

      <nav className="tabs" aria-label="Threats">
        <button className={tab === 'text' ? 'on' : ''} aria-pressed={tab === 'text'} aria-label="Who wrote this? Text, stylometry" onClick={() => switchTab('text')}>
          <img src="/brand/huella-72.webp" width="36" height="36" alt="" />
          <span className="tab-text">
            <span className="tab-q">Who wrote this?</span>
            <span className="tab-s">Text · stylometry</span>
          </span>
        </button>
        <button
          className={tab === 'photo' ? 'on' : ''}
          aria-pressed={tab === 'photo'}
          aria-label="Where was this taken? Photo, geolocation"
          onClick={() => switchTab('photo')}
          onPointerEnter={() => void loadPhotoLab()}
          onFocus={() => void loadPhotoLab()}
        >
          <img src="/brand/pin-72.webp" width="36" height="36" alt="" />
          <span className="tab-text">
            <span className="tab-q">Where was this taken?</span>
            <span className="tab-s">Photo · geolocation</span>
          </span>
        </button>
        <span className="tabs-note">Same framework, different attacker.</span>
      </nav>

      {degraded && (
        <div className="banner">
          {/* Says what still runs and what does not: "will not analyse" next to a scan button confused two testers (16-nov). */}
          <p>
            <strong>No local model on this device.</strong>{' '}
            {tab === 'text'
              ? 'Throwaway can still check your writing habits, counts and dates, but not names, places or companies, and it cannot rewrite for you: edit the text yourself.'
              : 'Throwaway cannot look for clues in your photo: tap the cells you want to mask.'}{' '}
            Nothing goes to the cloud unless you choose to test it.
            {live && !simulateNoNano && (
              <>
                {' '}
                To see the full on-device flow, <a href="?demo">replay a run recorded with Gemini Nano</a>.
              </>
            )}
          </p>
        </div>
      )}

      <main className="grid">
        {tab === 'text' ? (
          <TextLab key={labKey} {...labProps} />
        ) : (
          <Suspense
            fallback={
              <p className="lab-loading">
                <span className="spinner" aria-hidden="true" /> Opening the photo lab…
              </p>
            }
          >
            <PhotoLab key={labKey} {...labProps} />
          </Suspense>
        )}

        <div className="dock" role="region" aria-label="Next step">
          <div className="dock-inner">
            <div className="dock-host" ref={mountDock} />
            <button className="ghost restart" onClick={reset} aria-label="Start over">
              <span aria-hidden="true">↺</span>
              <span className="restart-label">Start over</span>
            </button>
          </div>
        </div>

        <section className="card ledger" aria-labelledby="ledger-title">
          <div className="card-head">
            <div>
              <p className="kicker">Receipt · route ledger</p>
              <h2 id="ledger-title">What left your device</h2>
            </div>
            <span className={`chip ${blocked ? 'blocked' : sentAsIs ? 'asis' : 'private'}`}>
              {blocked ? `${blocked} leak attempt${blocked > 1 ? 's' : ''} blocked` : sentAsIs ? 'original sent only for your as-is test' : 'original never left the device'}
            </span>
          </div>
          <LedgerSummary entries={entries} />
          {/* A proof for developers and judges, not a step for someone checking a post (review, 16-nov). */}
          <details className="devtools">
            <summary>For developers: try to break it</summary>
            <p id="leak-help" className="hint">
              Simulates a developer mistake: the private original pushed into a cloud call. The framework refuses it, and the attempt shows up in the ledger.
            </p>
            <button className="mini" onClick={async () => setLeakMsg(leakFn.current ? await leakFn.current() : 'Nothing to leak yet.')} aria-describedby="leak-help">
              Try to leak the original
            </button>
            {leakMsg && (
              <p className={`leak ${leakMsg.startsWith('Blocked') ? 'good' : 'bad'}`} role="status">
                {leakMsg}
              </p>
            )}
          </details>
          {entries.length === 0 ? (
            <div className="ledger-empty">
              <img src="/brand/mascara-112.webp" width="56" height="56" alt="" loading="lazy" />
              <p>Nothing has run yet. Every step will show up here: where it ran, how long it took and how many bytes left your device.</p>
            </div>
          ) : (
            <LedgerTable entries={entries} />
          )}
          <p className="total">
            Sent to the cloud: {sentOut.toLocaleString('en-US')} bytes —{' '}
            {sentAsIs
              ? 'your original, because you chose to test it as is, plus what you released for publication and public data. Without that choice, private originals cannot reach a cloud model: the types forbid it and a run-time guard blocks it.'
              : 'only what you released for publication, plus public data. Private originals cannot reach a cloud model: the types forbid it and a run-time guard blocks it.'}
          </p>
        </section>
      </main>
    </div>
  );
}
