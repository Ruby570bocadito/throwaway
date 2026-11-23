import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { markDeviceError, PrivacyViolation, release, secret, type Private, type Publishable } from '../framework';
import { browserImageOps, normalizeToPng } from '../engine/image';
import { DEMO_TRUTH } from '../demo/photo';
import { SELFIE_H, SELFIE_SRC, SELFIE_W } from '../demo/selfie';
import { GRID, isIdentifier, locationThreat, type LocationVerdict, type PhotoClue } from '../threats/location';
import { WorldMap, type MapPoint } from '../ui/WorldMap';
import { Why } from '../ui/Why';
import { BeforeAfter, ErrorNote, formatKm, friendlyError, type LabProps } from '../ui/shared';
import { allowAsIsTest, blurTight } from '../kit';
import { Stepper, type StepDef } from '../ui/Stepper';
import { WorkLog, type PlanStep } from '../ui/WorkLog';
import { useAnimatedNumber, useReducedMotion, withTransition } from '../ui/motion';
import { useCloudBusy } from '../ui/busy';
import { Mascot, type Pose } from '../ui/Mascot';
import { count, lang, num, tr } from '../i18n';

type Stage = 'loading' | 'photo' | 'scanned' | 'attacked' | 'masked' | 'safe';
// Find → Blur → Test (22-nov): the original is never tested by default, so `attacked` (found by a test) leads back to Blur.
const STAGE_STEP: Record<Stage, number> = { loading: 0, photo: 0, scanned: 1, attacked: 1, masked: 2, safe: 3 };
// Gemini Nano is asked twice and the answers merged (threats/location.ts).
const SCAN_PLAN: PlanStep[] = [
  { match: /^Find location clues \(scan 1/, label: tr('Look for location clues · first pass', 'Buscar pistas del lugar · primera pasada'), route: 'on-device', slow: true },
  { match: /^Find location clues \(scan 2/, label: tr('Look again · second pass', 'Buscar otra vez · segunda pasada'), route: 'on-device', slow: true },
  // Then each cell said to show something readable is read up close (see readCell in threats/location.ts).
  { match: /^Read the text in cell/, label: tr('Read each clue up close', 'Leer cada pista de cerca'), route: 'on-device', slow: true, optional: true },
];
/** Time between two cells blurring, one after another. */
const PIX_STAGGER = 170;
const at = (i: number) => ({ '--i': i }) as CSSProperties;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
// The words the models answer with in English (a clue's kind, the guess's confidence) and the guess that names no place,
// in Spanish on screen only: the code matches the English ones.
const KIND_ES = new Map([
  ['text', 'texto'],
  ['number', 'número'],
  ['landmark', 'lugar'],
  ['vegetation', 'vegetación'],
  ['sign', 'cartel'],
  ['plate', 'matrícula'],
  ['architecture', 'arquitectura'],
  ['face', 'cara'],
  ['reflection', 'reflejo'],
  ['other', 'otro'],
]);
const kindLabel = (kind: string) => tr(kind, KIND_ES.get(kind) ?? kind);
const CONFIDENCE_ES = new Map([
  ['low', 'baja'],
  ['medium', 'media'],
  ['high', 'alta'],
]);
const confidenceLabel = (c: string) => tr(c, CONFIDENCE_ES.get(c) ?? c);
const placeLabel = (place: string) => (place === 'unknown' ? tr('unknown', 'desconocido') : place);
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
// The demo's "real location" is the demo photo's, not the visitor's: said so on screen (a tester took it for a leak, 16-nov).
const SCENE_TRUTH = 'Palma (where the demo photo is set)';

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
  // Gemini Nano found nothing on the device that places the photo: the user may still pick cells, or test it as they would post it.
  const [nothingToBlur, setNothingToBlur] = useState(false);
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
  const [threat, setThreat] = useState(() => locationThreat({ tight: blurTight(), ops: browserImageOps, truth: secret(DEMO_TRUTH, 'your real location') }));
  const fileInput = useRef<HTMLInputElement>(null);
  // A photo of yours, once chosen, is never replaced by the demo photo still loading (a slow network, or a quick pick).
  const ownPhoto = useRef(false);

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
      ownPhoto.current = true;
      setOriginal(png);
      setSource('own');
      const hashTruth = truthFromHash();
      if (hashTruth) {
        setTruthLabel(tr('set in the page address (#truth), for testing or recording', 'indicada en la dirección de la página (#truth), para probar o grabar'));
        setTruthPoint(hashTruth);
        setThreat(locationThreat({ tight: blurTight(), ops: browserImageOps, truth: secret(hashTruth, 'your real location') }));
        kit.ledger.add({ op: 'Read your location from #truth (for local scoring only)', route: 'local-js', ms: 0, bytesOut: 0 });
        return;
      }
      // Without a location the attack is scored on the attacker's claimed precision, until the user shares one.
      setTruthLabel(tr('not set — tap “Use my location” for a real score', 'sin indicar (toca «Usar mi ubicación» para medir la distancia real)'));
      setTruthPoint(null);
      setThreat(locationThreat({ tight: blurTight(), ops: browserImageOps }));
    } catch (e) {
      // The engine's own messages are already plain sentences for the user ("That file is not an image…").
      setError(
        (e as Error).name === 'PhotoInputError'
          ? (e as Error).message
          : tr(`Could not read that image: ${(e as Error).message}`, `No se ha podido leer esa imagen: ${(e as Error).message}`),
      );
    }
  }

  function useMyLocation() {
    if (!navigator.geolocation) return setError(tr('This browser cannot share a location.', 'Este navegador no puede compartir una ubicación.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const here = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        const metres = num(Math.round(pos.coords.accuracy));
        setTruthLabel(tr(`from this browser, ±${metres} m`, `según este navegador, ±${metres} m`));
        setTruthPoint(here);
        setThreat(locationThreat({ tight: blurTight(), ops: browserImageOps, truth: secret(here, 'your real location') }));
        kit.ledger.add({ op: 'Read your location (for local scoring only)', route: 'local-js', ms: 0, bytesOut: 0 });
      },
      (err) => setError(tr(`Location not available: ${err.message}`, `Ubicación no disponible: ${err.message}`)),
      { enableHighAccuracy: false, timeout: 10000 },
    );
  }

  // The demo photo: the Palma selfie whose answers the recorded run replays (src/demo/selfie.ts), loaded like a photo of
  // yours (EXIF stripped, PNG at 1280 px), as the photo bench loaded it when Gemini Nano was measured on it.
  useEffect(() => {
    let gone = false;
    fetch(SELFIE_SRC)
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((blob) => normalizeToPng(blob))
      .then(({ png }) => {
        if (gone || ownPhoto.current) return;
        setOriginal(png);
        setStage('photo');
      })
      .catch(() => {
        if (gone || ownPhoto.current) return;
        setError(tr('Could not load the demo photo. Reload the page, or use a photo of yours.', 'No se ha podido cargar la foto de la demo. Recarga la página o usa una foto tuya.'));
      });
    return () => {
      gone = true;
    };
  }, []);

  useEffect(() => {
    registerLeak(async () => {
      if (!privatePhoto.current || !original)
        return tr('Scan your photo first, so the framework knows what is private.', 'Primero revisa tu foto, para que Throwaway sepa qué es privado.');
      try {
        // A careless developer passes the original photo to the cloud model, bypassing release() with a cast.
        await kit.cloud.generate([{ image: { value: original } as unknown as Publishable<Uint8Array>, mime: 'image/png' }], {
          op: 'Leak test: original photo to the cloud',
        });
        return tr('The photo was sent. This should never happen.', 'La foto se ha enviado. Esto no debería pasar nunca.');
      } catch (e) {
        // The shell colours the answer by its first word: "Blocked", or "Bloqueado" in Spanish.
        return e instanceof PrivacyViolation
          ? tr('Blocked by the privacy guard. 0 bytes left the device.', 'Bloqueado por la protección de privacidad. Han salido 0 bytes del dispositivo.')
          : (e as Error).message;
      }
    });
    return () => registerLeak(null);
  }, [kit, original, registerLeak]);

  // After an action, hand keyboard focus to the next one (only if it was in the actions, so nothing else is taken away).
  useEffect(() => {
    if (!dock || busy || !acted.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && !dock.contains(active)) return;
    // Never the button that would test the original: Enter must not send it.
    dock.querySelector<HTMLElement>('button:not(:disabled):not(.as-is), a[href]')?.focus({ preventScroll: true });
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
      ? tr('It read your address', 'Ha leído tu dirección')
      : reason === 'near'
        ? city
          ? tr(`It knows your city: ~${formatKm(verdict.errorKm!)} off`, `Sabe cuál es tu ciudad: se equivoca por ~${formatKm(verdict.errorKm!)}`)
          : tr(`Found you: ~${formatKm(verdict.errorKm!)} away`, `Te ha encontrado: a ~${formatKm(verdict.errorKm!)} de ti`)
        : reason === 'precise' && !city
          ? tr(`It can place you within ~${formatKm(verdict.radiusKm)}`, `Puede localizarte en un radio de ~${formatKm(verdict.radiusKm)}`)
          : unmeasured
            ? city
              ? tr('It may know your city', 'Puede que sepa cuál es tu ciudad')
              : tr(`It says “${verdict.place}”`, `Dice «${verdict.place}»`)
            : verdict.errorKm !== null
              ? tr(`Off by ~${formatKm(verdict.errorKm)}`, `Se equivoca por ~${formatKm(verdict.errorKm)}`)
              : tr('It could not place you', 'No ha podido localizarte');
  const verdictHeadline = !verdict
    ? ''
    : reason === 'readable'
      ? tr('It read an address: anyone can look it up', 'Ha leído una dirección: cualquiera puede buscarla')
      : city
        ? unmeasured
          ? tr('It names a city, and nothing here can check it', 'Nombra una ciudad, y aquí no hay forma de comprobarlo')
          : tr('It knows your city, not your street', 'Sabe cuál es tu ciudad, no tu calle')
        : reason
          ? tr('The AI found you', 'La IA te ha encontrado')
          : verdict.errorKm !== null
            ? tr('Wrong place: it guessed far from you', 'Lugar equivocado: ha apuntado lejos de ti')
            : verdict.lat === null
              ? tr('It could not place you at all', 'No ha podido localizarte en absoluto')
              : tr('Too unsure to find you', 'Duda demasiado para encontrarte');
  const confidence = verdict ? confidenceLabel(verdict.confidence) : '';
  const verdictDetail = !verdict
    ? ''
    : reason === 'readable'
      ? tr(
          `Street names, house numbers and plates can be searched by a person even if the AI picked the wrong city${
            verdict.errorKm !== null ? ` (it was ${formatKm(verdict.errorKm)} off)` : ''
          }.`,
          `Una persona puede buscar nombres de calles, números de portal y matrículas aunque la IA se haya equivocado de ciudad${
            verdict.errorKm !== null ? ` (ha fallado por ${formatKm(verdict.errorKm)})` : ''
          }.`,
        )
      : unmeasured
        ? tr(
            `Without your real location this device cannot tell how close that is: it claims ±${formatKm(verdict.radiusKm)}, with ${confidence} confidence. For a real score, start over and tap “Use my location” (it stays on this device).`,
            `Sin tu ubicación real, este dispositivo no puede saber cuánto se acerca: dice tener un margen de ±${formatKm(verdict.radiusKm)}, con confianza ${confidence}. Para medirlo de verdad, empieza de nuevo y toca «Usar mi ubicación» (no sale de este dispositivo).`,
          )
        : city
          ? tr(
              `Distance from where you really are, computed on your device. Its confidence: ${confidence}. If your city is a secret, crop the photo or post another one: blurring cells rarely hides a city.`,
              `Distancia a tu ubicación real, calculada en tu dispositivo. Su confianza: ${confidence}. Si tu ciudad es un secreto, recorta la foto o publica otra: difuminar casillas pocas veces oculta una ciudad.`,
            )
          : verdict.errorKm !== null
          ? tr(
              `Distance from where you really are, computed on your device. Its confidence: ${confidence}. Within ${formatKm(1)} it would know your street; within ${formatKm(50)}, your city.`,
              `Distancia a tu ubicación real, calculada en tu dispositivo. Su confianza: ${confidence}. A menos de ${formatKm(1)} sabría tu calle; a menos de ${formatKm(50)}, tu ciudad.`,
            )
          : verdict.lat === null
            ? tr(`It gave no place and no coordinates. Its confidence: ${confidence}.`, `No ha dado ningún lugar ni coordenadas. Su confianza: ${confidence}.`)
            : tr(`The AI’s own precision claim. Its confidence: ${confidence}.`, `La precisión que dice tener la propia IA. Su confianza: ${confidence}.`);
  // What the last attack got wrong, said as it happened rather than as a promise ("Looks safe to post" read as a guarantee
  // to both testers, 16-nov).
  const missed = !verdict
    ? ''
    : verdict.errorKm !== null
      ? tr(
          `the AI guesses “${verdict.place}”: ${formatKm(verdict.errorKm)} from where it was taken`,
          `la IA dice «${verdict.place}»: a ${formatKm(verdict.errorKm)} de donde se hizo`,
        )
      : verdict.lat === null
        ? tr('the AI cannot place it at all', 'la IA no puede situarla en absoluto')
        : tr(`the AI is too unsure to find it (it says “${verdict.place}”)`, `la IA duda demasiado para encontrarla (dice «${verdict.place}»)`);

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
      if (degraded || (stage === 'scanned' && nothingToBlur)) {
        // The cells you picked, hidden around the faces like the ones Gemini Nano finds.
        next = await threat.hideCells(privatePhoto.current!, manual, kit);
      } else {
        await prepare();
        try {
          // Right after the scan there is no verdict: the clues found on this device decide (22-nov), nothing is sent.
          next = await threat.sanitize(privatePhoto.current!, clues, verdict, kit);
        } catch (e) {
          // Nothing found that places it (or it is all face): pick cells, or test it as you would post it.
          if (stage === 'scanned' && /^Nothing to mask/.test((e as Error).message)) {
            setNothingToBlur(true);
            return;
          }
          throw e;
        }
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
  // Without Gemini Nano, or when it found nothing, you pick the cells yourself, right after the scan: the blur comes before any
  // test since 22-nov. After a test that still found you, the cells it used are preselected (no model only).
  const canPick = ((degraded || nothingToBlur) && stage === 'scanned') || (degraded && stage === 'attacked');
  // Private by default (22-nov): testing the untouched original only in the recorded demo (nothing sent) or on a paid plan.
  const canTestOriginal = recorded || allowAsIsTest;
  // What Gemini Nano read up close, on this device: the "before", known without sending anything.
  const readHere = [...new Set(clues.filter((c) => c.read).flatMap((c) => c.seen ?? []))].slice(0, 4);
  const readAddress = clues.some((c) => c.read && isIdentifier(c));
  // Blurred and not attacked again yet: every cell can be blurred or shown again with a tap.
  const canToggle = stage === 'masked' && !!published;
  const staleVerdict = stage === 'masked' && !busy && !!verdict;
  // The budget is spent and the attacker only points at what is not an identifier: another round would add nothing.
  const budgetFull = !degraded && !!published && threat.clueShare >= threat.maxShare - 0.005 && !(verdict?.clues ?? []).some((c) => isIdentifier(c));
  const chosen = manual.filter((c) => !threat.masked.includes(c)).sort((x, y) => x - y);
  const maskLabel = !chosen.length
    ? tr('Tap the cells to blur', 'Toca las casillas que quieras difuminar')
    : chosen.length > 6
      ? tr(`Blur these ${num(chosen.length)} cells`, `Difuminar estas ${num(chosen.length)} casillas`)
      : tr(`Blur cell${chosen.length > 1 ? 's' : ''} ${chosen.join(', ')}`, `Difuminar ${chosen.length > 1 ? 'las casillas' : 'la casilla'} ${chosen.join(', ')}`);
  const visibleClues = clues.filter((c) => !threat.masked.includes(c.cell));
  const share = Math.round(threat.maskedShare * 100);

  const steps: StepDef[] = [
    { label: tr('Find', 'Buscar'), where: degraded ? tr('no local model', 'sin IA en el dispositivo') : tr('on your device', 'en tu dispositivo') },
    { label: tr('Blur', 'Difuminar'), where: degraded ? tr('you choose cells', 'tú eliges las casillas') : tr('on your device', 'en tu dispositivo') },
    { label: tr('Test', 'Probar'), where: tr('in the cloud', 'en la nube') },
  ];
  const working = !degraded && busy === 'scan';
  const attacking = busy === 'attack';
  const busyLabel =
    busy === 'scan'
      ? degraded
        ? tr('Scanning…', 'Revisando…')
        : tr('Looking at your photo on this device…', 'Mirando tu foto en este dispositivo…')
      : attacking
        ? tr('Testing…', 'Probando…')
        : busy === 'mask'
          ? tr('Blurring on your device…', 'Difuminando en tu dispositivo…')
          : busy === 'toggle'
            ? tr('Blurring again…', 'Difuminando de nuevo…')
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
          title:
            lang === 'es' ? (
              <>
                Antes de publicar una foto, mira <span className="marker">qué delata el lugar</span>.
              </>
            ) : (
              <>
                Before you post a photo, see <span className="marker">what gives away the place</span>.
              </>
            ),
          lede: recorded
            ? tr(
                'A recorded run: Gemini Nano’s answers on this demo photo were recorded in Chrome, and replay here.',
                'Una revisión grabada: las respuestas de Gemini Nano sobre esta foto de la demo se grabaron en Chrome y se reproducen aquí.',
              )
            : degraded
              ? tr(
                  'No on-device AI here: you tap the cells to blur, on this device. Only the blurred photo is tested in the cloud, when you choose.',
                  'Este dispositivo no tiene IA: tocas tú las casillas que difuminar, y se difuminan aquí. Solo la foto difuminada se prueba en la nube, cuando tú decidas.',
                )
              : tr(
                  'Throwaway finds the clues and blurs them on this device: street names, house numbers, plates, signs. Only the blurred photo is tested in the cloud, when you choose.',
                  'Throwaway encuentra las pistas y las difumina en este dispositivo: nombres de calles, números de portal, matrículas, carteles. Solo la foto difuminada se prueba en la nube, cuando tú decidas.',
                ),
        }
      : stage === 'scanned'
        ? {
            title: degraded
              ? tr('Tap what could place this photo', 'Toca lo que podría delatar el lugar')
              : visibleClues.length
                ? tr(
                    `${capital(count(visibleClues.length, ['clue', 'clues'], ['pista', 'pistas']))} could place this photo`,
                    `${capital(count(visibleClues.length, ['clue', 'clues'], ['pista', 'pistas']))} ${visibleClues.length === 1 ? 'podría' : 'podrían'} delatar el lugar`,
                  )
                : tr('Nothing obvious places this photo', 'Nada delata el lugar a simple vista'),
            // Your own photo with no location yet: ask now, before the test, or the guess cannot be measured at all.
            lede: !truthPoint
              ? tr(
                  'Share your location before the test, so this device can measure how close the guess lands: it never leaves this device.',
                  'Comparte tu ubicación antes de probar, para que este dispositivo pueda medir cuánto se acerca la IA: tu ubicación nunca sale de él.',
                )
              : degraded
                ? tr(
                    'Tap the cells with street names, house numbers, plates or signs. They are blurred on this device, around the faces.',
                    'Toca las casillas con nombres de calles, números de portal, matrículas o carteles. Se difuminan en este dispositivo, alrededor de las caras.',
                  )
                : nothingToBlur
                  ? tr(
                      'Gemini Nano found nothing here that places it. Tap any cell you still want blurred, or test it as you would post it.',
                      'Gemini Nano no ha encontrado nada que delate el lugar. Toca las casillas que aun así quieras difuminar, o pruébala tal como la publicarías.',
                    )
                  : readHere.length
                    ? tr(
                        `On this device, Gemini Nano read ${readHere.map((t) => `“${t}”`).join(', ')}${readAddress ? ': that is an address' : ''}. Next, Throwaway blurs the clues here; nothing has left this device.`,
                        `En este dispositivo, Gemini Nano ha leído ${readHere.map((t) => `«${t}»`).join(', ')}${readAddress ? ': eso es una dirección' : ''}. Después, Throwaway difumina aquí las pistas; nada ha salido de este dispositivo.`,
                      )
                    : tr(
                        'Found on this device, and nothing has left it. Next, Throwaway blurs the clues here.',
                        'Se ha buscado en este dispositivo, y nada ha salido de él. Después, Throwaway difumina aquí las pistas.',
                      ),
          }
        : stage === 'attacked'
          ? {
              title: verdictTitle,
              lede: budgetFull
                ? tr(
                    'It can still find you, and blurring more would ruin the photo. Crop it, or post another one.',
                    'Aún puede encontrarte, y difuminar más estropearía la foto. Recórtala o publica otra.',
                  )
                : degraded
                  ? tr(
                      'Tap the cells to blur: the ones it used are selected. They are blurred on this device, around the faces.',
                      'Toca las casillas que difuminar: las que usó la IA ya están marcadas. Se difuminan en este dispositivo, alrededor de las caras.',
                    )
                  : published
                    ? tr(
                        'Next, Throwaway blurs what the AI used, on this device and around the faces.',
                        'Después, Throwaway difumina lo que usó la IA, en este dispositivo y alrededor de las caras.',
                      )
                    : tr(
                        'Next, Throwaway blurs the clues on this device: street names, numbers, plates and signs first, never a face, and at most a quarter of the photo.',
                        'Después, Throwaway difumina las pistas en este dispositivo: primero nombres de calles, números, matrículas y carteles, nunca una cara, y como mucho una cuarta parte de la foto.',
                      ),
            }
          : stage === 'masked'
            ? {
                title: tr('Blurred on your device', 'Difuminada en tu dispositivo'),
                lede: tr(
                  `${share}% of the photo: each cell with a clue and a little around it, so nothing on its edge stays sharp, and never a face. Tap a cell to blur it or show it again, then test it${history.length ? ' again' : ''}.`,
                  `El ${num(share)}\u00a0% de la foto: cada casilla con una pista y un poco alrededor, para que no quede nada nítido en su borde, y nunca una cara. Toca una casilla para difuminarla o volver a mostrarla, y luego ${history.length ? 'vuelve a probarla' : 'pruébala'}.`,
                ),
              }
            : {
                title: city && !unmeasured && published ? tr('Your street is hidden, your city is not', 'Tu calle está oculta, tu ciudad no') : verdictTitle,
                lede: !city
                  ? tr(`${capital(published ? 'after blurring, ' : 'as it is, ')}${missed}.`, `${capital(published ? 'tras difuminarla, ' : 'tal como está, ')}${missed}.`)
                  : unmeasured
                    ? tr(
                        `It says “${verdict?.place}”, and without your location this device cannot check how close that is. Blur the clues anyway, or start over and share your location.`,
                        `Dice «${verdict?.place}», y sin tu ubicación este dispositivo no puede comprobar cuánto se acerca. Difumina las pistas de todos modos, o empieza de nuevo y comparte tu ubicación.`,
                      )
                    : tr(
                        `It can still tell your city (“${verdict?.place}”): fine if that is no secret.`,
                        `Aún puede saber cuál es tu ciudad («${verdict?.place}»): no pasa nada si no es un secreto.`,
                      ),
              };

  const actions = (
    <>
      {working && busySince !== null && (
        <WorkLog
          ledger={kit.ledger}
          since={busySince}
          plan={SCAN_PLAN}
          title={tr('Scanning your photo on this device', 'Revisando tu foto en este dispositivo')}
          recorded={recorded}
          download={download}
        />
      )}
      {busyNote && (
        <p className="dock-note busy" role="status">
          {busyNote}
        </p>
      )}
      {/* Before a tap that sends something: a notice, not small print (two testers missed it, 22-nov), with what Gemini's
          free plan allows. */}
      {!busy && stage === 'scanned' && nothingToBlur && chosen.length === 0 && !recorded && (
        <p className="dock-note consent">
          {tr(
            'Testing sends this photo as you would post it to Gemini, on Google’s free plan: Google may use it to improve its products, and people may review it. It is what you are about to post for everyone anyway.',
            'Probarla envía a Gemini esta foto tal como la publicarías, en el plan gratuito de Google: Google puede usarla para mejorar sus productos, y una persona puede revisarla. Es lo que vas a publicar para todo el mundo de todos modos.',
          )}
        </p>
      )}
      {!busy && stage === 'scanned' && canTestOriginal && !recorded && !nothingToBlur && (
        <p className="dock-note consent">
          {tr(
            'Testing the original sends your photo, unchanged, to Gemini in Google’s cloud, as if you had posted it. Blurring it first sends nothing.',
            'Probar el original envía tu foto, sin cambios, a Gemini en la nube de Google, como si la hubieras publicado. Difuminarla antes no envía nada.',
          )}
        </p>
      )}
      {!busy && stage === 'masked' && (
        <p className={`dock-note ${recorded ? '' : 'consent'}`}>
          {recorded
            ? tr(
                'A recorded run: nothing is sent. Live, only the blurred photo goes to Gemini, on Google’s free plan.',
                'Una revisión grabada: no se envía nada. En directo, solo la foto difuminada va a Gemini, en el plan gratuito de Google.',
              )
            : tr(
                `Sends only the blurred photo, never your original, to Gemini on Google’s free plan: Google may use it to improve its products, and people may review it. It is what you are about to post for everyone anyway.${
                  blurFaces ? '' : ' Your face goes too, unless you tick “Blur faces too”.'
                }`,
                `Envía solo la foto difuminada, nunca tu original, a Gemini en el plan gratuito de Google: Google puede usarla para mejorar sus productos, y una persona puede revisarla. Es lo que vas a publicar para todo el mundo de todos modos.${
                  blurFaces ? '' : ' Tu cara también va, salvo que marques «Difuminar también las caras».'
                }`,
              )}
        </p>
      )}
      <div className="dock-row">
        {stage === 'photo' && (
          <button className="primary" onClick={scan} disabled={!!busy} aria-busy={busy === 'scan'}>
            {busy ? busyContent : tr('Check my photo on this device', 'Revisar mi foto en este dispositivo')}
          </button>
        )}
        {/* Blur first, on the device: nothing has to leave it to find out (22-nov). */}
        {stage === 'scanned' && (degraded || nothingToBlur) && !(nothingToBlur && chosen.length === 0) && (
          <button className="primary" onClick={mask} disabled={!!busy || chosen.length === 0} aria-busy={busy === 'mask'}>
            {busy === 'mask' ? busyContent : maskLabel}
          </button>
        )}
        {stage === 'scanned' && nothingToBlur && chosen.length === 0 && (
          <button className="primary" onClick={attackAsIs} disabled={!!busy} aria-busy={attacking}>
            {busy ? busyContent : tr('Test it as I would post it', 'Probarla tal como la publicaría')}
          </button>
        )}
        {stage === 'scanned' && !degraded && !nothingToBlur && (
          <button className="primary" onClick={mask} disabled={!!busy} aria-busy={busy === 'mask'}>
            {busy === 'mask' ? busyContent : tr('Blur the clues on this device', 'Difuminar las pistas en este dispositivo')}
          </button>
        )}
        {stage === 'scanned' && canTestOriginal && !nothingToBlur && (
          <button
            className="ghost as-is"
            onClick={attackAsIs}
            disabled={!!busy}
            aria-busy={attacking}
            title={recorded ? tr('A recorded run: nothing is sent', 'Una revisión grabada: no se envía nada') : undefined}
          >
            {attacking
              ? busyContent
              : recorded
                ? tr('First, test the original (recorded)', 'Probar primero el original (grabado)')
                : tr('First, test my original', 'Probar primero mi original')}
          </button>
        )}
        {stage === 'scanned' && !truthPoint && !busy && (
          <button className="ghost" onClick={useMyLocation}>
            {tr('Use my location first', 'Usar mi ubicación antes')}
          </button>
        )}
        {stage === 'attacked' && !budgetFull && (
          <button className="primary" onClick={mask} disabled={!!busy || (degraded && chosen.length === 0)} aria-busy={busy === 'mask'}>
            {busy
              ? busyContent
              : degraded
                ? maskLabel
                : published
                  ? tr('Blur what the AI used', 'Difuminar lo que usó la IA')
                  : tr('Blur the clues on this device', 'Difuminar las pistas en este dispositivo')}
          </button>
        )}
        {stage === 'masked' && published && (
          <button className="primary" onClick={() => attack(published, true)} disabled={!!busy} aria-busy={attacking}>
            {busy ? busyContent : history.length ? tr('Test again', 'Probar de nuevo') : tr('Test it', 'Probarla')}
          </button>
        )}
        {stage === 'safe' && published && publishedUrl && (
          <a className="button-link" href={publishedUrl} download="throwaway-photo.png">
            {tr('Download the blurred photo · no location data inside (EXIF, GPS)', 'Descargar la foto difuminada · sin datos de ubicación dentro (EXIF, GPS)')}
          </a>
        )}
        {stage === 'safe' && city && (
          <button className="ghost" onClick={() => setStage('attacked')} disabled={!!busy}>
            {published ? tr('Blur more anyway', 'Difuminar más de todos modos') : tr('Blur the clues anyway', 'Difuminar las pistas de todos modos')}
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
        <h2 id="photo-title">{published ? tr('The version you would post', 'La versión que publicarías') : recorded ? tr('Demo photo', 'Foto de la demo') : tr('Your photo', 'Tu foto')}</h2>
        <span className={`chip ${!published && sentAsIs ? 'asis' : 'private'}`}>
          {published
            ? tr('what you would post', 'lo que publicarías')
            : sentAsIs
              ? tr('sent as it is to the AI · your choice', 'enviada tal cual a la IA · decisión tuya')
              : tr('private · stays on this device', 'privada · no sale de este dispositivo')}
        </span>
      </div>
      <div className={`photo ${working ? 'scanning' : ''}`}>
        {baseUrl ? (
          <img
            src={baseUrl}
            width={SELFIE_W}
            height={SELFIE_H}
            alt={
              source === 'demo'
                ? tr('Selfie at home with the street visible through the window', 'Una selfi en casa, con la calle a la vista por la ventana')
                : tr('Your photo', 'Tu foto')
            }
            onLoad={() => reveal?.settled && setReveal(null)}
          />
        ) : (
          <div className="photo-loading">
            <span className="spinner" aria-hidden="true" /> {tr('Loading the demo photo…', 'Cargando la foto de la demo…')}
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
                  aria-label={tr(
                    `Cell ${cell}${c ? `: ${c.what}` : ''}${a && !safe ? ', used by the AI' : ''}${isMasked ? ', blurred' : ''}${
                      canToggle ? (isMasked ? '. Show it again' : '. Blur it') : ''
                    }`,
                    `Casilla ${cell}${c ? `: ${c.what}` : ''}${a && !safe ? ', la usó la IA' : ''}${isMasked ? ', difuminada' : ''}${
                      canToggle ? (isMasked ? '. Volver a mostrarla' : '. Difuminarla') : ''
                    }`,
                  )}
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
                  {c && <span className="tag">{kindLabel(c.kind)}</span>}
                  {!c && a && !safe && <span className="tag atk">{tr('used by the AI', 'la usó la IA')}</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
      {published && (
        <label className="compare-range">
          <span>{tr('Blurred', 'Difuminada')}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={compare}
            onChange={(e) => setCompare(Number(e.target.value))}
            aria-label={tr('Drag to compare the blurred photo with your original', 'Arrastra para comparar la foto difuminada con tu original')}
          />
          <span>{tr('Your original', 'Tu original')}</span>
        </label>
      )}
      {published && (
        <p className="hint compare-hint">
          {tr(
            'Drag the slider to see your original under the blur. Only the blurred version leaves this device.',
            'Arrastra el control para ver tu original debajo del difuminado. Solo la versión difuminada sale de este dispositivo.',
          )}
        </p>
      )}

      {stage === 'photo' && !recorded && (
        <div className="tools">
          <span className="hint">
            {source === 'demo'
              ? tr(
                  'Demo photo: a selfie at home, a street through the window (an illustration).',
                  'Foto de la demo: una selfi en casa, con una calle por la ventana (es una ilustración).',
                )
              : tr('Your photo, read and stripped of its location data on this device.', 'Tu foto, leída en este dispositivo y sin sus datos de ubicación.')}
          </span>
          <span className="tools-end">
            <button className="mini" onClick={() => fileInput.current?.click()}>
              {tr('Use my own photo', 'Usar una foto mía')}
            </button>
            {/* Only for a photo of yours: on the demo photo it replaced the scene's place (Palma) with yours (22-nov). */}
            {source === 'own' && (
              <button className="mini" onClick={useMyLocation}>
                {tr('Use my location', 'Usar mi ubicación')}
              </button>
            )}
          </span>
          <input ref={fileInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => e.target.files?.[0] && loadOwnPhoto(e.target.files[0])} />
        </div>
      )}
      {stage === 'photo' && recorded && (
        <div className="tools">
          <span className="hint">{tr('The demo photo is fixed in a recorded run.', 'En una revisión grabada, la foto de la demo no se puede cambiar.')}</span>
          <a className="hint-link" href={location.pathname}>
            {tr('Check your own photo, live', 'Revisa una foto tuya, en vivo')}
          </a>
        </div>
      )}
      {/* Where "you" are on the map, and where it comes from: the scene's place in the demo (a tester took it for a leak). */}
      <p className="hint truth-note">
        {truthLabel === SCENE_TRUTH
          ? tr(
              'Where the demo photo is set (Palma) stays on this device, to score each guess.',
              'El lugar de la foto de la demo (Palma) se queda en este dispositivo, para medir cada intento de la IA.',
            )
          : tr(`Your real location, known only to this device: ${truthLabel}.`, `Tu ubicación real, que solo conoce este dispositivo: ${truthLabel}.`)}
      </p>

      {showCells && (
        <p className="legend" aria-hidden="true">
          {/* After blurring, a red cell left visible read as a mistake (a tester, 22-nov): say it is yours to blur. */}
          {visibleClues.length > 0 && (
            <span className="key clue">
              {threat.masked.length > 0
                ? tr('Found, not blurred: tap it to blur it', 'Encontrada, sin difuminar: tócala para difuminarla')
                : tr('Found on your device', 'Encontrada en tu dispositivo')}
            </span>
          )}
          {!!verdict && !safe && verdict.clues.some((c) => !threat.masked.includes(c.cell)) && (
            <span className="key atk">{tr('Used by the cloud AI', 'La usó la IA de la nube')}</span>
          )}
          {threat.masked.length > 0 && <span className="key blur">{tr('Blurred', 'Difuminada')}</span>}
        </p>
      )}

      {showCells && (
        <label className="face-switch">
          <input type="checkbox" checked={blurFaces} disabled={!!busy} onChange={(e) => void toggleFaces(e.target.checked)} />
          <span>
            <strong>{tr('Blur faces too', 'Difuminar también las caras')}</strong>{' '}
            {tr(
              'Off, your face stays: the point is to post your photo, minus where it was taken. On, every face found on this device is blurred as well.',
              'Desactivado, tu cara se queda como está: la idea es publicar tu foto, pero no dónde se hizo. Activado, también se difuminan todas las caras que encuentre este dispositivo.',
            )}
          </span>
        </label>
      )}

      {showCells && !degraded && (
        <Why
          summary={
            threat.masked.length
              ? tr(
                  `${share}% blurred, in ${threat.masked.length === 1 ? 'cell' : 'cells'} ${threat.masked.join(', ')}`,
                  `${num(share)}\u00a0% difuminado, en ${threat.masked.length === 1 ? 'la casilla' : 'las casillas'} ${threat.masked.join(', ')}`,
                )
              : tr(
                  `${count(visibleClues.length, ['clue', 'clues'], ['pista', 'pistas'])} found on your device`,
                  `${count(visibleClues.length, ['clue', 'clues'], ['pista', 'pistas'])} ${visibleClues.length === 1 ? 'encontrada' : 'encontradas'} en tu dispositivo`,
                )
          }
        >
          {visibleClues.length === 0 ? (
            <p className="good">
              {threat.masked.length
                ? tr('Every clue found on your device is blurred.', 'Todas las pistas encontradas en tu dispositivo están difuminadas.')
                : tr('None found.', 'No se ha encontrado ninguna.')}
            </p>
          ) : (
            <div>
              <h3>{tr('Location clues found on your device', 'Pistas del lugar encontradas en tu dispositivo')}</h3>
              {visibleClues.map((c, i) => (
                <div key={`${c.cell}-${i}`} className="finding content" style={at(i)}>
                  <code>{tr('cell', 'casilla')} {c.cell}</code> <span>{c.what}</span>
                </div>
              ))}
            </div>
          )}
          {threat.leftVisible.length > 0 && (
            <p className="hint">
              {tr(
                'Left visible: nothing on a person is blurred, and blurring covers at most a quarter of the photo, plus any street name, house number or plate.',
                'Algunas quedan a la vista: no se difumina nada que esté sobre una persona, y el difuminado cubre como mucho una cuarta parte de la foto, además de cualquier nombre de calle, número de portal o matrícula.',
              )}
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
        <h2 id="map-title">{tr('The AI’s guess', 'Lo que adivina la IA')}</h2>
        <span className="chip public">{tr('what the cloud sees', 'lo que ve la nube')}</span>
      </div>
      <p className="section-note">
        {tr(
          'A cloud geolocation AI sees only the version you would post. Your device measures how far off it lands.',
          'Una IA en la nube que sitúa fotos en el mapa solo ve la versión que publicarías. Tu dispositivo mide cuánto falla.',
        )}
      </p>
      {/* Blurred but not attacked again: the last guess is about the photo before, and looked current to a judge (17-nov). */}
      {staleVerdict && (
        <p className="notice slim">
          {tr(
            'Before blurring. Test again to see where it guesses with the blurred photo.',
            'Antes de difuminar. Prueba de nuevo para ver dónde sitúa la foto difuminada.',
          )}
        </p>
      )}
      <div className={staleVerdict ? 'stale' : undefined}>
        <div className={`result ${attacking ? '' : level}`} aria-live="polite">
          <div key={history.length} className={`result-num km ${attacking ? '' : 'land'}`}>
            {attacking ? <span className="spinner" aria-hidden="true" /> : formatKm(kmShown)}
          </div>
          <div className="result-text">
            <strong>{attacking ? tr('The AI is looking at your photo', 'La IA está mirando tu foto') : verdictHeadline}</strong>
            <p>
              {attacking
                ? tr('A cloud AI guesses where it was taken, from what it sees.', 'Una IA en la nube adivina dónde se hizo a partir de lo que ve.')
                : tr(`Guess: ${placeLabel(verdict!.place)}. ${verdictDetail}`, `Su respuesta: ${placeLabel(verdict!.place)}. ${verdictDetail}`)}
              {/* Only the as-is path has a cloud guess from before blurring; on the private path the first test is already blurred. */}
              {!attacking && sentAsIs && history.length > 1 ? tr(` Before blurring: ${formatKm(history[0])}.`, ` Antes de difuminar: ${formatKm(history[0])}.`) : ''}
            </p>
            {!attacking && verdict && published && !sentAsIs && !staleVerdict && readHere.length > 0 && (
              <BeforeAfter
                good={safe}
                before={tr(
                  `Gemini Nano read ${readHere.map((t) => `“${t}”`).join(', ')}${readAddress ? ': an address anyone can look up' : ''}`,
                  `Gemini Nano ha leído ${readHere.map((t) => `«${t}»`).join(', ')}${readAddress ? ': una dirección que cualquiera puede buscar' : ''}`,
                )}
                now={tr(
                  `it guesses “${placeLabel(verdict.place)}”${verdict.errorKm !== null ? `, ${formatKm(verdict.errorKm)} off` : ''}`,
                  `dice «${placeLabel(verdict.place)}»${verdict.errorKm !== null ? `, se equivoca por ${formatKm(verdict.errorKm)}` : ''}`,
                )}
              />
            )}
          </div>
        </div>
        <WorldMap
          you={truthPoint}
          youLabel={source === 'demo' ? tr('The photo', 'La foto') : tr('You', 'Tú')}
          guess={attacking ? null : guess}
          guessLabel={verdict?.place ?? ''}
          distance={!attacking && verdict && verdict.errorKm !== null ? formatKm(verdict.errorKm) : undefined}
          level={level}
        />
        {!attacking && verdict && verdict.clues.length > 0 && (
          <Why summary={safe ? tr('what the AI went by, and still missed', 'en qué se fijó la IA, y aun así falló') : tr('what the AI used', 'lo que usó la IA')}>
            {/* Why blurring stops with these cells still visible: a judge read them as a loop that gave up (17-nov). */}
            {safe && (
              <p className="hint">
                {tr(
                  'Not blurred, because they did not help it find you. Blurring stops here.',
                  'Sin difuminar, porque no le han servido para encontrarte. Aquí termina el difuminado.',
                )}
              </p>
            )}
            <ul className="reasons">
              {/* A cell can hold several clues: keyed by cell alone, React kept a stale item on screen (live, 16-nov). */}
              {verdict.clues.map((c, i) => (
                <li key={`${c.cell}-${i}`}>
                  {tr('Cell', 'Casilla')} {c.cell}: {c.what}
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
        skipped={stage === 'safe' && !published ? [1] : []}
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
