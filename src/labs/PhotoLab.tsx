import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { markDeviceError, PrivacyViolation, release, secret, type Private, type Publishable } from '../framework';
import { browserImageOps, normalizeToPng, svgToPng } from '../engine/image';
import { DEMO_TRUTH, SCENE_H, SCENE_SVG, SCENE_W } from '../demo/photo';
import { GRID, isIdentifier, locationThreat, type LocationVerdict, type PhotoClue } from '../threats/location';
import { WorldMap, type MapPoint } from '../ui/WorldMap';
import { Why } from '../ui/Why';
import { ErrorNote, formatKm, friendlyError, type LabProps } from '../ui/shared';
import { Stepper, type StepDef } from '../ui/Stepper';
import { WorkLog, type PlanStep } from '../ui/WorkLog';
import { useAnimatedNumber, useReducedMotion, withTransition } from '../ui/motion';
import { useCloudBusy } from '../ui/busy';
import { Mascot, type Pose } from '../ui/Mascot';

type Stage = 'loading' | 'photo' | 'scanned' | 'attacked' | 'masked' | 'safe';
const STAGE_STEP: Record<Stage, number> = { loading: 0, photo: 0, scanned: 1, attacked: 2, masked: 3, safe: 4 };
// Gemini Nano is asked twice and the answers merged (threats/location.ts).
const SCAN_PLAN: PlanStep[] = [
  { match: /^Find location clues \(scan 1/, label: 'Look for location clues · first pass', route: 'on-device', slow: true },
  { match: /^Find location clues \(scan 2/, label: 'Look again · second pass', route: 'on-device', slow: true },
  // Then each cell said to show something readable is read up close (see readCell in threats/location.ts).
  { match: /^Read the text in cell/, label: 'Read each clue up close', route: 'on-device', slow: true, optional: true },
];
/** Time between two cells blurring, one after another. */
const PIX_STAGGER = 170;
const at = (i: number) => ({ '--i': i }) as CSSProperties;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
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

export function PhotoLab({ kit, localBackend, degraded, registerLeak, recorded, dock, onStarted }: LabProps) {
  const [stage, setStage] = useState<Stage>('loading');
  const [original, setOriginal] = useState<Uint8Array | null>(null);
  const [published, setPublished] = useState<Publishable<Uint8Array> | null>(null);
  // Blur the faces too: off by default, your choice (testers asked for it, 22-nov). The threat paints it.
  const [blurFaces, setBlurFaces] = useState(false);
  const [clues, setClues] = useState<PhotoClue[]>([]);
  const [verdict, setVerdict] = useState<LocationVerdict | null>(null);
  const [history, setHistory] = useState<number[]>([]);
  const [manual, setManual] = useState<number[]>([]);
  // "Attack it as I would post it" sends the photo as it is: the user's choice, and the chip says so.
  const [sentAsIs, setSentAsIs] = useState(false);
  const [busy, setBusy] = useState('');
  // While the attack waits on a busy cloud model, the actions say so (a retry, or a switch to a backup model).
  const [busyNote, clearBusyNote] = useCloudBusy(kit.cloud, busy === 'attack');
  const [busySince, setBusySince] = useState<number | null>(null);
  const started = (stage !== 'loading' && stage !== 'photo') || busy !== '';
  useEffect(() => onStarted?.(started), [started, onStarted]);
  const [download, setDownload] = useState<number | null>(null);
  const [rounds, setRounds] = useState(1);
  const [error, setError] = useState('');
  // Newly blurred cells appear one after another over the photo; then the blurred photo itself is shown.
  const [reveal, setReveal] = useState<{ fresh: number[]; all: number[]; settled: boolean } | null>(null);
  // Before and after: how much of the original shows, from the left (0: the blurred photo only).
  const [compare, setCompare] = useState(0);
  const reduceMotion = useReducedMotion();
  const privatePhoto = useRef<Private<Uint8Array> | null>(null);
  const acted = useRef(false);
  // The user's real location: private, only used on the device to score each attack and to put "you" on the map. In the
  // demo it is the scene's.
  const [source, setSource] = useState<'demo' | 'own'>('demo');
  const [truthLabel, setTruthLabel] = useState(SCENE_TRUTH);
  const [truthPoint, setTruthPoint] = useState<MapPoint | null>(DEMO_TRUTH);
  const [threat, setThreat] = useState(() => locationThreat({ ops: browserImageOps, truth: secret(DEMO_TRUTH, 'your real location') }));
  const fileInput = useRef<HTMLInputElement>(null);

  // One step at a time, as for a post: the new step replaces the last one where the browser can (View Transitions), with
  // what it brings set in the same go, and its title comes into view.
  const go = (next: Stage, also?: () => void): Promise<void> =>
    withTransition(() => {
      also?.();
      setStage(next);
    });
  const stageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stageRef.current;
    if (!acted.current || !el) return;
    const top = el.getBoundingClientRect().top;
    if (top < 64 || top > innerHeight / 2) el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [stage, history.length]);

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
        setTruthPoint(hashTruth);
        setThreat(locationThreat({ ops: browserImageOps, truth: secret(hashTruth, 'your real location') }));
        kit.ledger.add({ op: 'Read your location from #truth (for local scoring only)', route: 'local-js', ms: 0, bytesOut: 0 });
        return;
      }
      // Without a location the attack is scored on the attacker's claimed precision, until the user shares one.
      setTruthLabel('not set — tap “Use my location” for a real score');
      setTruthPoint(null);
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
        const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        setTruthLabel(`from this browser, ±${Math.round(pos.coords.accuracy)} m`);
        setTruthPoint(here);
        setThreat(locationThreat({ ops: browserImageOps, truth: secret(here, 'your real location') }));
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

  // After an action, hand keyboard focus to the next one (only if it was in the actions, so nothing else is taken away).
  useEffect(() => {
    if (!dock || busy || !acted.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && !dock.contains(active)) return;
    dock.querySelector<HTMLElement>('button:not(:disabled), a[href]')?.focus({ preventScroll: true });
  }, [stage, busy, dock]);

  // When the last cell has blurred, show the blurred photo itself; the cut-outs go once it has loaded (or after 800 ms).
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
  // While the cells blur, the original sits underneath and every blurred cell is drawn over it, cut from the blurred
  // photo: what is on screen is the blurred photo throughout, gaining one cell at a time.
  const pixelating = !!reveal && pub.current;
  const baseUrl = pixelating && !reveal.settled ? orig.url : published ? (pub.url ?? orig.url) : orig.url;

  // Red (it found your street), amber (it knows your city, not your street) or green (wrong place, or too unsure).
  const tier = verdict ? threat.tier(verdict) : null;
  const safe = tier === 'safe';
  const city = tier === 'city';
  const level = safe ? 'good' : city ? 'warn' : 'bad';
  const reason = verdict ? threat.exposureReason(verdict) : null;
  // How far off the guess landed, measured on the device; its own precision claim only when there is no real location to
  // measure from. Showing the claim (500 m) next to the measured miss (215 m) read as a contradiction (17-nov).
  const shownKm = (v: LocationVerdict) => v.errorKm ?? v.radiusKm;
  const km = verdict ? shownKm(verdict) : null;
  const kmShown = useAnimatedNumber(km ?? 0.001, { duration: 700, log: true });
  // A place it names, with no real location to measure it against: it may be right, and nothing here can tell (live, 22-nov:
  // "Madrid, low confidence" was close, and the app called it too unsure to find you).
  const unmeasured = !!verdict && verdict.errorKm === null && verdict.lat !== null;
  const verdictTitle = !verdict
    ? ''
    : reason === 'readable'
      ? 'It read your address'
      : reason === 'near'
        ? city
          ? `It knows your city: ~${formatKm(verdict.errorKm!)} off`
          : `Found you: ~${formatKm(verdict.errorKm!)} away`
        : reason === 'precise' && !city
          ? `It can place you within ~${formatKm(verdict.radiusKm)}`
          : unmeasured
            ? city
              ? 'It may know your city'
              : `It says “${verdict.place}”`
            : verdict.errorKm !== null
              ? `Off by ~${formatKm(verdict.errorKm)}`
              : 'It could not place you';
  const verdictHeadline = !verdict
    ? ''
    : reason === 'readable'
      ? 'It read an address: anyone can look it up'
      : city
        ? unmeasured
          ? 'It names a city, and nothing here can check it'
          : 'It knows your city, not your street'
        : reason
          ? 'The AI found you'
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
        }.`
      : unmeasured
        ? `Without your real location this device cannot tell how close that is: it claims ±${formatKm(verdict.radiusKm)}, with ${verdict.confidence} confidence. For a real score, start over and tap “Use my location” (it stays on this device).`
        : city
          ? `Distance from where you really are, computed on your device. Its confidence: ${verdict.confidence}. If your city is a secret, crop the photo or post another one: blurring cells rarely hides a city.`
          : verdict.errorKm !== null
          ? `Distance from where you really are, computed on your device. Its confidence: ${verdict.confidence}. Within ${formatKm(1)} it would know your street; within ${formatKm(50)}, your city.`
          : verdict.lat === null
            ? `It gave no place and no coordinates. Its confidence: ${verdict.confidence}.`
            : `The AI’s own precision claim. Its confidence: ${verdict.confidence}.`;
  // What the last attack got wrong, said as it happened rather than as a promise ("Looks safe to post" read as a guarantee
  // to both testers, 16-nov).
  const missed = !verdict
    ? ''
    : verdict.errorKm !== null
      ? `the AI guesses “${verdict.place}”: ${formatKm(verdict.errorKm)} from where it was taken`
      : verdict.lat === null
        ? 'the AI cannot place it at all'
        : `the AI is too unsure to find it (it says “${verdict.place}”)`;

  async function run(label: string, fn: () => Promise<void>) {
    acted.current = true;
    setBusy(label);
    setBusySince(Date.now());
    setError('');
    try {
      await fn();
    } catch (e) {
      // The full error stays in the console for a bug report; the page shows the plain-words version with its code.
      console.warn('Throwaway: this step failed', e);
      setError(friendlyError(e));
    } finally {
      setBusy('');
      setBusySince(null);
      setDownload(null);
    }
  }

  const prepare = async () => {
    if (!localBackend.prepare) return;
    // A user gesture: Chrome requires it, and it may download Gemini Nano. Its errors are the device's, never the cloud's.
    try {
      await localBackend.prepare((p) => setDownload(p), { image: true });
    } catch (e) {
      throw markDeviceError(e);
    }
  };

  const scan = () =>
    run('scan', async () => {
      privatePhoto.current = secret(original!, 'your photo');
      if (degraded) {
        kit.ledger.add({ op: 'Find location clues', route: 'skipped', ms: 0, bytesOut: 0, note: 'no local model: you tap the cells to mask' });
        await go('scanned');
      } else {
        await prepare();
        const found = await threat.findClues(privatePhoto.current, kit);
        await go('scanned', () => setClues(found));
      }
    });

  const attack = (target: Publishable<Uint8Array>, after: boolean) =>
    run('attack', async () => {
      clearBusyNote();
      // The map is where the attack shows: bring it into view as it starts.
      requestAnimationFrame(() => document.getElementById('map-title')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }));
      const v = await threat.attack(target, kit);
      await go(threat.exposed(v) ? 'attacked' : 'safe', () => {
        setVerdict(v);
        setHistory((h) => [...h, shownKm(v)]);
        // No local model: the user blurs by hand, so start from the cells the attacker says it used (review, 16-nov).
        if (degraded && threat.tier(v) !== 'safe') {
          const used = v.clues.map((c) => Number(c.cell)).filter((c) => Number.isInteger(c) && c >= 1 && c <= GRID * GRID);
          setManual((m) => [...new Set([...m, ...used])].filter((c) => !threat.masked.includes(c)));
        }
        if (after && threat.exposed(v)) setRounds((r) => r + 1);
      });
    });

  const attackAsIs = () => {
    setSentAsIs(true);
    return attack(release(original!, 'baseline — user would post this photo as-is', { userConfirmedAsIs: true }), false);
  };

  const mask = () =>
    run('mask', async () => {
      const before = [...threat.masked];
      let next: Publishable<Uint8Array>;
      if (degraded) {
        // The cells you picked, hidden around the faces like the ones Gemini Nano finds.
        next = await threat.hideCells(privatePhoto.current!, manual, kit);
      } else {
        await prepare();
        next = await threat.sanitize(privatePhoto.current!, clues, verdict, kit);
      }
      const fresh = threat.masked.filter((c) => !before.includes(c));
      await go('masked', () => {
        setPublished(next);
        setManual([]);
        setCompare(0);
        if (!reduceMotion && fresh.length) setReveal({ fresh, all: [...threat.masked], settled: false });
      });
    });

  // A new photo or location makes a new threat: it keeps your choice about faces.
  useEffect(() => {
    threat.blurFaces = blurFaces;
  }, [threat, blurFaces]);
  const toggleFaces = (on: boolean) =>
    run('toggle', async () => {
      setBlurFaces(on);
      const next = await threat.setBlurFaces(privatePhoto.current!, on, kit);
      if (next) {
        setReveal(null);
        setPublished(next);
      }
    });

  // One tap per cell once the photo is blurred: blur it, or show it again (21-nov plan). Painted again on the device.
  const toggle = (cell: number) =>
    run('toggle', async () => {
      const next = await threat.toggleCells(privatePhoto.current!, [cell], kit);
      setReveal(null);
      setPublished(next);
    });

  const clueAt = (cell: number) => clues.find((c) => c.cell === cell && !threat.masked.includes(c.cell));
  const attackerAt = (cell: number) => verdict?.clues.find((c) => c.cell === cell && !threat.masked.includes(c.cell));
  // Cells are chosen once the attacker has seen the photo as it is: chosen before, they were ignored by that first attack,
  // and a tester could not tell which step came first (17-nov).
  const canPick = degraded && stage === 'attacked';
  // Blurred and not attacked again yet: every cell can be blurred or shown again with a tap.
  const canToggle = stage === 'masked' && !!published;
  const staleVerdict = stage === 'masked' && !busy && !!verdict;
  // The budget is spent and the attacker only points at what is not an identifier: another round would add nothing.
  const budgetFull = !degraded && !!published && threat.clueShare >= threat.maxShare - 0.005 && !(verdict?.clues ?? []).some((c) => isIdentifier(c));
  const chosen = manual.filter((c) => !threat.masked.includes(c)).sort((x, y) => x - y);
  const maskLabel = !chosen.length
    ? 'Tap the cells to blur'
    : chosen.length > 6
      ? `Blur these ${chosen.length} cells`
      : `Blur cell${chosen.length > 1 ? 's' : ''} ${chosen.join(', ')}`;
  const visibleClues = clues.filter((c) => !threat.masked.includes(c.cell));
  const share = Math.round(threat.maskedShare * 100);

  const steps: StepDef[] = [
    { label: 'Find', where: degraded ? 'no local model' : 'on your device' },
    { label: 'Test', where: 'in the cloud' },
    { label: 'Blur', where: degraded ? 'you choose cells' : 'on your device' },
    { label: 'Test again', where: 'in the cloud' },
  ];
  const working = !degraded && busy === 'scan';
  const attacking = busy === 'attack';
  const busyLabel =
    busy === 'scan'
      ? degraded
        ? 'Scanning…'
        : 'Looking at your photo on this device…'
      : attacking
        ? 'Testing…'
        : busy === 'mask'
          ? 'Blurring on your device…'
          : busy === 'toggle'
            ? 'Blurring again…'
            : '';
  const busyContent = (
    <>
      <span className="spinner" aria-hidden="true" />
      {busyLabel}
    </>
  );

  // ── what this step says: a title and one sentence ──
  const head: { title: ReactNode; lede: string } =
    stage === 'loading' || stage === 'photo'
      ? {
          title: (
            <>
              Before you post a photo, let an AI try to <span className="marker">place it</span>.
            </>
          ),
          lede: recorded
            ? 'A recorded run: Gemini Nano’s answers on this demo photo were recorded in Chrome, and replay here.'
            : degraded
              ? 'The AI looks first, then you tap the cells to blur. Nothing leaves this device until you choose to test it.'
              : 'Throwaway looks for clues on this device first: street names, house numbers, plates, signs. Nothing leaves it until you choose to test it.',
        }
      : stage === 'scanned'
        ? {
            title: degraded
              ? 'First, see what the AI finds'
              : visibleClues.length
                ? `${capital(plural(visibleClues.length, 'clue'))} could place this photo`
                : 'Nothing obvious places this photo',
            // Your own photo with no location yet: ask now, before the attack, or the guess cannot be measured at all.
            lede: !truthPoint
              ? 'Share your location before the test, so this device can measure how close the guess lands: it never leaves this device.'
              : degraded
                ? 'A cloud AI looks at the photo as it is and says where it was taken; then you choose what to blur.'
                : 'Found on this device. Next, a cloud AI tries to say where it was taken.',
          }
        : stage === 'attacked'
          ? {
              title: verdictTitle,
              lede: budgetFull
                ? 'It can still find you, and blurring more would ruin the photo. Crop it, or post another one.'
                : degraded
                  ? 'Tap the cells to blur: the ones it used are selected. They are blurred on this device, around the faces.'
                  : published
                    ? 'Next, Throwaway blurs what the AI used, on this device and around the faces.'
                    : 'Next, Throwaway blurs the clues on this device: street names, numbers, plates and signs first, never a face, and at most a quarter of the photo.',
            }
          : stage === 'masked'
            ? {
                title: 'Blurred on your device',
                lede: `${share}% of the photo, around the faces. Tap a cell to blur it or show it again, then test it again.`,
              }
            : {
                title: city && !unmeasured && published ? 'Your street is hidden, your city is not' : verdictTitle,
                lede: !city
                  ? `${capital(published ? 'after blurring, ' : 'as it is, ')}${missed}.`
                  : unmeasured
                    ? `It says “${verdict?.place}”, and without your location this device cannot check how close that is. Blur the clues anyway, or start over and share your location.`
                    : `It can still tell your city (“${verdict?.place}”): fine if that is no secret.`,
              };

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
      {!busy && stage === 'scanned' && (
        <p className="dock-note warn">
          Sends your original photo, unchanged, to Gemini in Google’s cloud (again if the model is busy), as if you had posted it. The only step that sends your original; Throwaway keeps nothing.
        </p>
      )}
      {!busy && stage === 'masked' && <p className="dock-note">Sends only the blurred photo, never the original.</p>}
      <div className="dock-row">
        {stage === 'photo' && (
          <button className="primary" onClick={scan} disabled={!!busy} aria-busy={busy === 'scan'}>
            {busy ? busyContent : 'Check my photo on this device'}
          </button>
        )}
        {stage === 'scanned' && (
          <button className="primary" onClick={attackAsIs} disabled={!!busy} aria-busy={attacking}>
            {busy ? busyContent : 'Test my original photo'}
          </button>
        )}
        {stage === 'scanned' && !truthPoint && !busy && (
          <button className="ghost" onClick={useMyLocation}>
            Use my location first
          </button>
        )}
        {stage === 'attacked' && !budgetFull && (
          <button className="primary" onClick={mask} disabled={!!busy || (degraded && chosen.length === 0)} aria-busy={busy === 'mask'}>
            {busy ? busyContent : degraded ? maskLabel : published ? 'Blur what the AI used' : 'Blur the clues on this device'}
          </button>
        )}
        {stage === 'masked' && published && (
          <button className="primary" onClick={() => attack(published, true)} disabled={!!busy} aria-busy={attacking}>
            {busy ? busyContent : 'Test again'}
          </button>
        )}
        {stage === 'safe' && published && publishedUrl && (
          <a className="button-link" href={publishedUrl} download="throwaway-photo.png">
            Download the blurred photo
          </a>
        )}
        {stage === 'safe' && city && (
          <button className="ghost" onClick={() => setStage('attacked')} disabled={!!busy}>
            {published ? 'Blur more anyway' : 'Blur the clues anyway'}
          </button>
        )}
      </div>
    </>
  );

  // ── your photo, with the cells the clues are in ──
  const showCells = stage !== 'loading' && stage !== 'photo';
  const comparing = !!published && compare > 0 && !pixelating;
  const photo = (
    <section className="post panel photo-panel" aria-labelledby="photo-title">
      <div className="post-head">
        <h2 id="photo-title">{published ? 'The version you would post' : 'Your photo'}</h2>
        <span className={`chip ${!published && sentAsIs ? 'asis' : 'private'}`}>
          {published ? 'released for publication' : sentAsIs ? 'sent as it is to the AI · your choice' : 'private · stays on this device'}
        </span>
      </div>
      <div className={`photo ${working ? 'scanning' : ''}`}>
        {baseUrl ? (
          <img
            src={baseUrl}
            width={SCENE_W}
            height={SCENE_H}
            alt={source === 'demo' ? 'Selfie at home with the street visible through the window' : 'Your photo'}
            onLoad={() => reveal?.settled && setReveal(null)}
          />
        ) : (
          <div className="photo-loading">
            <span className="spinner" aria-hidden="true" /> Drawing the demo photo on this device…
          </div>
        )}
        {/* Before and after: the original shows from the left up to the line, the blurred photo after it. */}
        {comparing && orig.url && (
          <>
            <img className="photo-before" src={orig.url} alt="" aria-hidden="true" style={{ clipPath: `inset(0 ${100 - compare}% 0 0)` }} />
            <span className="photo-divider" style={{ left: `${compare}%` }} aria-hidden="true" />
          </>
        )}
        {showCells && (
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
              // The last blurred cell stays: showing it would leave the original, which is never released.
              const active = (canPick && !isMasked) || (canToggle && !busy && !(isMasked && threat.masked.length === 1));
              return (
                <button
                  key={cell}
                  className={`cell ${c ? 'clue' : ''} ${a && !safe ? 'attacker' : ''} ${isMasked ? 'masked' : ''} ${fresh >= 0 ? 'fresh' : ''} ${picked && !isMasked && canPick ? 'picked' : ''}`}
                  style={at(fresh >= 0 ? fresh : order)}
                  disabled={!active}
                  onClick={() => (canToggle ? toggle(cell) : setManual((m) => (m.includes(cell) ? m.filter((x) => x !== cell) : [...m, cell])))}
                  aria-label={`Cell ${cell}${c ? `: ${c.what}` : ''}${a && !safe ? ', used by the AI' : ''}${isMasked ? ', blurred' : ''}${
                    canToggle ? (isMasked ? '. Show it again' : '. Blur it') : ''
                  }`}
                  aria-pressed={canPick && !isMasked ? picked : canToggle ? isMasked : undefined}
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
                  {!c && a && !safe && <span className="tag atk">used by the AI</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {published && (
        <label className="compare-range">
          <span>Blurred</span>
          <input type="range" min={0} max={100} value={compare} onChange={(e) => setCompare(Number(e.target.value))} aria-label="Drag to compare the blurred photo with your original" />
          <span>Your original</span>
        </label>
      )}
      {published && (
        <p className="hint compare-hint">Drag the slider to see your original under the blur. Only the blurred version leaves this device.</p>
      )}

      {stage === 'photo' && !recorded && (
        <div className="tools">
          <span className="hint">
            {source === 'demo' ? 'Demo photo: a selfie at home, a street through the window (an illustration).' : 'Your photo, read and stripped of its location data on this device.'}
          </span>
          <span className="tools-end">
            <button className="mini" onClick={() => fileInput.current?.click()}>
              Use my own photo
            </button>
            <button className="mini" onClick={useMyLocation}>
              Use my location
            </button>
          </span>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => e.target.files?.[0] && loadOwnPhoto(e.target.files[0])} />
        </div>
      )}
      {stage === 'photo' && recorded && (
        <div className="tools">
          <span className="hint">The demo photo is fixed in a recorded run.</span>
          <a className="hint-link" href={location.pathname}>
            Check your own photo, live
          </a>
        </div>
      )}
      {/* Where "you" are on the map, and where it comes from: the scene's place in the demo (a tester took it for a leak). */}
      <p className="hint truth-note">
        {truthLabel === SCENE_TRUTH ? 'Where the scene really is (Palma) stays on this device, to score each guess.' : `Your real location, known only to this device: ${truthLabel}.`}
      </p>

      {showCells && (
        <p className="legend" aria-hidden="true">
          {visibleClues.length > 0 && <span className="key clue">Found on your device</span>}
          {!!verdict && !safe && verdict.clues.some((c) => !threat.masked.includes(c.cell)) && <span className="key atk">Used by the cloud AI</span>}
          {threat.masked.length > 0 && <span className="key blur">Blurred</span>}
        </p>
      )}

      {showCells && (
        <label className="face-switch">
          <input type="checkbox" checked={blurFaces} disabled={!!busy} onChange={(e) => void toggleFaces(e.target.checked)} />
          <span>
            <strong>Blur faces too</strong> Off, your face stays: the point is to post your photo, minus where it was taken. On, every face
            found on this device is blurred as well.
          </span>
        </label>
      )}

      {showCells && !degraded && (
        <Why summary={threat.masked.length ? `${share}% blurred, in cells ${threat.masked.join(', ')}` : plural(visibleClues.length, 'clue') + ' found on your device'}>
          {visibleClues.length === 0 ? (
            <p className="good">{threat.masked.length ? 'Every clue found on your device is blurred.' : 'None found.'}</p>
          ) : (
            <div>
              <h3>Location clues found on your device</h3>
              {visibleClues.map((c, i) => (
                <div key={`${c.cell}-${i}`} className="finding content" style={at(i)}>
                  <code>cell {c.cell}</code> <span>{c.what}</span>
                </div>
              ))}
            </div>
          )}
          {threat.leftVisible.length > 0 && (
            <p className="hint">
              Left visible: nothing on a person is blurred, and blurring covers at most a quarter of the photo, plus any street name, house number or plate.
            </p>
          )}
        </Why>
      )}
    </section>
  );

  // ── the attacker: where it guessed, on a map; how far off; what it went by ──
  const guess = verdict && verdict.lat !== null && verdict.lon !== null ? { lat: verdict.lat, lon: verdict.lon } : null;
  const attacker = (attacking || verdict) && (
    <section className="section map-section" aria-labelledby="map-title">
      <div className="section-head">
        <h2 id="map-title">The AI’s guess</h2>
        <span className="chip public">what the cloud sees</span>
      </div>
      <p className="section-note">A cloud geolocation AI sees only the version you would post. Your device measures how far off it lands.</p>
      {/* Blurred but not attacked again: the last guess is about the photo before, and looked current to a judge (17-nov). */}
      {staleVerdict && <p className="notice slim">Before blurring. Test again to see where it guesses with the blurred photo.</p>}
      <div className={staleVerdict ? 'stale' : undefined}>
        <div className={`result ${attacking ? '' : level}`} aria-live="polite">
          <div key={history.length} className={`result-num km ${attacking ? '' : 'land'}`}>
            {attacking ? <span className="spinner" aria-hidden="true" /> : formatKm(kmShown)}
          </div>
          <div className="result-text">
            <strong>{attacking ? 'The AI is looking at your photo' : verdictHeadline}</strong>
            <p>
              {attacking ? 'A cloud AI guesses where it was taken, from what it sees.' : `Guess: ${verdict!.place}. ${verdictDetail}`}
              {!attacking && history.length > 1 ? ` Before blurring: ${formatKm(history[0])}.` : ''}
            </p>
          </div>
        </div>
        <WorldMap
          you={truthPoint}
          youLabel={source === 'demo' ? 'The scene' : 'You'}
          guess={attacking ? null : guess}
          guessLabel={verdict?.place ?? ''}
          distance={!attacking && verdict && verdict.errorKm !== null ? formatKm(verdict.errorKm) : undefined}
          level={level}
        />
        {!attacking && verdict && verdict.clues.length > 0 && (
          <Why summary={safe ? 'what the AI went by, and still missed' : 'what the AI used'}>
            {/* Why blurring stops with these cells still visible: a judge read them as a loop that gave up (17-nov). */}
            {safe && <p className="hint">Not blurred, because they did not help it find you. Blurring stops here.</p>}
            <ul className="reasons">
              {/* A cell can hold several clues: keyed by cell alone, React kept a stale item on screen (live, 16-nov). */}
              {verdict.clues.map((c, i) => (
                <li key={`${c.cell}-${i}`}>
                  Cell {c.cell}: {c.what}
                </li>
              ))}
            </ul>
          </Why>
        )}
      </div>
    </section>
  );

  // The verdict first once there is one; the photo first before, and while it is being blurred.
  const verdictFirst = stage === 'attacked' || stage === 'safe';

  // The mascot reacts to the step, and to what is running (Rafa, 22-nov: the app looked dead).
  const pose: Pose =
    busy === 'scan'
      ? 'scan'
      : busy === 'attack'
        ? 'think'
        : busy === 'mask' || busy === 'toggle'
          ? 'blur'
          : stage === 'loading' || stage === 'photo'
            ? 'wave'
            : stage === 'scanned'
              ? 'scan'
              : stage === 'attacked'
                ? 'alarm'
                : stage === 'masked'
                  ? 'blur'
                  : city
                    ? 'think'
                    : 'safe';

  return (
    <div className="stage" ref={stageRef}>
      <Stepper
        steps={steps}
        current={STAGE_STEP[stage]}
        busySince={busySince}
        outcome={stage === 'safe' ? (city ? 'warn' : 'good') : null}
        skipped={stage === 'safe' && !published ? [2, 3] : []}
        round={rounds}
      />
      {error && <ErrorNote message={error} />}
      <header className="stage-head">
        <div className="stage-words">
          <h1 className="stage-title">{head.title}</h1>
          <p className="stage-lede">{head.lede}</p>
        </div>
        <Mascot pose={pose} className="stage-mascot" />
      </header>
      {verdictFirst && attacker}
      {photo}
      {!verdictFirst && attacker}
      {dock && createPortal(actions, dock)}
    </div>
  );
}
