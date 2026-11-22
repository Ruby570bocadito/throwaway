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
import { preloadMascot } from './ui/Mascot';
import { LedgerSummary, LedgerTable } from './ui/Ledger';
import type { KeptTexts, LabProps } from './ui/shared';

type Tab = 'text' | 'photo';
type Device = 'checking' | 'available' | 'downloadable' | 'unavailable';

// Without Chrome's Prompt API the answer is known before the first paint, so the degraded notice never pushes the page down.
const firstDeviceGuess = (): Device => ('LanguageModel' in globalThis ? 'checking' : 'unavailable');

/** Bytes, short: the top bar has room for "220 KB", not "220,502 bytes" (the receipt has the exact count). */
const shortBytes = (n: number) => (n < 1000 ? `${n} B` : n < 1_000_000 ? `${Math.round(n / 1000)} KB` : `${(n / 1_000_000).toFixed(1)} MB`);

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
  const fmt = (n: number) => n.toLocaleString('en-US');
  const status = blocked ? 'blocked' : sentAsIs ? 'asis' : 'private';
  const statusText = blocked
    ? `${blocked} leak attempt${blocked > 1 ? 's' : ''} blocked`
    : sentAsIs
      ? 'original sent only for your as-is test'
      : 'original never left the device';
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
  const held = deviceBusy ? 'Gemini Nano is finishing a step on your device' : undefined;
  // "off (simulated)" meant nothing to a tester (17-nov).
  const nano = simulateNoNano ? 'off for this test' : device;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="/" aria-label="Throwaway home: what it is and how it works">
            <Logo size={28} />
            <span className="wordmark">throwaway</span>
          </a>
          <nav className="seg" aria-label="What to check">
            <button aria-pressed={tab === 'text'} onClick={() => switchTab('text')} disabled={deviceBusy} title={held}>
              <TextIcon />
              Who wrote this?
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
              Where was it taken?
            </button>
          </nav>
          <div className="topbar-end">
            {/* "Recorded run" left two testers asking whether the AI was real (22-nov). */}
            <span
              className={`mode-badge ${live ? 'live' : 'demo'}`}
              title={live ? 'Live: Gemini Nano on this device, Gemini in the cloud' : 'A real run in Chrome, replayed: the AI answers were recorded on 15–16 November; everything else runs live in this tab'}
            >
              <i className="dot" aria-hidden="true" />
              {live ? 'Live' : 'Demo: a real run, replayed'}
            </span>
            <button
              ref={receiptButton}
              className={`receipt-button ${status}`}
              onClick={() => sheet.current?.showModal()}
              aria-haspopup="dialog"
              aria-label={`Receipt: ${shortBytes(sentOut)} sent to the cloud, ${statusText}`}
            >
              <i className="dot" aria-hidden="true" />
              <span className="receipt-word">Sent to the cloud</span>
              <span className="receipt-num">{shortBytes(sentOut)}</span>
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
              <strong>No on-device AI here.</strong>{' '}
              {tab === 'text'
                ? 'Throwaway checks your habits, counts, dates and capitalised names with fixed rules; you rewrite the style.'
                : 'Throwaway cannot look for clues in your photo: you tap the cells to hide.'}{' '}
              Nothing goes to the cloud unless you choose to test it.
              {live && !simulateNoNano && (
                <>
                  {' '}
                  <a href="?demo">Replay a run recorded with Gemini Nano</a>.
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
                <span className="spinner" aria-hidden="true" /> Opening the photo lab…
              </p>
            }
          >
            <PhotoLab key={labKey} {...labProps} />
          </Suspense>
        )}

        <div className="actions" role="region" aria-label="Next step">
          <div className="dock-host" ref={mountDock} />
          <button className="ghost restart" onClick={reset} disabled={deviceBusy} title={held}>
            <RestartIcon />
            <span className="restart-label">Start over</span>
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
              <h2 id="ledger-title">What left your device</h2>
              <span className={`chip ${status}`}>{statusText}</span>
            </div>
            <button className="icon-button" onClick={() => sheet.current?.close()} aria-label="Close the receipt">
              <CloseIcon />
            </button>
          </header>
          <LedgerSummary entries={entries} />
          {/* "· recorded" on every model step read as a fake to a judge, without a word on what is replayed (17-nov). */}
          {!live && (
            <p className="hint">
              Recorded run: Gemini’s answers are replayed from real runs in Chrome (15–16 November), so nothing leaves this tab; the bytes below are what the
              real run sent. The fingerprint, the fixed rules, the privacy guard, the shuffled lineups and this receipt run live, in this tab.
            </p>
          )}
          {entries.length === 0 ? (
            <div className="ledger-empty">
              <img src="/brand/mascara-112.webp" width="48" height="48" alt="" loading="lazy" />
              <p>Nothing has run yet. Every step will show up here: where it ran, how long it took and how many bytes left your device.</p>
            </div>
          ) : (
            <LedgerTable entries={entries} />
          )}
          {/* A replay sends nothing: "sent" next to "nothing is sent" read as a contradiction to a judge (22-nov). */}
          <p className="total">
            {live ? 'Sent to the cloud' : 'In the real run this replays, sent to the cloud'}: {fmt(sentOut)} bytes,{' '}
            {sentAsIs
              ? `${fmt(asIsBytes)} for the as-is test of your original that you chose${releasedBytes > 0 ? ` and ${fmt(releasedBytes)} for the version you released` : ''}.${
                  tab === 'text' ? ' Each attack also sends the public texts of the other writers.' : ''
                } Without that choice, private originals cannot reach a cloud model: the types forbid it and a run-time guard blocks it.`
              : 'only what you released for publication, plus public data. Private originals cannot reach a cloud model: the types forbid it and a run-time guard blocks it.'}
          </p>
          {/* What happens to it there, in Google's own terms for the free plan (22-nov): the reason the original is never sent. */}
          {live && (
            <p className="hint">
              Tests run on Gemini’s free plan: Google may use what is sent to improve its products, and people may review it. That is why only the version you
              would post is sent, never your original.
            </p>
          )}
          {/* A proof for developers and judges, not a step for someone checking a post (review, 16-nov). */}
          <details className="disclosure devtools">
            <summary>For developers: try to break it</summary>
            <div className="disclosure-body">
              <p id="leak-help" className="hint">
                Simulates a developer mistake: the private original pushed into a cloud call. The framework refuses it, and the attempt shows up in this
                receipt.
              </p>
              <button className="mini" onClick={async () => setLeakMsg(leakFn.current ? await leakFn.current() : 'Nothing to leak yet.')} aria-describedby="leak-help">
                Try to leak the original
              </button>
              {leakMsg && (
                <p className={`leak ${leakMsg.startsWith('Blocked') ? 'good' : 'bad'}`} role="status">
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
  return (
    <details className="menu" ref={menu}>
      <summary aria-label="Settings and help">
        <DotsIcon />
      </summary>
      <div className="menu-panel">
        <p className={`menu-status ${live ? 'live' : 'demo'}`}>
          <i className="dot" aria-hidden="true" />
          {live ? 'Live · Firebase AI Logic' : 'Recorded run: replayed answers'}
        </p>
        {live ? (
          <a className="menu-item" href="?demo">
            Replay a recorded run
          </a>
        ) : (
          isConfigured() && (
            <a className="menu-item" href={location.pathname}>
              Go live
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
          Try it without Gemini Nano
        </label>
        <div className="menu-sep" />
        <a className="menu-item" href="/#how">
          How it works
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
