import { useEffect, useRef, useState } from 'react';
import { PrivacyViolation, release, secret, type Private, type Publishable } from '../framework';
import { browserImageOps, normalizeToPng, svgToPng } from '../engine/image';
import { DEMO_TRUTH, SCENE_H, SCENE_SVG, SCENE_W } from '../demo/photo';
import { GRID, isIdentifier, locationThreat, type LocationVerdict, type PhotoClue } from '../threats/location';
import { Radar } from '../ui/Radar';
import { formatKm, friendlyError, type LabProps } from '../ui/shared';

type Stage = 'loading' | 'photo' | 'scanned' | 'attacked' | 'masked' | 'safe';

function useObjectUrl(bytes: Uint8Array | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bytes) return;
    const u = URL.createObjectURL(new Blob([bytes.slice()], { type: 'image/png' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [bytes]);
  return url;
}

export function PhotoLab({ kit, localBackend, degraded, registerLeak, recorded }: LabProps) {
  const [stage, setStage] = useState<Stage>('loading');
  const [original, setOriginal] = useState<Uint8Array | null>(null);
  const [published, setPublished] = useState<Publishable<Uint8Array> | null>(null);
  const [clues, setClues] = useState<PhotoClue[]>([]);
  const [verdict, setVerdict] = useState<LocationVerdict | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [manual, setManual] = useState<number[]>([]);
  // "Attack it as I would post it" sends the photo as it is: the user's choice, and the chip says so.
  const [sentAsIs, setSentAsIs] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const privatePhoto = useRef<Private<Uint8Array> | null>(null);
  // The user's real location: private, only used on the device to score each attack. In the demo it is the scene's.
  const [source, setSource] = useState<'demo' | 'own'>('demo');
  const [truthLabel, setTruthLabel] = useState('Palma (where the demo scene is set)');
  const [threat, setThreat] = useState(() => locationThreat({ ops: browserImageOps, truth: secret(DEMO_TRUTH, 'your real location') }));
  const fileInput = useRef<HTMLInputElement>(null);

  /**
   * Testing and recording: `#truth=<lat>,<lon>` in the address sets your real location for an own photo, so a demo can
   * be recorded without showing where you live. A URL fragment never reaches a server.
   */
  function truthFromHash(): { lat: number; lon: number } | null {
    const m = location.hash.match(/truth=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
    if (!m) return null;
    const lat = Number(m[1]);
    const lon = Number(m[2]);
    return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
  }

  async function useOwnPhoto(file: File) {
    setError('');
    try {
      const { png } = await normalizeToPng(file);
      kit.ledger.add({ op: 'Load your photo (EXIF stripped, resized)', route: 'local-js', ms: 0, bytesOut: 0 });
      setOriginal(png);
      setSource('own');
      const hashTruth = truthFromHash();
      if (hashTruth) {
        setTruthLabel('set in the page address (#truth), for testing or recording');
        setThreat(locationThreat({ ops: browserImageOps, truth: secret(hashTruth, 'your real location') }));
        kit.ledger.add({ op: 'Read your location from #truth (for local scoring only)', route: 'local-js', ms: 0, bytesOut: 0 });
        return;
      }
      // Without a location the attack is scored on the attacker's claimed precision, until the user shares one.
      setTruthLabel('not set — tap “Use my location” for a real score');
      setThreat(locationThreat({ ops: browserImageOps }));
    } catch (e) {
      setError(`Could not read that image: ${(e as Error).message}`);
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) return setError('This browser cannot share a location.');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const truth = secret({ lat: pos.coords.latitude, lon: pos.coords.longitude }, 'your real location');
        setTruthLabel(`from this browser, ±${Math.round(pos.coords.accuracy)} m`);
        setThreat(locationThreat({ ops: browserImageOps, truth }));
        kit.ledger.add({ op: 'Read your location (for local scoring only)', route: 'local-js', ms: 0, bytesOut: 0 });
      },
      (err) => setError(`Location not available: ${err.message}`),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  }

  useEffect(() => {
    svgToPng(SCENE_SVG, SCENE_W, SCENE_H).then((png) => {
      setOriginal(png);
      setStage('photo');
    });
  }, []);

  useEffect(() => {
    registerLeak(async () => {
      if (!privatePhoto.current || !original) return 'Scan your photo first, so the framework knows what is private.';
      try {
        // A careless developer passes the original photo to the cloud model, bypassing release() with a cast.
        await kit.cloud.generate([{ image: { value: original } as unknown as Publishable<Uint8Array>, mime: 'image/png' }], {
          op: 'Leak test: original photo to the cloud',
        });
        return 'The photo was sent. This should never happen.';
      } catch (e) {
        return e instanceof PrivacyViolation ? 'Blocked by the privacy guard. 0 bytes left the device.' : (e as Error).message;
      }
    });
    return () => registerLeak(null);
  }, [kit, original, registerLeak]);

  const shown = useObjectUrl(published ? published.value : original);
  // Red (it found your street), amber (it knows your city, not your street) or green (wrong place, or too unsure).
  const tier = verdict ? threat.tier(verdict) : null;
  const safe = tier === 'safe';
  const city = tier === 'city';
  const level = safe ? 'good' : city ? 'warn' : 'bad';
  const reason = verdict ? threat.exposureReason(verdict) : null;
  // What the radar plots: how precisely it can place you when it read an identifier, otherwise how far off it landed.
  const shownKm = (v: LocationVerdict) => (threat.exposureReason(v) === 'readable' ? v.radiusKm : (v.errorKm ?? v.radiusKm));
  const verdictTitle = !verdict
    ? ''
    : reason === 'readable'
      ? 'It read your address'
      : reason === 'near'
        ? city
          ? `It knows your city: ~${formatKm(verdict.errorKm!)} off`
          : `Found you: ~${formatKm(verdict.errorKm!)} away`
        : reason === 'precise'
          ? city
            ? `It can tell your city: within ~${formatKm(verdict.radiusKm)}`
            : `It can place you within ~${formatKm(verdict.radiusKm)}`
          : verdict.errorKm !== null
            ? `Off by ~${formatKm(verdict.errorKm)}`
            : verdict.lat === null
              ? 'It could not place you'
              : 'Unsure where you are';
  const verdictHeadline = !verdict
    ? ''
    : reason === 'readable'
      ? 'It read an address: anyone can look it up'
      : city
        ? 'It knows your city, not your street'
        : reason
          ? 'The attacker found you'
          : verdict.errorKm !== null
            ? 'Wrong place: it guessed far from you'
            : verdict.lat === null
              ? 'It could not place you at all'
              : 'Too unsure to find you';
  const verdictDetail = !verdict
    ? ''
    : reason === 'readable'
      ? `Street names, house numbers and plates can be searched by a person even if the AI picked the wrong city${
          verdict.errorKm !== null ? ` (it was ${formatKm(verdict.errorKm)} off)` : ''
        }. Mask them.`
      : city
        ? `${verdict.errorKm !== null ? 'Distance from where you really are, computed on your device' : 'The attacker’s own precision claim'}. Its confidence: ${verdict.confidence}. Fine if your city is no secret. If it is, crop the photo or post another one: masking cells rarely hides a city.`
        : verdict.errorKm !== null
          ? `Distance from where you really are, computed on your device. Its confidence: ${verdict.confidence}. Within ${formatKm(1)} it would know your street; within ${formatKm(50)}, your city.`
          : verdict.lat === null
            ? `It gave no place and no coordinates. Its confidence: ${verdict.confidence}.`
            : `The attacker’s own precision claim. Its confidence: ${verdict.confidence}.`;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy('');
    }
  }

  const scan = () =>
    run('scan', async () => {
      privatePhoto.current = secret(original!, 'your photo');
      if (degraded) {
        kit.ledger.add({ op: 'Find location clues', route: 'blocked', ms: 0, bytesOut: 0, note: 'no local model — tap cells to mask them yourself' });
      } else {
        if (localBackend.prepare) await localBackend.prepare(); // first user gesture: Chrome requires it before on-device inference
        setClues(await threat.findClues(privatePhoto.current, kit));
      }
      setStage('scanned');
    });

  const attack = (target: Publishable<Uint8Array>) =>
    run('attack', async () => {
      const v = await threat.attack(target, kit);
      setVerdict(v);
      setHistory((h) => [...h, shownKm(v)]);
      // No local model: the user masks by hand, so start from the cells the attacker says it used (review, 16-nov).
      if (degraded && threat.tier(v) !== 'safe') {
        const used = v.clues.map((c) => Number(c.cell)).filter((c) => Number.isInteger(c) && c >= 1 && c <= GRID * GRID);
        setManual((m) => [...new Set([...m, ...used])].filter((c) => !threat.masked.includes(c)));
      }
      setStage(threat.exposed(v) ? 'attacked' : 'safe');
    });

  const attackAsIs = () => {
    setSentAsIs(true);
    return attack(release(original!, 'baseline — user would post this photo as-is', { userConfirmedAsIs: true }));
  };

  const mask = () =>
    run('mask', async () => {
      if (degraded) {
        threat.masked = [...new Set([...threat.masked, ...manual])].sort((a, b) => a - b);
        const bytes = await browserImageOps.maskCells(original!, threat.masked, GRID);
        kit.ledger.add({ op: `Pixelate ${threat.masked.length} cells (your choice)`, route: 'local-js', ms: 40, bytesOut: 0 });
        setPublished(release(bytes, `masked by the user: ${threat.masked.join(',')}`));
        setManual([]);
      } else {
        if (localBackend.prepare) await localBackend.prepare();
        setPublished(await threat.sanitize(privatePhoto.current!, clues, verdict, kit));
      }
      setStage('masked');
    });

  const clueAt = (cell: number) => clues.find((c) => c.cell === cell && !threat.masked.includes(c.cell));
  const attackerAt = (cell: number) => verdict?.clues.find((c) => c.cell === cell && !threat.masked.includes(c.cell));
  const canPick = degraded && (stage === 'scanned' || stage === 'attacked');
  // The budget is spent and the attacker only points at cells that are not identifiers: another round would add nothing.
  const budgetFull =
    !degraded &&
    !!published &&
    threat.masked.length >= threat.maxMasked &&
    !(verdict?.clues ?? []).some((c) => isIdentifier(c) && !threat.masked.includes(c.cell));
  const chosen = manual.filter((c) => !threat.masked.includes(c)).sort((x, y) => x - y);
  const maskLabel = !chosen.length
    ? 'Tap the cells to mask'
    : chosen.length > 6
      ? `Mask these ${chosen.length} cells`
      : `Mask cell${chosen.length > 1 ? 's' : ''} ${chosen.join(', ')}`;

  return (
    <>
      {error && <div className="banner error span">{error}</div>}
      <section className="card draft">
        <div className="card-head">
          <h2>
            <span className="step">1</span> Your photo
          </h2>
          <span className={`chip ${!published && sentAsIs ? 'asis' : 'private'}`}>
            {published ? 'released for publication' : sentAsIs ? 'sent as-is to the attacker · your choice' : 'private · stays on this device'}
          </span>
        </div>
        <p className="context">
          {source === 'demo' ? 'About to post a selfie from home · illustrated scene, fictional street in Palma' : 'Your photo · decoded and EXIF-stripped on this device'}
          {' · '}
          <span className="private-note">your real location, known only to this device: {truthLabel}</span>
        </p>
        {stage === 'photo' && recorded && (
          <p className="hint">
            Recorded run: the demo photo is fixed, because the attacks were recorded for it. To check your own photo,{' '}
            <a href={location.pathname}>open the live version</a>.
          </p>
        )}
        {stage === 'photo' && !recorded && (
          <div className="photo-tools">
            <button className="mini" onClick={() => fileInput.current?.click()}>
              Use my own photo
            </button>
            <button className="mini" onClick={useMyLocation}>
              Use my location (stays on this device)
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={(e) => e.target.files?.[0] && useOwnPhoto(e.target.files[0])}
            />
          </div>
        )}
        <div className="photo">
          {shown ? <img src={shown} alt="Selfie at home with the street visible through the window" /> : <div className="photo-loading">Rendering…</div>}
          {stage !== 'loading' && stage !== 'photo' && (
            <div className="cells" style={{ gridTemplateColumns: `repeat(${GRID}, 1fr)` }}>
              {Array.from({ length: GRID * GRID }, (_, i) => i + 1).map((cell) => {
                const c = clueAt(cell);
                const a = attackerAt(cell);
                const isMasked = threat.masked.includes(cell);
                const picked = manual.includes(cell);
                return (
                  <button
                    key={cell}
                    className={`cell ${c ? 'clue' : ''} ${a && !safe ? 'attacker' : ''} ${isMasked ? 'masked' : ''} ${picked && !isMasked && canPick ? 'picked' : ''}`}
                    disabled={!canPick || isMasked}
                    onClick={() => setManual((m) => (m.includes(cell) ? m.filter((x) => x !== cell) : [...m, cell]))}
                    aria-label={`Cell ${cell}${c ? `: ${c.what}` : ''}${a && !safe ? ', used by the attacker' : ''}${isMasked ? ', masked' : ''}`}
                    aria-pressed={canPick && !isMasked ? picked : undefined}
                  >
                    <span className="n">{cell}</span>
                    {c && <span className="tag">{c.kind}</span>}
                    {!c && a && !safe && <span className="tag atk">used by attacker</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {stage !== 'loading' && stage !== 'photo' && (
          <div className="findings one">
            <div className="finding-col">
              <h3>{degraded ? 'No local model: tap the cells you want to mask' : 'Location clues found on your device'}</h3>
              {canPick && verdict && chosen.length > 0 && <p className="hint">Already selected: the cells the attacker used. Tap a cell to add or remove it.</p>}
              {clues.filter((c) => !threat.masked.includes(c.cell)).length === 0 && !degraded ? (
                <p className="good">{threat.masked.length ? `Masked ${threat.masked.length} cells on-device: ${threat.masked.join(', ')}.` : 'None found.'}</p>
              ) : (
                clues
                  .filter((c) => !threat.masked.includes(c.cell))
                  .map((c, i) => (
                    <div key={`${c.cell}-${i}`} className="finding content">
                      <code>cell {c.cell}</code> <span>{c.what}</span>
                    </div>
                  ))
              )}
              {!degraded && threat.leftVisible.length > 0 && (
                <p className="hint">
                  Left visible so the photo stays worth posting: facades and trees rarely give away more than the city. Masking covers at most{' '}
                  {threat.maxMasked} of 16 cells, plus any street name, house number or plate.
                </p>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="card lineup">
        <div className="card-head">
          <h2>
            <span className="step">2</span> The attacker’s map
          </h2>
          <span className="chip public">what the cloud sees</span>
        </div>
        <p className="context">A cloud geolocation AI sees only the version you would post, and guesses where you are. Your device scores the guess.</p>
        <Radar km={verdict ? shownKm(verdict) : null} title={verdictTitle} subtitle={verdict ? `Guess: ${verdict.place}` : ''} level={level} history={history} scanning={busy === 'attack'} />
        <p className="sr-only" aria-live="polite">
          {busy === 'attack'
            ? 'The attacker is looking at your photo.'
            : verdict
              ? `${verdictHeadline}. ${reason === 'readable' ? `Its guess: ${verdict.place}` : verdictTitle}.`
              : ''}
        </p>
        {verdict && (
          <>
            <div className="score">
              <div className={`big small ${level}`}>{formatKm(shownKm(verdict))}</div>
              <div>
                <strong>{verdictHeadline}</strong>
                <p>
                  {verdictDetail}
                  {history.length > 1 ? ` Before masking: ${formatKm(history[0])}.` : ''}
                </p>
              </div>
            </div>
            {verdict.clues.length > 0 && (
              <ul className="reasons">
                {/* A cell can hold several clues: keyed by cell alone, React kept a stale item on screen (live, 16-nov). */}
                {verdict.clues.map((c, i) => (
                  <li key={`${c.cell}-${i}`}>
                    Cell {c.cell}: {c.what}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </section>

      <footer className="actions">
        {stage === 'photo' && (
          <button onClick={scan} disabled={!!busy}>
            {busy ? 'Looking at your photo locally…' : 'Scan my photo locally'}
          </button>
        )}
        {stage === 'scanned' && (
          <button className="danger" onClick={attackAsIs} disabled={!!busy}>
            {busy ? 'Attacking…' : 'Attack it as I would post it'}
          </button>
        )}
        {stage === 'attacked' &&
          (budgetFull ? (
            <span className="done bad">It can still find you, and masking more would ruin the photo. Crop it, or post another one.</span>
          ) : (
            <button className="safe" onClick={mask} disabled={!!busy || (degraded && chosen.length === 0)}>
              {busy ? 'Masking on your device…' : degraded ? maskLabel : published ? 'Mask what the attacker used' : 'Mask clues on-device'}
            </button>
          ))}
        {stage === 'masked' && published && (
          <button className="danger" onClick={() => attack(published)} disabled={!!busy}>
            {busy ? 'Attacking…' : 'Attack again'}
          </button>
        )}
        {stage === 'safe' &&
          (city ? (
            <>
              <span className="done warn">Your street is hidden. It can still tell your city (“{verdict?.place}”): fine if that is no secret.</span>
              <button onClick={() => setStage('attacked')} disabled={!!busy}>
                Mask more anyway
              </button>
              {published && shown && (
                <a className="button-link" href={shown} download="throwaway-photo.png">
                  Download the masked photo
                </a>
              )}
            </>
          ) : (
            <>
              <span className="done">{published ? 'Looks safe to post: the attacker can only say “' + verdict?.place + '”.' : 'Looks safe to post as it is.'}</span>
              {published && shown && (
                <a className="button-link" href={shown} download="throwaway-photo.png">
                  Download the masked photo
                </a>
              )}
            </>
          ))}
      </footer>
    </>
  );
}
