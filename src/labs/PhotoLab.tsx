import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { PrivacyViolation, release, secret, type Private, type Publishable } from '../framework';
import { browserImageOps, normalizeToPng, svgToPng } from '../engine/image';
import { DEMO_TRUTH, SCENE_H, SCENE_SVG, SCENE_W } from '../demo/photo';
import { GRID, isIdentifier, locationThreat, type LocationVerdict, type PhotoClue } from '../threats/location';
import { Radar } from '../ui/Radar';
import { ErrorNote, formatKm, friendlyError, type LabProps } from '../ui/shared';
import { Stepper, type StepDef } from '../ui/Stepper';
import { WorkLog, type PlanStep } from '../ui/WorkLog';
import { useAnimatedNumber, useReducedMotion } from '../ui/motion';
import { useCloudBusy } from '../ui/busy';

type Stage = 'loading' | 'photo' | 'scanned' | 'attacked' | 'masked' | 'safe';
const STAGE_STEP: Record<Stage, number> = { loading: 0, photo: 0, scanned: 1, attacked: 2, masked: 3, safe: 4 };
// Gemini Nano is asked twice and the answers merged (threats/location.ts).
const SCAN_PLAN: PlanStep[] = [
  { match: /^Find location clues \(scan 1/, label: 'Look for location clues · first pass', route: 'on-device', slow: true },
  { match: /^Find location clues \(scan 2/, label: 'Look again · second pass', route: 'on-device', slow: true },
];
/** Time between two cells pixelating, one after another. */
const PIX_STAGGER = 170;
const at = (i: number) => ({ '--i': i }) as CSSProperties;
// The demo's "real location" is the scene's, not the visitor's: said so on screen (a tester took it for a leak, 16-nov).
const SCENE_TRUTH = 'Palma (where the demo scene is set)';

/**
 * A blob URL for the bytes. `url` may still be the previous one for a render (an <img> keeps showing it, so swapping photos
 * never flashes); `current` says whether it already belongs to these bytes.
 */
function useObjectUrl(bytes: Uint8Array | null) {
  const [state, setState] = useState<{ bytes: Uint8Array; url: string } | null>(null);
  useEffect(() => {
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes.slice()], { type: 'image/png' }));
    setState({ bytes, url });
    return () => URL.revokeObjectURL(url);
  }, [bytes]);
  return { url: bytes ? (state?.url ?? null) : null, current: !!bytes && state?.bytes === bytes };
}

export function PhotoLab({ kit, localBackend, degraded, registerLeak, recorded, dock }: LabProps) {
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
  // While the attack waits on a busy cloud model, the dock says so (a retry, or a switch to a backup model).
  const [busyNote, clearBusyNote] = useCloudBusy(kit.cloud, busy === 'attack');
  const [busySince, setBusySince] = useState<number | null>(null);
  const [download, setDownload] = useState<number | null>(null);
  const [rounds, setRounds] = useState(1);
  const [error, setError] = useState('');
  // Newly masked cells pixelate one after another over the photo; then the masked photo itself is shown.
  const [reveal, setReveal] = useState<{ fresh: number[]; all: number[]; settled: boolean } | null>(null);
  const reduceMotion = useReducedMotion();
  const privatePhoto = useRef<Private<Uint8Array> | null>(null);
  const acted = useRef(false);
  // The user's real location: private, only used on the device to score each attack. In the demo it is the scene's.
  const [source, setSource] = useState<'demo' | 'own'>('demo');
  const [truthLabel, setTruthLabel] = useState(SCENE_TRUTH);
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

  async function loadOwnPhoto(file: File) {
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
      // The engine's own messages are already plain sentences for the user ("That file is not an image…").
      setError((e as Error).name === 'PhotoInputError' ? (e as Error).message : `Could not read that image: ${(e as Error).message}`);
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

  // After an action, hand keyboard focus to the next one (only if it was in the dock, so nothing else is taken away).
  useEffect(() => {
    if (!dock || busy || !acted.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && !dock.contains(active)) return;
    dock.querySelector<HTMLElement>('button:not(:disabled), a[href]')?.focus({ preventScroll: true });
  }, [stage, busy, dock]);

  // When the last cell has pixelated, show the masked photo itself; the cut-outs go once it has loaded (or after 800 ms).
  useEffect(() => {
    if (!reveal) return;
    const t = setTimeout(
      () => (reveal.settled ? setReveal(null) : setReveal({ ...reveal, settled: true })),
      reveal.settled ? 800 : reveal.fresh.length * PIX_STAGGER + 700,
    );
    return () => clearTimeout(t);
  }, [reveal]);

  const orig = useObjectUrl(original);
  const pub = useObjectUrl(published ? published.value : null);
  const publishedUrl = pub.current ? pub.url : null;
  // While the cells pixelate, the original sits underneath and every masked cell is drawn over it, cut from the masked
  // photo: what is on screen is the masked photo throughout, gaining one cell at a time.
  const pixelating = !!reveal && pub.current;
  const baseUrl = pixelating && !reveal.settled ? orig.url : published ? (pub.url ?? orig.url) : orig.url;

  // Red (it found your street), amber (it knows your city, not your street) or green (wrong place, or too unsure).
  const tier = verdict ? threat.tier(verdict) : null;
  const safe = tier === 'safe';
  const city = tier === 'city';
  const level = safe ? 'good' : city ? 'warn' : 'bad';
  const reason = verdict ? threat.exposureReason(verdict) : null;
  // What the radar plots: how precisely it can place you when it read an identifier, otherwise how far off it landed.
  const shownKm = (v: LocationVerdict) => (threat.exposureReason(v) === 'readable' ? v.radiusKm : (v.errorKm ?? v.radiusKm));
  const km = verdict ? shownKm(verdict) : null;
  const kmShown = useAnimatedNumber(km ?? 0.001, { duration: 1100, log: true });
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
  // What the last attack got wrong, said as it happened rather than as a promise ("Looks safe to post" read as a guarantee
  // to both testers, 16-nov).
  const missed = !verdict
    ? ''
    : verdict.errorKm !== null
      ? `the attacker guesses “${verdict.place}”: ${formatKm(verdict.errorKm)} from where it was taken`
      : verdict.lat === null
        ? 'the attacker cannot place it at all'
        : `the attacker is too unsure to find it (it says “${verdict.place}”)`;

  async function run(label: string, fn: () => Promise<void>) {
    acted.current = true;
    setBusy(label);
    setBusySince(Date.now());
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy('');
      setBusySince(null);
      setDownload(null);
    }
  }

  const prepare = async () => {
    if (localBackend.prepare) await localBackend.prepare((p) => setDownload(p)); // a user gesture: Chrome requires it, and it may download Gemini Nano
  };

  const scan = () =>
    run('scan', async () => {
      privatePhoto.current = secret(original!, 'your photo');
      if (degraded) {
        kit.ledger.add({ op: 'Find location clues', route: 'blocked', ms: 0, bytesOut: 0, note: 'no local model — tap cells to mask them yourself' });
      } else {
        await prepare();
        setClues(await threat.findClues(privatePhoto.current, kit));
      }
      setStage('scanned');
    });

  const attack = (target: Publishable<Uint8Array>, after: boolean) =>
    run('attack', async () => {
      clearBusyNote();
      const v = await threat.attack(target, kit);
      setVerdict(v);
      setHistory((h) => [...h, shownKm(v)]);
      // No local model: the user masks by hand, so start from the cells the attacker says it used (review, 16-nov).
      if (degraded && threat.tier(v) !== 'safe') {
        const used = v.clues.map((c) => Number(c.cell)).filter((c) => Number.isInteger(c) && c >= 1 && c <= GRID * GRID);
        setManual((m) => [...new Set([...m, ...used])].filter((c) => !threat.masked.includes(c)));
      }
      if (after && threat.exposed(v)) setRounds((r) => r + 1);
      setStage(threat.exposed(v) ? 'attacked' : 'safe');
    });

  const attackAsIs = () => {
    setSentAsIs(true);
    return attack(release(original!, 'baseline — user would post this photo as-is', { userConfirmedAsIs: true }), false);
  };

  const mask = () =>
    run('mask', async () => {
      const before = [...threat.masked];
      if (degraded) {
        threat.masked = [...new Set([...threat.masked, ...manual])].sort((a, b) => a - b);
        const bytes = await browserImageOps.maskCells(original!, threat.masked, GRID);
        kit.ledger.add({ op: `Pixelate ${threat.masked.length} cells (your choice)`, route: 'local-js', ms: 40, bytesOut: 0 });
        setPublished(release(bytes, `masked by the user: ${threat.masked.join(',')}`));
        setManual([]);
      } else {
        await prepare();
        setPublished(await threat.sanitize(privatePhoto.current!, clues, verdict, kit));
      }
      const fresh = threat.masked.filter((c) => !before.includes(c));
      if (!reduceMotion && fresh.length) setReveal({ fresh, all: [...threat.masked], settled: false });
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
  const visibleClues = clues.filter((c) => !threat.masked.includes(c.cell));

  const steps: StepDef[] = [
    { label: 'Scan', where: degraded ? 'you choose cells' : 'on your device' },
    { label: 'Attack', where: 'in the cloud' },
    { label: 'Mask', where: degraded ? 'you choose cells' : 'on your device' },
    { label: 'Attack again', where: 'in the cloud' },
  ];
  const working = !degraded && busy === 'scan';
  const busyLabel =
    busy === 'scan' ? (degraded ? 'Scanning…' : 'Looking at your photo on this device…') : busy === 'attack' ? 'Attacking…' : busy === 'mask' ? 'Masking on your device…' : '';
  const busyContent = (
    <>
      <span className="spinner" aria-hidden="true" />
      {busyLabel}
    </>
  );

  const actions = (
    <>
      {working && busySince !== null && (
        <WorkLog ledger={kit.ledger} since={busySince} plan={SCAN_PLAN} title="Scanning your photo on this device" recorded={recorded} download={download} />
      )}
      {busyNote && (
        <p className="dock-note busy" role="status">
          {busyNote}
        </p>
      )}
      {!busy && stage === 'scanned' && <p className="dock-note">Sends this photo, as it is, to a cloud AI, as if you had posted it.</p>}
      {!busy && stage === 'masked' && <p className="dock-note">Sends only the masked photo, never the original.</p>}
      <div className="dock-row">
        {stage === 'photo' && (
          <button className="primary" onClick={scan} disabled={!!busy} aria-busy={busy === 'scan'}>
            {busy ? busyContent : 'Scan my photo locally'}
          </button>
        )}
        {stage === 'scanned' && (
          <button className="danger" onClick={attackAsIs} disabled={!!busy} aria-busy={busy === 'attack'}>
            {busy ? busyContent : 'Attack it as I would post it'}
          </button>
        )}
        {stage === 'attacked' &&
          (budgetFull ? (
            <p className="outcome bad" role="status">
              It can still find you, and masking more would ruin the photo. Crop it, or post another one.
            </p>
          ) : (
            <button className="safe" onClick={mask} disabled={!!busy || (degraded && chosen.length === 0)} aria-busy={busy === 'mask'}>
              {busy ? busyContent : degraded ? maskLabel : published ? 'Mask what the attacker used' : 'Mask clues on-device'}
            </button>
          ))}
        {stage === 'masked' && published && (
          <button className="danger" onClick={() => attack(published, true)} disabled={!!busy} aria-busy={busy === 'attack'}>
            {busy ? busyContent : 'Attack again'}
          </button>
        )}
        {stage === 'safe' &&
          (city ? (
            <>
              <p className="outcome warn" role="status">
                Your street is hidden. It can still tell your city (“{verdict?.place}”): fine if that is no secret.
              </p>
              <button className="ghost" onClick={() => setStage('attacked')} disabled={!!busy}>
                Mask more anyway
              </button>
              {published && publishedUrl && (
                <a className="button-link" href={publishedUrl} download="throwaway-photo.png">
                  Download the masked photo
                </a>
              )}
            </>
          ) : (
            <>
              <p className="outcome" role="status">
                {published ? 'After masking, ' : 'As it is, '}
                {missed}.
              </p>
              {published && publishedUrl && (
                <a className="button-link" href={publishedUrl} download="throwaway-photo.png">
                  Download the masked photo
                </a>
              )}
            </>
          ))}
      </div>
    </>
  );

  return (
    <>
      <Stepper
        steps={steps}
        current={STAGE_STEP[stage]}
        busySince={busySince}
        outcome={stage === 'safe' ? (city ? 'warn' : 'good') : null}
        skipped={stage === 'safe' && !published ? [2, 3] : []}
        round={rounds}
      />
      {error && <ErrorNote message={error} />}
      <section className="card draft" aria-labelledby="photo-title">
        <div className="card-head">
          <div>
            <p className="kicker">Your device</p>
            <h2 id="photo-title">Your photo</h2>
          </div>
          <span className={`chip ${!published && sentAsIs ? 'asis' : 'private'}`}>
            {published ? 'released for publication' : sentAsIs ? 'sent as-is to the attacker · your choice' : 'private · stays on this device'}
          </span>
        </div>
        <p className="context">
          {source === 'demo' ? 'About to post a selfie from home · illustrated scene, fictional street in Palma' : 'Your photo · decoded and EXIF-stripped on this device'}
          {' · '}
          <span className="private-note">
            {truthLabel === SCENE_TRUTH
              ? 'where the scene really is stays on this device, to score each guess'
              : `your real location, known only to this device: ${truthLabel}`}
          </span>
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
              onChange={(e) => e.target.files?.[0] && loadOwnPhoto(e.target.files[0])}
            />
          </div>
        )}
        <div className={`photo ${working ? 'scanning' : ''}`}>
          {baseUrl ? (
            <img
              src={baseUrl}
              width={SCENE_W}
              height={SCENE_H}
              alt="Selfie at home with the street visible through the window"
              onLoad={() => reveal?.settled && setReveal(null)}
            />
          ) : (
            <div className="photo-loading">
              <span className="spinner" aria-hidden="true" /> Drawing the demo photo on this device…
            </div>
          )}
          {stage !== 'loading' && stage !== 'photo' && (
            <div className="cells" style={{ gridTemplateColumns: `repeat(${GRID}, 1fr)` }}>
              {Array.from({ length: GRID * GRID }, (_, i) => i + 1).map((cell) => {
                const c = clueAt(cell);
                const a = attackerAt(cell);
                const isMasked = threat.masked.includes(cell);
                const picked = manual.includes(cell);
                const fresh = pixelating ? reveal.fresh.indexOf(cell) : -1;
                const r = Math.floor((cell - 1) / GRID);
                const k = (cell - 1) % GRID;
                const order = c ? visibleClues.indexOf(c) : a ? (verdict?.clues.indexOf(a) ?? 0) : 0;
                return (
                  <button
                    key={cell}
                    className={`cell ${c ? 'clue' : ''} ${a && !safe ? 'attacker' : ''} ${isMasked ? 'masked' : ''} ${fresh >= 0 ? 'fresh' : ''} ${picked && !isMasked && canPick ? 'picked' : ''}`}
                    style={at(fresh >= 0 ? fresh : order)}
                    disabled={!canPick || isMasked}
                    onClick={() => setManual((m) => (m.includes(cell) ? m.filter((x) => x !== cell) : [...m, cell]))}
                    aria-label={`Cell ${cell}${c ? `: ${c.what}` : ''}${a && !safe ? ', used by the attacker' : ''}${isMasked ? ', masked' : ''}`}
                    aria-pressed={canPick && !isMasked ? picked : undefined}
                  >
                    {pixelating && reveal.all.includes(cell) && publishedUrl && (
                      <span
                        className={`pix ${fresh >= 0 ? 'fresh' : ''}`}
                        aria-hidden="true"
                        style={{
                          backgroundImage: `url(${publishedUrl})`,
                          backgroundSize: `${GRID * 100}% ${GRID * 100}%`,
                          backgroundPosition: `${(k / (GRID - 1)) * 100}% ${(r / (GRID - 1)) * 100}%`,
                        }}
                      />
                    )}
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
              {visibleClues.length === 0 && !degraded ? (
                <p className="good rise">{threat.masked.length ? `Masked ${threat.masked.length} cells on-device: ${threat.masked.join(', ')}.` : 'None found.'}</p>
              ) : (
                visibleClues.map((c, i) => (
                  <div key={`${c.cell}-${i}`} className="finding content rise" style={at(i)}>
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

      <section className="card lineup" aria-labelledby="map-title">
        <div className="card-head">
          <div>
            <p className="kicker">The cloud</p>
            <h2 id="map-title">The attacker’s map</h2>
          </div>
          <span className="chip public">what the cloud sees</span>
        </div>
        <p className="context">A cloud geolocation AI sees only the version you would post, and guesses where you are. Your device scores the guess.</p>
        <Radar km={km} title={verdictTitle} subtitle={verdict ? `Guess: ${verdict.place}` : ''} level={level} history={history} scanning={busy === 'attack'} />
        <p className="sr-only" aria-live="polite">
          {busy === 'attack'
            ? 'The attacker is looking at your photo.'
            : verdict
              ? `${verdictHeadline}. ${reason === 'readable' ? `Its guess: ${verdict.place}` : verdictTitle}.`
              : ''}
        </p>
        {verdict && (
          <>
            <div className={`score stack-sm ${level}`}>
              <div key={history.length} className={`big small stamp ${level}`}>
                {formatKm(kmShown)}
              </div>
              <div>
                <strong>{verdictHeadline}</strong>
                <p>
                  {verdictDetail}
                  {history.length > 1 ? ` Before masking: ${formatKm(history[0])}.` : ''}
                </p>
              </div>
            </div>
            {verdict.clues.length > 0 && (
              <div className="reasons-box rise" key={`r${history.length}`}>
                <h3>{safe ? 'What the attacker went by, and still missed' : 'What the attacker used'}</h3>
                <ul className="reasons">
                  {/* A cell can hold several clues: keyed by cell alone, React kept a stale item on screen (live, 16-nov). */}
                  {verdict.clues.map((c, i) => (
                    <li key={`${c.cell}-${i}`} className="rise" style={at(i + 1)}>
                      Cell {c.cell}: {c.what}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {dock && createPortal(actions, dock)}
    </>
  );
}
