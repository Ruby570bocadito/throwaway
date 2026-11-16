import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { clearTaint, Ledger, type LedgerEntry } from './framework';
import { deviceModelStatus } from './framework/firebase';
import { buildKit, isConfigured } from './kit';
import { TextLab } from './labs/TextLab';
import { PhotoLab } from './labs/PhotoLab';
import { Logo } from './ui/Logo';

type Tab = 'text' | 'photo';

export default function App() {
  const ledger = useMemo(() => new Ledger(), []);
  const { live, kit, backends } = useMemo(() => buildKit(ledger), [ledger]);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  useEffect(() => {
    const off = ledger.subscribe((e) => setEntries([...e]));
    return () => {
      off();
    };
  }, [ledger]);

  const [device, setDevice] = useState('checking');
  useEffect(() => {
    deviceModelStatus().then(setDevice);
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

  const sentOut = entries.reduce((a, e) => a + e.bytesOut, 0);
  const blocked = entries.filter((e) => e.route === 'blocked' && e.op.startsWith('Leak')).length;
  const labProps = { kit, localBackend: backends.local as { prepare?: () => Promise<void> }, degraded, registerLeak };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <Logo />
          <div>
            <h1>throwaway</h1>
            <p className="tag">
              Before you post anonymously, let an AI try to <span className="marker">unmask you</span>.
            </p>
          </div>
        </div>
        <div className="status">
          <span className={`pill ${live ? 'live' : 'demo'}`}>{live ? 'LIVE · Firebase AI Logic' : 'DEMO · recorded model answers'}</span>
          {live ? (
            <a className="pill switch" href="?demo">
              Replay a recorded run
            </a>
          ) : (
            isConfigured() && (
              <a className="pill switch" href={location.pathname}>
                Go live
              </a>
            )
          )}
          <span className={`pill ${degraded || device !== 'available' ? 'warn' : 'ok'}`}>Gemini Nano: {simulateNoNano ? 'off (simulated)' : device}</span>
          <label className="toggle">
            <input
              type="checkbox"
              checked={simulateNoNano}
              onChange={(e) => {
                setSimulateNoNano(e.target.checked);
                reset();
              }}
            />
            Device without Nano
          </label>
        </div>
      </header>

      <nav className="tabs" aria-label="Threats">
        <button className={tab === 'text' ? 'on' : ''} aria-pressed={tab === 'text'} aria-label="Who wrote this? Text, stylometry" onClick={() => switchTab('text')}>
          <span className="tab-q">Who wrote this?</span>
          <span className="tab-s">Text · stylometry</span>
        </button>
        <button className={tab === 'photo' ? 'on' : ''} aria-pressed={tab === 'photo'} aria-label="Where was this taken? Photo, geolocation" onClick={() => switchTab('photo')}>
          <span className="tab-q">Where was this taken?</span>
          <span className="tab-s">Photo · geolocation</span>
        </button>
        <span className="tabs-note">Same framework, different attacker.</span>
      </nav>

      {degraded && (
        <div className="banner">
          <strong>Degraded mode.</strong> No local model on this device, so Throwaway will not analyse or rewrite for you — your original never goes to the
          cloud. {tab === 'text' ? 'Edit the text yourself' : 'Tap the cells you want to mask'}: the attacker only sees what you choose to publish.
          {live && !simulateNoNano && (
            <>
              {' '}
              To see the full on-device flow, <a href="?demo">replay a run recorded with Gemini Nano</a>.
            </>
          )}
        </div>
      )}

      <main className="grid">
        {tab === 'text' ? <TextLab key={labKey} {...labProps} /> : <PhotoLab key={labKey} {...labProps} />}

        <section className="card ledger">
          <div className="card-head">
            <h2>Route ledger</h2>
            <div className="ledger-actions">
              <button
                className="mini"
                onClick={async () => setLeakMsg(leakFn.current ? await leakFn.current() : 'Nothing to leak yet.')}
                aria-describedby="leak-help"
              >
                Try to leak the original
              </button>
              <span className="chip">{blocked ? `${blocked} leak attempt${blocked > 1 ? 's' : ''} blocked` : 'original never left the device'}</span>
            </div>
          </div>
          <p id="leak-help" className="hint">
            Simulates a developer mistake: the private original pushed into a cloud call. The framework refuses it.
          </p>
          {leakMsg && <p className={`leak ${leakMsg.startsWith('Blocked') ? 'good' : 'bad'}`}>{leakMsg}</p>}
          <table>
            <thead>
              <tr>
                <th>Operation</th>
                <th>Where</th>
                <th>ms</th>
                <th>Bytes out</th>
              </tr>
            </thead>
            <tbody>
              {entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="empty">
                    Nothing has run yet. Every step will show up here: where it ran, how long it took and how many bytes left your device.
                  </td>
                </tr>
              )}
              {entries.map((e, i) => (
                <tr key={i}>
                  <td>
                    {e.op} {e.note && <em>· {e.note}</em>}
                  </td>
                  <td>
                    <span className={`route ${e.route}`}>{e.route}</span>
                  </td>
                  <td>{e.ms}</td>
                  <td>{e.bytesOut ? e.bytesOut.toLocaleString('en-US') : '0'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="total">
            Sent to the cloud: {sentOut.toLocaleString('en-US')} bytes — only what you released for publication, plus public data. Private originals cannot
            reach a cloud model: the types forbid it and a run-time guard blocks it.
          </p>
        </section>
      </main>

      <button className="ghost reset" onClick={reset}>
        Reset
      </button>
    </div>
  );
}
