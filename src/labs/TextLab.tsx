import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { readsAsEnglish, styleMarkers, type Reliability } from '../engine/stylometry';
import { DECOYS, DRAFT, MARTA_PUBLIC, SELF_ID } from '../demo/scenario';
import { FIELD_IDS, FIELD_LABELS, FIELD_LABELS_ES, type DecoyPackId } from '../demo/fields';
import { keptPassages, markDeviceError, PrivacyViolation, release, secret, type Private, type Publishable } from '../framework';
import {
  aboutSubject,
  deterministicGeneralise,
  generalisableByHand,
  hasPhrase,
  modifierNames,
  nameDetails,
  quotesNotIn,
  ruleDetails,
  type AuthorshipVerdict,
  type Clue,
} from '../threats/authorship';
import { allowAsIsTest, buildAuthorship, lineupField, loadDecoyPacks, type DecoyPacks } from '../kit';
import { BeforeAfter, ErrorNote, friendlyError, type LabProps } from '../ui/shared';
import { Compare } from '../ui/Compare';
import { Stepper, type StepDef } from '../ui/Stepper';
import { WorkLog, type PlanStep } from '../ui/WorkLog';
import { useGlyphs } from '../ui/glyphs';
import { WriterCard } from '../ui/Writer';
import { Why } from '../ui/Why';
import { useAnimatedNumber, withTransition } from '../ui/motion';
import { useCloudBusy } from '../ui/busy';
import { Mascot, type Pose } from '../ui/Mascot';
import { count, lang, num, tr } from '../i18n';

/** A field's name in the reader's language ("design and product", "diseño y producto"). */
const fieldLabel = (id: DecoyPackId) => tr(FIELD_LABELS[id], FIELD_LABELS_ES[id]);

// The reasons next to each finding come from the fingerprint and the fixed rules in English (tests match them): said in
// Spanish where they are shown. Gemini Nano's own reasons are model output and stay as they came.
const WHY_ES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^You use “(.+)” (\d+)× more than other writers$/, (m) => `Usas «${m[1]}» ${m[2]} veces más que las demás personas`],
  [/^Exact phrase from your public posts$/, () => 'Frase exacta de tus textos públicos'],
  [/^Heavy em-dash habit, same as your public posts$/, () => 'Muchas rayas (—), como en tus textos públicos'],
  [/^A link: fixed rule, no AI\.$/, () => 'Un enlace: regla fija, sin IA.'],
  [/^An email address: fixed rule, no AI\.$/, () => 'Un correo: regla fija, sin IA.'],
  [/^A username: fixed rule, no AI\.$/, () => 'Un nombre de usuario: regla fija, sin IA.'],
  [/^A phone number: fixed rule, no AI\.$/, () => 'Un teléfono: regla fija, sin IA.'],
  [/^A date: fixed rule, no AI\.$/, () => 'Una fecha: regla fija, sin IA.'],
  [/^A count: fixed rule, no AI\.$/, () => 'Una cifra: regla fija, sin IA.'],
  [/^Capital letter: maybe a name, place or company\. Fixed rule, no AI\.$/, () => 'Mayúscula: quizá un nombre, un lugar o una empresa. Regla fija, sin IA.'],
  [/^Flagged by Gemini Nano\.$/, () => 'Lo marcó Gemini Nano.'],
];
const whyText = (why: string) => {
  if (lang !== 'es') return why;
  for (const [re, es] of WHY_ES) {
    const m = why.match(re);
    if (m) return es(m);
  }
  return why;
};

type Stage = 'draft' | 'scanned' | 'attacked' | 'rewritten' | 'reattacked';
const LETTERS = 'ABCDEFGHIJ';
// Fixed seats on screen: you and the nine writers, always in this order (the attacker gets its own shuffle every time).
const SEATS = [3, 7, 0, 5, 9, 1, 8, 2, 6, 4];
const CONFIDENCE: Record<Reliability['level'], string> = {
  'too-short': tr('Too short to tell', 'Demasiado corto para saberlo'),
  low: tr('Low confidence', 'Confianza baja'),
  medium: tr('Medium confidence', 'Confianza media'),
  high: tr('High confidence', 'Confianza alta'),
};
// Find → Fix → Test (22-nov): the original is never tested by default, so `attacked` (found, by the optional as-is test or a
// test of the rewrite) leads back to Fix.
const STAGE_STEP: Record<Stage, number> = { draft: 0, scanned: 1, attacked: 1, rewritten: 2, reattacked: 3 };

// What each long action is expected to leave in the ledger, in order (see threats/authorship.ts).
const SCAN_PLAN: PlanStep[] = [
  { match: /^Fingerprint/, label: tr('Fingerprint your style', 'Tomar tu huella de escritura'), route: 'local-js' },
  { match: /^Find identifying details/, label: tr('Find what identifies you', 'Buscar lo que te identifica'), route: 'on-device', slow: true },
  { match: /^Find counts and dates/, label: tr('Find every count and date', 'Buscar todas las cifras y fechas'), route: 'local-js' },
];
// Without a local model: no model step runs, and capital letters stand in for it as pointers to names.
const SCAN_PLAN_NO_MODEL: PlanStep[] = [
  { match: /^Fingerprint/, label: tr('Fingerprint your style', 'Tomar tu huella de escritura'), route: 'local-js' },
  { match: /^Find identifying details/, label: tr('Find what identifies you', 'Buscar lo que te identifica'), route: 'skipped' },
  { match: /^Find counts, dates and names/, label: tr('Find counts, dates and capitalised names', 'Buscar cifras, fechas y nombres con mayúscula'), route: 'local-js' },
];
const REWRITE_PLAN: PlanStep[] = [
  { match: /^Fixed rules generalised/, label: tr('Generalise the details', 'Generalizar los detalles'), route: 'local-js', optional: true },
  // A long post is rewritten part by part: the step is done with its last part ("Rewrite part 8 of 8 on-device").
  { match: /^Rewrite (?:on-device|part (\d+) of \1 on-device)/, label: tr('Rewrite your style', 'Reescribir tu estilo'), route: 'on-device', slow: true },
  { match: /^Check the final text/, label: tr('Check the final text for details', 'Buscar detalles en el texto final'), route: 'local-js' },
  { match: /^Meaning check/, label: tr('Check that the meaning survived', 'Comprobar que sigue diciendo lo mismo'), route: 'on-device', slow: true },
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The opening of a writer's text, cut at a word: enough to hear the voice and see the field. */
const firstLine = (text: string, max = 120) => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  return `${cut.slice(0, cut.lastIndexOf(' ') > 60 ? cut.lastIndexOf(' ') : max).replace(/[,;:.]+$/, '')}…`;
};
const phraseRe = (p: string) => (p.includes(' ') ? esc(p).replace(/ /g, '[\\s,]+') : p === '—' ? '—' : `\\b${esc(p)}\\b`);
const at = (i: number) => ({ '--i': i }) as CSSProperties;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function Highlighted({ text, marks }: { text: string; marks: { phrase: string; kind: string }[] }) {
  const parts = useMemo(() => {
    if (!marks.length) return [{ t: text, k: '' }];
    const sorted = [...marks].sort((a, b) => b.phrase.length - a.phrase.length);
    const re = new RegExp(`(${sorted.map((m) => phraseRe(m.phrase)).join('|')})`, 'gi');
    const out: { t: string; k: string }[] = [];
    let last = 0;
    for (const m of text.matchAll(re)) {
      out.push({ t: text.slice(last, m.index), k: '' });
      const hit = sorted.find((s) => new RegExp(`^${phraseRe(s.phrase)}$`, 'i').test(m[0]));
      out.push({ t: m[0], k: hit?.kind ?? 'style' });
      last = (m.index ?? 0) + m[0].length;
    }
    out.push({ t: text.slice(last), k: '' });
    return out;
  }, [text, marks]);
  let n = 0;
  return (
    <p className="draft-text">
      {parts.map((p, i) =>
        p.k ? (
          // marked one after another, like a highlighter going through the text
          <mark key={i} className={p.k} style={at(n++)}>
            {p.t}
          </mark>
        ) : (
          <span key={i}>{p.t}</span>
        ),
      )}
    </p>
  );
}

/** Little words everyone uses: in the version you would post they are not habits worth marking. */
const LITTLE_WORDS = new Set(['of', 'the', 'and', 'a', 'an', 'to', 'in', 'on', 'at', 'it', 'is', 'for', 'as', 'by', 'or']);

export function TextLab({ kit, localBackend, degraded, registerLeak, recorded, dock, kept, keep, addWriting, onStarted }: LabProps) {
  const [stage, setStage] = useState<Stage>('draft');
  // Your own post and public writing come back after "Start over" or the Gemini Nano switch (the shell keeps them in memory).
  const [draft, setDraft] = useState(() => (!recorded && kept?.draft) || DRAFT);
  const [edited, setEdited] = useState('');
  const [published, setPublished] = useState<Publishable<string> | null>(null);
  const [clues, setClues] = useState<Clue[]>([]);
  const [verdict, setVerdict] = useState<AuthorshipVerdict | null>(null);
  // The text the last attack sent: what the attacker's reasons are checked against.
  const [attackedText, setAttackedText] = useState('');
  // Reasons that quote words the attacked text does not contain stay folded away until asked for (judge, 17-nov).
  const [showUngrounded, setShowUngrounded] = useState(false);
  const [before, setBefore] = useState<number | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [busySince, setBusySince] = useState<number | null>(null);
  const started = stage !== 'draft' || busy !== '';
  useEffect(() => onStarted?.(started), [started, onStarted]);
  // Gemini Nano download progress, the first time only (live).
  const [download, setDownload] = useState<number | null>(null);
  // Counts finished attacks, so each verdict lands with its own stamp.
  const [attacks, setAttacks] = useState(0);
  const [rounds, setRounds] = useState(1);
  // "Attack it as I would post it" sends the draft as it is: the user's choice, and the chip says so.
  const [sentAsIs, setSentAsIs] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  // Open from the start: a tester did not find the before and after behind a button (22-nov).
  const [showCompare, setShowCompare] = useState(true);
  // Without a local model the fixed rules can still generalise counts and dates in your edit, when you ask (17-nov).
  const [genNote, setGenNote] = useState('');
  // Writing you already published under your name (optional, live only, never stored): the fingerprint compares you with you.
  const [ownPublic, setOwnPublic] = useState(() => (!recorded && kept?.ownPublic) || '');
  useEffect(() => {
    if (!recorded) keep?.({ draft, ownPublic });
  }, [draft, ownPublic, recorded, keep]);
  // "Add my public writing" starts over with the box open, in view and ready to paste into.
  const ownRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const box = ownRef.current;
    if (!kept?.openOwn || !box) return;
    box.open = true;
    box.scrollIntoView({ block: 'center' });
    box.querySelector('textarea')?.focus({ preventScroll: true });
  }, [kept]);
  const ownWords = ownPublic.trim() ? ownPublic.trim().split(/\s+/).length : 0;
  const selfCorpus = ownPublic.trim() || MARTA_PUBLIC;
  const [error, setError] = useState('');
  const privateDraft = useRef<Private<string> | null>(null);
  const acted = useRef(false);

  // One step at a time: a new step slides in over the last one where the browser can (View Transitions), and its title
  // comes into view; so does the verdict after each attack (21-nov plan).
  // What a step brings (the findings, a verdict, the rewrite) changes with it, in one go: set before, it showed on the old
  // step for a moment ("You are one of ten" over a verdict that had found you).
  // Resolves once the new step is on screen, so the button stops spinning on the new step, not on the old one.
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
    // Under the sticky top bar (about 60 px) or low on the screen: bring the step's progress and title up.
    if (top < 64 || top > innerHeight / 2) el.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }, [stage, attacks]);

  // The nine writers next to you write about what you write about, so only your style can single you out (lineupField
  // says why the post's own field does not decide it). Until you add your own public writing, the sample writer stands in
  // for you, and so do the designers next to her. The other fields load only once you open the section for your writing.
  const ownText = recorded ? '' : ownPublic.trim();
  const [field, setField] = useState<DecoyPackId | 'auto'>('auto');
  const [wantPacks, setWantPacks] = useState(false);
  const [packs, setPacks] = useState<DecoyPacks | null>(null);
  const [packsFailed, setPacksFailed] = useState(false);
  const needPacks = ownText !== '';
  useEffect(() => {
    if (!(wantPacks || needPacks) || packs || packsFailed) return;
    let wanted = true;
    loadDecoyPacks().then(
      (m) => wanted && setPacks(m),
      () => wanted && setPacksFailed(true), // offline: the designers stay, and the line under the lineup says so
    );
    return () => {
      wanted = false;
    };
  }, [wantPacks, needPacks, packs, packsFailed]);
  const lineupOf = useMemo(() => lineupField(ownText, packs, field), [ownText, packs, field]);
  const decoys = packs ? packs.DECOY_PACKS[lineupOf.field].decoys : DECOYS;
  // A lineup that is still loading cannot be scanned against: the scan's style habits are measured against these writers.
  const lineupPending = needPacks && !packs && !packsFailed;

  // While an attack waits on a busy cloud model, the actions say so (a retry, or a switch to a backup model).
  const [busyNote, clearBusyNote] = useCloudBusy(kit.cloud, busy === 'attack');
  const threat = useMemo(
    () =>
      buildAuthorship(
        (pickId) => {
          setCurrent(pickId);
          setPicks((p) => [...p, pickId]);
          clearBusyNote();
        },
        ownPublic,
        decoys,
      ),
    [ownPublic, decoys, clearBusyNote],
  );

  // The shell's "Try to leak" button: a careless developer concatenates the draft into a cloud prompt.
  useEffect(() => {
    registerLeak(async () => {
      if (!privateDraft.current) return tr('Scan your post first, so the framework knows what is private.', 'Revisa primero tu post, para que la protección sepa qué es privado.');
      try {
        await kit.cloud.generate(['Summarise this review: ' + draft], { op: 'Leak test: draft in a cloud prompt' });
        return tr('The draft was sent. This should never happen.', 'El borrador se envió. Esto no debería pasar nunca.');
      } catch (e) {
        return e instanceof PrivacyViolation
          ? tr('Blocked by the privacy guard. 0 bytes left the device.', 'Bloqueado por la protección de privacidad. Salieron 0 bytes del dispositivo.')
          : (e as Error).message;
      }
    });
    return () => registerLeak(null);
  }, [kit, draft, registerLeak]);

  // After an action, hand keyboard focus to the next one (only if it was in the actions, so nothing else is taken away).
  useEffect(() => {
    if (!dock || busy || !acted.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && !dock.contains(active)) return;
    // Never the button that would test the original: without Gemini Nano the main one starts disabled, and Enter must not send it.
    dock.querySelector<HTMLElement>('button:not(:disabled):not(.as-is), a[href]')?.focus({ preventScroll: true });
  }, [stage, busy, dock]);

  // Fixed on-screen letters. Only this browser knows which card is "you"; the attacker gets a fresh shuffle each time.
  const lineup = useMemo(() => {
    const ids = [SELF_ID, ...decoys.map((d) => d.id)];
    return SEATS.map((i, k) => ({ id: ids[i], letter: LETTERS[k] }));
  }, [decoys]);
  const corpusOf = (id: string) => (id === SELF_ID ? selfCorpus : (decoys.find((d) => d.id === id)?.corpus ?? ''));
  const corpora = useMemo(() => lineup.map((c) => (c.id === SELF_ID ? selfCorpus : (decoys.find((d) => d.id === c.id)?.corpus ?? ''))), [lineup, selfCorpus, decoys]);
  const glyphs = useGlyphs(corpora);

  const shownText = published ? published.value : stage === 'draft' ? draft : degraded && edited ? edited : draft;
  // The fingerprint is computed once there is something to compare (after the scan), in a background render, so typing
  // never waits for it.
  const fingerprintText = useDeferredValue(stage !== 'draft' ? shownText : '', '');
  const stylo = useMemo(() => (fingerprintText ? threat.fingerprint(fingerprintText) : null), [threat, fingerprintText]);
  const rank = useAnimatedNumber(stylo?.rank ?? 1, { duration: 600 });
  // How far to trust that rank: below 50 words it is not shown at all; above, resampling the words says how much it moves.
  const trust = stylo?.reliability ?? null;
  const tooShort = trust?.level === 'too-short';
  // Habits in the version you would post: only needed once there is one. A single little word ("of") stays in the
  // fingerprint score but is not marked: underlined next to "Copy this version" it read as a contradiction (round 6, 23-nov).
  const liveStyle = useMemo(
    () =>
      published
        ? styleMarkers(shownText, selfCorpus, decoys.map((d) => d.corpus))
            .filter((m) => !LITTLE_WORDS.has(m.phrase.toLowerCase()))
            .map((m) => ({ ...m, kind: 'style' as const }))
        : [],
    [published, shownText, selfCorpus, decoys],
  );
  const styleClues = published ? liveStyle : clues.filter((c) => c.kind === 'style');
  // After a rewrite, trust the fresh on-device re-check of the final text; for a manual edit, fall back to string matching.
  const contentClues = published
    ? threat.lastRewrite
      ? threat.lastRewrite.detailsLeft.map((d) => ({ ...d, kind: 'content' as const }))
      : clues.filter((c) => c.kind === 'content' && hasPhrase(published.value, c.phrase))
    : clues.filter((c) => c.kind === 'content');
  const generalised = published && threat.lastRewrite ? threat.lastRewrite.generalised : [];
  const hits = picks.filter((p) => p === SELF_ID).length;
  // The last COMPLETE attack; scored as a rate over the answers, never as an absolute count.
  const final = verdict && picks.length === verdict.attempts ? verdict : null;
  const inconclusive = final ? threat.inconclusive(final) : false;
  const exposedNow = final ? threat.exposed(final) : false;
  const claims = threat.lastRewrite;

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
      setCurrent(null);
    }
  }

  const prepare = async () => {
    if (!localBackend.prepare) return;
    // A user gesture: Chrome requires it, and it may download Gemini Nano. Its errors are the device's, never the cloud's.
    try {
      await localBackend.prepare((p) => setDownload(p));
    } catch (e) {
      throw markDeviceError(e);
    }
  };

  const scan = () =>
    run('scan', async () => {
      privateDraft.current = secret(draft, 'your draft');
      if (degraded) {
        // No local model: only the deterministic fingerprint and fixed rules run. Nothing is sent anywhere. Capital letters
        // point at names, places and companies, which only a model could find (two testers' names went unflagged, 17-nov).
        const counts = ruleDetails(draft);
        const names = nameDetails(draft).filter((n) => !counts.some((c) => hasPhrase(c.phrase, n.phrase)));
        const rules = [...counts, ...names].map((d) => ({ ...d, kind: 'content' as const }));
        const found = [...styleMarkers(draft, selfCorpus, decoys.map((d) => d.corpus)).map((m) => ({ ...m, kind: 'style' as const })), ...rules];
        kit.ledger.add({ op: 'Fingerprint (Burrows’ Delta)', route: 'local-js', ms: 3, bytesOut: 0 });
        kit.ledger.add({ op: 'Find identifying details', route: 'skipped', ms: 0, bytesOut: 0, note: 'no local model, and not sent to the cloud instead' });
        kit.ledger.add({ op: 'Find counts, dates and names (fixed rules)', route: 'local-js', ms: 1, bytesOut: 0, note: `no model · ${rules.length} found` });
        await go('scanned', () => {
          setClues(found);
          setEdited(draft);
          setGenNote('');
        });
      } else {
        await prepare();
        const found = await threat.findClues(privateDraft.current, kit);
        await go('scanned', () => setClues(found));
      }
    });

  const attack = (target: Publishable<string>, after: boolean) =>
    run('attack', async () => {
      clearBusyNote();
      setAttackedText(target.value);
      setShowUngrounded(false);
      setPicks([]);
      setVerdict(null);
      // The lineup is where the attack shows: bring it into view as it starts.
      requestAnimationFrame(() => document.getElementById('lineup-title')?.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' }));
      const v = await threat.attack(target, kit);
      const landed = () => {
        setVerdict(v);
        setAttacks((n) => n + 1);
      };
      if (threat.inconclusive(v)) {
        // Too few answers: stay on the same step so the user can attack again.
        await go(after ? 'rewritten' : 'scanned', landed);
        return;
      }
      await go(after && !threat.exposed(v) ? 'reattacked' : 'attacked', () => {
        landed();
        if (!after) setBefore(v.hits);
        if (after && threat.exposed(v)) setRounds((r) => r + 1);
      });
    });

  // No local model, no rewrite: the fixed rules still generalise the counts and dates in your edit when you ask, as they do
  // before Gemini Nano rewrites. Names are left to you: the rules would turn "shouted at Kelly" into "shouted somewhere".
  // Only counts with the word they count, and dates: bare numbers stay listed for the user to change.
  // Names before a noun too ("the Lisbon office" → "the office"): a judge's hand edit of the sample kept them (17-nov).
  const ruleCounts = useMemo(
    () =>
      degraded
        ? [...generalisableByHand(ruleDetails(draft).map((d) => d.phrase)), ...modifierNames(draft, nameDetails(draft).map((n) => n.phrase))]
        : [],
    [degraded, draft],
  );
  // While you edit without a local model, what you already removed is crossed out: a tester could not tell what was left (17-nov).
  // Right after the scan too: the fix comes before any test now (22-nov).
  const editingByHand = degraded && (stage === 'scanned' || stage === 'attacked');
  // The edit is the draft until you change it; after a release, the released text.
  const editUnchanged = edited.trim() === (published ? published.value : draft).trim();
  // The same match as the highlighter: a habit like "so honestly i" is still there in "So, honestly, I".
  const goneFromEdit = (phrase: string) => editingByHand && !new RegExp(phraseRe(phrase), 'i').test(edited);
  const generaliseForMe = () => {
    const r = deterministicGeneralise(edited, ruleCounts);
    setEdited(r.text);
    const n = r.done.length;
    const shown = r.done.slice(0, 3).map((d) => `“${d.phrase}” → “${d.generic || tr('removed', 'eliminado')}”`);
    setGenNote(
      n
        ? tr(
            `Generalised ${count(n, ['detail', 'details'], ['detalle', 'detalles'])} with fixed rules, no AI: ${shown.join(', ')}${n > 3 ? ` and ${n - 3} more` : ''}. Names on their own and your habits are still yours to change.`,
            `${count(n, ['detail', 'details'], ['detalle', 'detalles'])} ${n === 1 ? 'generalizado' : 'generalizados'} con reglas fijas, sin IA: ${shown.join(', ')}${n > 3 ? ` y ${n - 3} más` : ''}. Los nombres sueltos y tus hábitos tienes que cambiarlos tú.`,
          )
        : tr('Nothing left that the rules can generalise in your edit.', 'En tu edición ya no queda nada que las reglas puedan generalizar.'),
    );
  };

  // Baseline: the user confirms they would publish the draft exactly as it is, so the attacker may see it.
  const attackAsIs = () => {
    setSentAsIs(true);
    return attack(release(draft, 'baseline — user would publish as-is', { userConfirmedAsIs: true }), false);
  };

  const rewrite = () =>
    run('rewrite', async () => {
      let next: Publishable<string>;
      if (degraded) {
        // release() refuses an edit that still carries about 7 words of the private draft: say which passage (Sam, 17-nov).
        try {
          next = release(edited, 'edited by the user');
          // A step of its own in the receipt: without it, the two attacks' twenty attempts merged into one row (17-nov).
          kit.ledger.add({ op: 'Check your edit for passages of the original', route: 'local-js', ms: 1, bytesOut: 0, note: 'none left · released' });
        } catch (e) {
          // Every passage that still matches, at once: one at a time, a test user's edit was refused four times (17-nov).
          const kept = e instanceof PrivacyViolation ? keptPassages(edited, 4) : [];
          if (!kept.length) throw e;
          const quote = (p: string) => `“${p.length > 140 ? `${p.slice(0, 140)}…` : p}”`;
          const message =
            kept.length === 1
              ? tr(
                  `Your edit still keeps this passage of your original: ${quote(kept[0])}. Put it in other words (about 7 words in a row from your original are refused), then try again.`,
                  `Tu edición aún conserva este fragmento de tu original: ${quote(kept[0])}. Dilo con otras palabras (se rechazan unas 7 palabras seguidas de tu original) y vuelve a intentarlo.`,
                )
              : tr(
                  `Your edit still keeps ${kept.length >= 4 ? 'at least 4' : kept.length} passages of your original: ${kept.map(quote).join(', ')}. Put each in other words (about 7 words in a row from your original are refused), then try again.`,
                  `Tu edición aún conserva ${kept.length >= 4 ? 'al menos 4' : kept.length} fragmentos de tu original: ${kept.map(quote).join(', ')}. Di cada uno con otras palabras (se rechazan unas 7 palabras seguidas de tu original) y vuelve a intentarlo.`,
                );
          throw Object.assign(new Error(message), { name: 'UserFacingError' });
        }
      } else {
        await prepare();
        next = await threat.sanitize(privateDraft.current!, clues, verdict, kit);
      }
      await go('rewritten', () => {
        setPublished(next);
        setPicks([]);
      });
    });

  // You type in the draft; without a local model you also edit it yourself once it has been attacked.
  const editing = stage === 'draft' || editingByHand;
  const working = !degraded && (busy === 'scan' || busy === 'rewrite');

  // The take-away: the version you would post, copied to the clipboard (it never leaves the device this way either).
  const copySafe = async () => {
    if (!published) return;
    try {
      await navigator.clipboard.writeText(published.value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setError(tr('Your browser blocked the clipboard. Select the text and copy it by hand.', 'Tu navegador bloqueó el portapapeles. Selecciona el texto y cópialo a mano.'));
    }
  };

  // Private by default (22-nov): the cloud only ever tests the version you would post. Testing the untouched original is
  // offered only in the recorded demo (nothing is sent) or on a paid plan (`allowAsIsTest`).
  const canTestOriginal = recorded || allowAsIsTest;
  const steps: StepDef[] = [
    { label: tr('Find', 'Buscar'), where: degraded ? tr('fixed rules, no model', 'reglas fijas, sin modelo') : tr('on your device', 'en tu dispositivo') },
    { label: tr('Fix', 'Arreglar'), where: degraded ? tr('you edit it', 'lo editas tú') : tr('on your device', 'en tu dispositivo') },
    { label: tr('Test', 'Probar'), where: tr('in the cloud', 'en la nube') },
  ];
  const outcome = stage === 'reattacked' ? (contentClues.length ? 'warn' : 'good') : null;
  // A post of the user's own with no public writing of theirs: the lineup then looks for the sample writer, not for them,
  // and the verdict says nothing about them. Said before scanning, before attacking and in the verdict (judge, 17-nov).
  const standIn = !recorded && !ownText && draft.trim() !== '' && draft !== DRAFT;
  // The attacker names writers by the letters of its own shuffle, while on screen every writer keeps a fixed seat: a reason
  // called the user "Writer H", seated at C (17-nov). Its letters are put back to the seats.
  const seatOf = (id?: string) => lineup.find((s) => s.id === id)?.letter;
  const relabel = (r: string) => {
    const order = verdict?.reasonsOrder;
    if (!order) return r;
    return r.replace(/\b(Writer|writer) ([A-J])\b/g, (m: string, w: string, l: string) => {
      const seat = seatOf(order[LETTERS.indexOf(l)]);
      return seat ? `${w} ${seat}` : m;
    });
  };
  // A quote from the writer the reasons are about is grounded too: it is that writer's text, not a guess. Folded as made up,
  // it made all three testers doubt the reasons (17-nov).
  const pickCorpus = verdict?.reasonsPick === SELF_ID ? selfCorpus : (decoys.find((d) => d.id === verdict?.reasonsPick)?.corpus ?? '');
  const reasonItems = verdict
    ? verdict.reasons.map(relabel).map((r) => {
        const notInPost = quotesNotIn(r, attackedText);
        // Made up only if it is in none of the texts the attacker was given: the post and the ten writers.
        const notIn = notInPost.length ? quotesNotIn(r, [attackedText, selfCorpus, ...decoys.map((d) => d.corpus)].join('\n')) : [];
        const fromPick = pickCorpus ? notInPost.filter((q) => quotesNotIn(`“${q}”`, pickCorpus).length === 0) : [];
        // "Writer C" is your seat: a tester could not tell whether C was her or a public writer (17-nov).
        const namesYou = new RegExp(`\\bWriter ${seatOf(SELF_ID)}\\b`, 'i').test(r);
        return { r, notIn, fromPick, fromOther: !fromPick.length && notInPost.length > notIn.length, namesYou };
      })
    : [];
  // Reasons for a pick that is not you are about another writer's text: a tester read "refund policies" as about him (17-nov).
  const reasonsSeat = verdict?.reasonsPick && verdict.reasonsPick !== SELF_ID ? seatOf(verdict.reasonsPick) : undefined;
  const shownReasons = reasonItems.filter((x) => x.notIn.length === 0 || showUngrounded);
  const foldedReasons = showUngrounded ? 0 : reasonItems.length - shownReasons.length;
  // Found by what the post is about, not by how it is written: the decoys may be from another field.
  const bySubject = !!final && exposedNow && !standIn && !inconclusive && reasonItems.some((x) => aboutSubject(x.r, packs?.FIELD_WORDS, attackedText));
  // The fingerprint says your habits no longer stand out, yet the attacker still picks you: a tester read the two as
  // contradicting each other (17-nov). It goes by your subject or your details, and the note says so.
  const rankShown = !!stylo && !tooShort && !standIn;
  const styleGone = !!final && exposedNow && !inconclusive && rankShown && !!stylo && stylo.rank >= 6;
  // The "before", measured on this device: where the draft's own style ranks among the ten (the shown rank follows the
  // version you would post once there is one), with the habits and details the scan found. Nothing is sent to know it.
  const pastDraft = stage !== 'draft';
  const draftPrint = useMemo(() => (pastDraft ? threat.fingerprint(draft) : null), [threat, draft, pastDraft]);
  const rankBefore = draftPrint && draftPrint.reliability?.level !== 'too-short' && !standIn ? Math.round(draftPrint.rank) : null;
  const habitsBefore = clues.filter((c) => c.kind === 'style').length;
  const detailsBefore = clues.filter((c) => c.kind === 'content').length;

  // Whose field the nine writers share, and what follows from it.
  const canPickField = stage === 'draft' && !!ownText && !!packs;
  // "like you" read as "they resemble you" to both testers (16-nov): the field is what is shared, so it says so.
  const sameField = tr(
    ', the same field as you: the AI has to recognise your style, not your subject.',
    ', el mismo sector que tú: la IA tiene que reconocer tu estilo, no tu tema.',
  );
  const fieldNote = !ownText
    ? recorded || draft === DRAFT
      ? sameField
      : tr(
          ', the sample writer’s field: she stands in for you until you add your own public writing.',
          ', el sector de la persona de ejemplo: ocupa tu lugar hasta que añadas tus propios textos públicos.',
        )
    : packsFailed
      ? tr(' (the other fields did not load).', ' (los otros sectores no se cargaron).')
      : !lineupOf.clear
        ? tr(
            `: no field stood out in your writing${stage === 'draft' ? ', so pick the closest one' : ''}.`,
            `: en tus textos no destaca ningún sector${stage === 'draft' ? ', así que elige el más cercano' : ''}.`,
          )
        : lineupOf.wanted === lineupOf.matched
          ? sameField
          : tr(
              `. Your writing reads as ${FIELD_LABELS[lineupOf.matched]}, so the AI may go by subject, not style.`,
              `. Tus textos parecen de ${FIELD_LABELS_ES[lineupOf.matched]}, así que la IA puede fijarse en el tema, no en el estilo.`,
            );

  const busyLabel =
    busy === 'scan'
      ? degraded
        ? tr('Scanning…', 'Revisando…')
        : tr('Scanning on your device…', 'Revisando en tu dispositivo…')
      : busy === 'attack'
        ? tr(`Testing · ${Math.min(picks.length + 1, 10)} of 10`, `Probando · ${Math.min(picks.length + 1, 10)} de 10`)
        : busy === 'rewrite'
          ? degraded
            ? tr('Checking your edit…', 'Comprobando tu edición…')
            : tr('Rewriting on your device…', 'Reescribiendo en tu dispositivo…')
          : '';

  // ── what this step says: a title and one sentence ──
  const nHabits = styleClues.length;
  const nDetails = contentClues.length;
  const verdictTitle = standIn
    ? tr('Not a test of you yet', 'Esta prueba aún no es sobre ti')
    : exposedNow
      ? tr('The AI found you', 'La IA te encontró')
      : tr('You are one of ten', 'Eres una persona más entre diez');
  const head: { title: ReactNode; lede: string } =
    stage === 'draft'
      ? {
          title:
            lang === 'es' ? (
              <>
                Antes de publicar de forma anónima, mira <span className="marker">qué te delata</span>.
              </>
            ) : (
              <>
                Before you post anonymously, see <span className="marker">what gives you away</span>.
              </>
            ),
          lede: recorded
            ? tr(
                'A recorded run: Gemini Nano’s answers on this sample post were recorded in Chrome, and replay here.',
                'Una revisión grabada: las respuestas de Gemini Nano a este post de ejemplo se grabaron en Chrome y se reproducen aquí.',
              )
            : tr(
                'Throwaway checks and fixes your post on this device. Only the version you would post is tested in the cloud, when you choose.',
                'Throwaway revisa y arregla tu post en este dispositivo. En la nube solo se prueba la versión que publicarías, cuando tú decidas.',
              ),
        }
      : stage === 'scanned'
        ? {
            title: nHabits + nDetails
              ? tr(
                  `${capital(count(nHabits, ['habit', 'habits'], ['hábito', 'hábitos']))} and ${count(nDetails, ['detail', 'details'], ['detalle', 'detalles'])} could give you away`,
                  `${capital(count(nHabits, ['habit', 'habits'], ['hábito', 'hábitos']))} y ${count(nDetails, ['detail', 'details'], ['detalle', 'detalles'])} podrían delatarte`,
                )
              : tr('Nothing obvious gives you away', 'No hay nada evidente que te delate'),
            lede: degraded
              ? tr(
                  'Found with fixed rules on this device; names only by their capital letters. Change them in your post below: nothing has left this device.',
                  'Encontrados con reglas fijas en este dispositivo; los nombres, solo por sus mayúsculas. Cámbialos en tu post, aquí abajo: nada ha salido de este dispositivo.',
                )
              : tr(
                  'Found on this device, and nothing has left it. Next, Gemini Nano rewrites your style and these details, here.',
                  'Encontrados en este dispositivo, y nada ha salido de él. Ahora Gemini Nano reescribe tu estilo y estos detalles, aquí mismo.',
                ),
          }
        : stage === 'attacked'
          ? {
              title: verdictTitle,
              lede: degraded
                ? tr(
                    'No on-device AI here, so you change it: your habits and details are marked in the post below.',
                    'No hay IA en este dispositivo, así que lo cambias tú: tus hábitos y detalles están marcados en el post, aquí abajo.',
                  )
                : rounds > 1
                  ? tr(
                      'Still found after a rewrite. Gemini Nano can rewrite it again, keeping in mind what the AI went by.',
                      'Te encontró incluso después de reescribirlo. Gemini Nano puede reescribirlo otra vez, teniendo en cuenta en qué se fijó la IA.',
                    )
                  : exposedNow
                    ? tr('Next, Gemini Nano rewrites your style and the details, on this device.', 'Ahora Gemini Nano reescribe tu estilo y los detalles, en este dispositivo.')
                    : tr(
                        'You could post it as it is. Gemini Nano can still rewrite it on this device, to be safe.',
                        'Podrías publicarlo tal cual. Aun así, Gemini Nano puede reescribirlo en este dispositivo, por si acaso.',
                      ),
            }
          : stage === 'rewritten'
            ? {
                title: degraded ? tr('Your edited version', 'Tu versión editada') : tr('Rewritten on your device', 'Reescrito en tu dispositivo'),
                lede: degraded
                  ? tr(
                      'Checked on this device: no long passage of your original is left. Next, test it: only this version goes to the cloud.',
                      'Comprobado en este dispositivo: no queda ningún fragmento largo de tu original. Ahora pruébalo: a la nube solo va esta versión.',
                    )
                  : tr(
                      'Gemini Nano wrote it in new sentences, trying to keep your tone: your habits and your details were what gave you away. Read it, then test it: only this version goes to the cloud.',
                      'Gemini Nano lo ha escrito con frases nuevas, intentando conservar tu tono: lo que te delataba eran tus muletillas y tus detalles. Léelo y luego pruébalo: a la nube solo va esta versión.',
                    ),
              }
            : {
                title: nDetails
                  ? tr(
                      `Your style is hidden, but ${count(nDetails, ['detail', 'details'], ['detalle', 'detalles'])} can still identify you`,
                      `Tu estilo está oculto, pero ${count(nDetails, ['detail', 'details'], ['detalle', 'detalles'])} ${nDetails === 1 ? 'aún puede' : 'aún pueden'} identificarte`,
                    )
                  : verdictTitle,
                lede: standIn
                  ? tr(
                      'Without your own public writing, this test looked for the sample writer, not you.',
                      'Sin tus propios textos públicos, esta prueba buscó a la persona de ejemplo, no a ti.',
                    )
                  : nDetails
                    ? tr('Change them before you post.', 'Cámbialos antes de publicar.')
                    : // "No identifying details are left" overclaimed: the rewrite still named the design team (a tester, 22-nov).
                      tr(
                        `It cannot tell you apart from the other nine writers${degraded ? ', and no counts or dates are left. Names, places and companies were not checked.' : ', and the details your device found were generalised.'}`,
                        `La IA no te distingue de las otras nueve personas${degraded ? ', y no quedan cifras ni fechas. Los nombres, lugares y empresas no se comprobaron.' : ', y se generalizaron los detalles que encontró tu dispositivo.'}`,
                      ),
              };

  // ── the note before the button: one, the one that matters most ──
  const note: { text: string; warn: boolean; consent?: boolean } | null =
    stage === 'draft'
      ? standIn
        ? {
            text: tr(
              'Without your own public writing, the test will look for the sample writer, not you. Add yours under the post first.',
              'Sin tus propios textos públicos, la prueba buscará a la persona de ejemplo, no a ti. Antes, añade los tuyos debajo del post.',
            ),
            warn: true,
          }
        : !recorded && readsAsEnglish(draft) === false
          ? {
              text: tr(
                'This post does not read as English. Throwaway is tuned for English: counts, dates and habits in other languages are mostly not caught, and the rewrite comes back in English.',
                'Este post no parece estar en inglés. Throwaway está pensado para el inglés: en otros idiomas se le escapan la mayoría de las cifras, fechas y hábitos, y la reescritura sale en inglés.',
              ),
              warn: true,
            }
          : null
      : stage === 'scanned'
        ? standIn
          ? {
              text: tr(
                'No public writing of yours: this test looks for the sample writer, not you. Start over to add yours: your post stays.',
                'No hay textos públicos tuyos: esta prueba busca a la persona de ejemplo, no a ti. Empieza de nuevo para añadir los tuyos: tu post no se pierde.',
              ),
              warn: true,
            }
          : canTestOriginal && !recorded
            ? // Only on a paid plan: the one step that would send the original, said before the tap (judge 17-nov, testers 22-nov).
              {
                text: tr(
                  'Testing the original sends your post, unchanged, to Gemini in Google’s cloud, ten times, as if you had posted it. Fixing it first sends nothing.',
                  'Probar el original envía tu post, sin cambios, a Gemini en la nube de Google, diez veces, como si lo hubieras publicado. Arreglarlo antes no envía nada.',
                ),
                warn: true,
                consent: true,
              }
            : null
        : stage === 'rewritten' && published
          ? recorded
            ? {
                text: tr(
                  'A recorded run: nothing is sent. Live, only this version goes to Gemini, on Google’s free plan.',
                  'Una revisión grabada: no se envía nada. En vivo, solo esta versión va a Gemini, en el plan gratuito de Google.',
                ),
                warn: false,
              }
            : // What Gemini's free plan allows, said before the tap (22-nov): only what you would post anyway goes.
              {
                text: tr(
                  `Sends only ${degraded ? 'your edited version' : 'this version'}, never your original, to Gemini on Google’s free plan: Google may use it to improve its products, and people may review it. It is what you are about to post for everyone anyway.`,
                  `Envía solo ${degraded ? 'tu versión editada' : 'esta versión'}, nunca tu original, a Gemini en el plan gratuito de Google: Google puede usarla para mejorar sus productos, y una persona puede revisarla. Es lo que vas a publicar para todo el mundo de todos modos.`,
                ),
                warn: true,
                consent: true,
              }
          : null;

  const actions = (
    <>
      {working && busySince !== null && (
        <WorkLog
          ledger={kit.ledger}
          since={busySince}
          plan={busy === 'scan' ? (degraded ? SCAN_PLAN_NO_MODEL : SCAN_PLAN) : REWRITE_PLAN}
          title={
            busy === 'scan'
              ? tr('Scanning your post on this device', 'Revisando tu post en este dispositivo')
              : tr('Fixing your post on this device', 'Arreglando tu post en este dispositivo')
          }
          recorded={recorded}
          download={download}
        />
      )}
      {busyNote && (
        <p className="dock-note busy" role="status">
          {busyNote}
        </p>
      )}
      {!busy && note && <p className={`dock-note ${note.consent ? 'consent' : note.warn ? 'warn' : ''}`}>{note.text}</p>}
      <div className="dock-row">
        {stage === 'draft' && (
          <button className="primary" onClick={scan} disabled={!!busy || !draft.trim() || lineupPending} aria-busy={busy === 'scan'}>
            {busy ? <Busy label={busyLabel} /> : tr('Check my post on this device', 'Revisar mi post en este dispositivo')}
          </button>
        )}
        {(stage === 'scanned' || stage === 'attacked') && (
          // Fix first, on the device: nothing has to leave it to find out (22-nov). Nothing edited yet, nothing to use: the
          // button read as a step already done to a tester (17-nov).
          <button className="primary" onClick={rewrite} disabled={!!busy || (degraded && editUnchanged)} aria-busy={busy === 'rewrite'}>
            {busy === 'rewrite'
              ? <Busy label={busyLabel} />
              : degraded
                ? editUnchanged
                  ? tr('Edit your post below first', 'Primero edita tu post, aquí abajo')
                  : tr('Use my edited version', 'Usar mi versión editada')
                : published
                  ? tr('Rewrite it again on this device', 'Reescribirlo otra vez en este dispositivo')
                  : tr('Rewrite it on this device', 'Reescribirlo en este dispositivo')}
          </button>
        )}
        {/* Testing the untouched original: never the main action, and never the one that gets focus (`.as-is`). Only in the
            recorded demo, where nothing is sent, or on a paid plan (22-nov). */}
        {stage === 'scanned' && canTestOriginal && !standIn && (
          <button
            className="ghost as-is"
            onClick={attackAsIs}
            disabled={!!busy}
            aria-busy={busy === 'attack'}
            title={recorded ? tr('A recorded run: nothing is sent', 'Revisión grabada: no se envía nada') : undefined}
          >
            {busy === 'attack' ? (
              <Busy label={busyLabel} />
            ) : recorded ? (
              tr('First, test the original (recorded)', 'Probar primero el original (grabado)')
            ) : (
              tr('First, test my original', 'Probar primero mi original')
            )}
          </button>
        )}
        {stage === 'rewritten' && published && (
          <button className="primary" onClick={() => attack(published, true)} disabled={!!busy} aria-busy={busy === 'attack'}>
            {busy ? <Busy label={busyLabel} /> : attacks > 0 ? tr('Test again', 'Probar de nuevo') : tr('Test it', 'Probarlo')}
          </button>
        )}
        {stage === 'reattacked' && published && (
          <button className="primary" onClick={copySafe}>
            {copied ? tr('Copied', 'Copiado') : tr('Copy this version', 'Copiar esta versión')}
          </button>
        )}
      </div>
    </>
  );

  // ── pieces ──
  const findings = (
    <div className="findings" key={published ? 'after' : 'before'}>
      <div className="finding-col">
        <h3>{tr('Style habits', 'Hábitos al escribir')}</h3>
        {styleClues.length === 0 ? (
          <p className="good rise">{tr('No habits from your public writing.', 'No aparece ningún hábito de tus textos públicos.')}</p>
        ) : (
          styleClues.map((m, i) => (
            <div key={`${m.phrase}-${i}`} className={`finding style rise ${goneFromEdit(m.phrase) ? 'gone' : ''}`} style={at(i)}>
              <code>{m.phrase}</code>{' '}
              <span>
                {whyText(m.why)}
                {goneFromEdit(m.phrase) && <em className="gone-tag">{tr(' · gone from your edit', ' · ya no está en tu edición')}</em>}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="finding-col">
        <h3>{tr('Identifying details', 'Detalles que te identifican')}</h3>
        {contentClues.length === 0 ? (
          <p className="good rise">
            {degraded
              ? published
                ? tr('No counts, dates or capitalised names left.', 'No quedan cifras, fechas ni nombres con mayúscula.')
                : tr('No counts, dates or capitalised names found.', 'No se encontraron cifras, fechas ni nombres con mayúscula.')
              : published
                ? tr('None left (checked on your device).', 'No queda ninguno (comprobado en tu dispositivo).')
                : tr('None found.', 'No se encontró ninguno.')}
          </p>
        ) : (
          contentClues.map((m, i) => (
            <div key={`${m.phrase}-${i}`} className={`finding content rise ${goneFromEdit(m.phrase) ? 'gone' : ''}`} style={at(i)}>
              <code>{m.phrase}</code>{' '}
              <span>
                {whyText(m.why)}
                {goneFromEdit(m.phrase) && <em className="gone-tag">{tr(' · gone from your edit', ' · ya no está en tu edición')}</em>}
              </span>
            </div>
          ))
        )}
        {generalised.map((g, i) => (
          <div key={`${g.phrase}-${i}`} className="finding generalised rise" style={at(i)}>
            <code>{g.phrase}</code>{' '}
            <span>
              {g.generic ? `→ “${g.generic.length > 70 ? `${g.generic.slice(0, 70)}…` : g.generic}”` : tr('→ removed', '→ eliminado')}
              <em className="by">
                {g.by === 'rule' ? tr(' · fixed rule, no AI', ' · regla fija, sin IA') : ' · Gemini Nano'}
                {tr(', on your device', ', en tu dispositivo')}
              </em>
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  // Without a local model only the fixed rules ran: say what that left unchecked, where the findings are (16-nov).
  const unchecked = degraded && (
    <p className="unchecked">
      <strong>{tr('Names, places and companies: only guessed from capital letters.', 'Nombres, lugares y empresas: solo se adivinan por las mayúsculas.')}</strong>{' '}
      {tr(
        'There is no local model on this device, so read your post for them too before you post.',
        'No hay un modelo local en este dispositivo, así que búscalos tú también en tu post antes de publicarlo.',
      )}
    </p>
  );

  const fingerprint = (
    <div className="meter">
      <div className="meter-top">
        {/* While you edit by hand the rank follows your edit: it moved with no word of why for a tester (17-nov). */}
        <span className="meter-label">
          {editingByHand ? tr('Your edit’s rank', 'El puesto de tu edición') : tr('Your rank', 'Tu puesto')}
          {tr(' among ten writers: #1 reads most like you, #10 least', ' entre diez personas: el #1 es el que más suena a ti; el #10, el que menos')}
        </span>
        <strong className={!rankShown || !stylo ? '' : stylo.rank <= 2 ? 'bad' : stylo.rank <= 5 ? 'warn' : 'good'}>
          #{rankShown ? Math.round(rank) : '–'} <span>{tr('of 10', 'de 10')}</span>
        </strong>
      </div>
      <div className="bar">
        <i style={{ transform: `scaleX(${rankShown && stylo ? stylo.score : 0})` }} className={(stylo?.score ?? 0) > 0.6 ? 'bad' : 'good'} />
      </div>
      {trust && !standIn && (
        <div className={`trust ${trust.level}`}>
          <span className="conf">{CONFIDENCE[trust.level]}</span>
          {!tooShort && (
            <span>
              {trust.rankRange[0] === trust.rankRange[1]
                ? tr(`Steady at #${trust.rankRange[0]}`, `Estable en el #${trust.rankRange[0]}`)
                : tr(`Likely #${trust.rankRange[0]} to #${trust.rankRange[1]}`, `Probablemente entre el #${trust.rankRange[0]} y el #${trust.rankRange[1]}`)}
            </span>
          )}
          {trust.notes.length > 0 && <p className="trust-notes">{trust.notes.join(' ')}</p>}
        </div>
      )}
      {/* What the rank means, in words: "#2 of 10" read as good to a tester (17-nov). */}
      {rankShown && stylo && (
        <p className="meter-read">
          {stylo.rank <= 2
            ? tr('It reads a lot like your public writing: easy to link.', 'Suena mucho a tus textos públicos: es fácil relacionarlo contigo.')
            : stylo.rank <= 5
              ? tr('It reads somewhat like your public writing.', 'Suena un poco a tus textos públicos.')
              : tr('It reads less like you than most of the other writers.', 'Suena menos a ti que a la mayoría de las otras personas.')}
        </p>
      )}
      <small>
        {tr(
          'Local fingerprint: Burrows’ Delta on function words, range from 100 resamples · in your browser · 0 bytes sent',
          'Huella de escritura local: Delta de Burrows con palabras funcionales, rango a partir de 100 remuestreos · en tu navegador · 0 bytes enviados',
        )}
      </small>
      {/* Without your writing there is no rank of you: the sample writer's rank confused a tester (17-nov). */}
      {standIn && <p className="hint">{tr('Add your own public writing to see how much your post reads like you.', 'Añade tus propios textos públicos para ver cuánto suena tu post a ti.')}</p>}
    </div>
  );

  const meaning = published && claims && (claims.meaningCheck === 'failed' || claims.claims.length > 0) && (
    <div className={`claims ${claims.meaningCheck === 'failed' ? 'failed' : ''}`}>
      {claims.meaningCheck === 'failed' ? (
        <>
          <h3>{tr('Same meaning? No answer', '¿Dice lo mismo? Sin respuesta')}</h3>
          <p>
            {tr(
              'Gemini Nano gave no readable answer, so nothing checked that the rewrite still says what you meant. Read it before you post.',
              'Gemini Nano no dio una respuesta legible, así que no se comprobó que la reescritura siga diciendo lo que querías decir. Léela antes de publicar.',
            )}
          </p>
        </>
      ) : (
        <>
          <h3>
            {tr(
              `Same meaning? ${claims.claims.filter((c) => c.kept).length} of ${claims.claims.length} claims kept · checked on your device`,
              `¿Dice lo mismo? ${claims.claims.filter((c) => c.kept).length} de ${claims.claims.length} puntos conservados · comprobado en tu dispositivo`,
            )}
          </h3>
          <ul>
            {claims.claims.map((c, i) => (
              <li key={`${c.claim}-${i}`} className={c.kept ? '' : 'lost'}>
                <span aria-hidden="true">{c.kept ? '✓' : '✗'}</span> {c.claim}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
  const claimsKept = claims ? claims.claims.filter((c) => c.kept).length : 0;
  const lost = !!claims && claims.claims.length > 0 && claimsKept < claims.claims.length;

  // ── your post: the draft, then what was found in it, then the version you would post ──
  const postLabel = published
    ? degraded
      ? tr('Your edit', 'Tu edición')
      : tr('The rewritten version', 'La versión reescrita')
    : editingByHand
      ? tr('Your edit', 'Tu edición')
      : recorded
        ? tr('Sample post', 'Post de ejemplo')
        : tr('Your post', 'Tu post');
  const post = (
    <section className="post panel" aria-labelledby="post-title">
      <div className="post-head">
        <h2 id="post-title">{postLabel}</h2>
        <span className={`chip ${!published && sentAsIs ? 'asis' : 'private'}`}>
          {published
            ? tr('what you would post', 'lo que publicarías')
            : sentAsIs
              ? tr('sent as it is to the AI · your choice', 'enviado tal cual a la IA · decisión tuya')
              : tr('private · stays on this device', 'privado · se queda en este dispositivo')}
        </span>
      </div>
      <div className={`sheet-wrap ${working ? 'reading' : ''}`}>
        {editing ? (
          <textarea
            ref={textareaRef}
            aria-labelledby="post-title"
            placeholder={tr('Paste the post you are about to publish…', 'Pega el post que vas a publicar…')}
            readOnly={recorded && stage === 'draft'}
            value={stage === 'draft' ? draft : edited}
            onChange={(e) => (stage === 'draft' ? setDraft(e.target.value) : setEdited(e.target.value))}
            rows={9}
          />
        ) : (
          <Highlighted key={published ? 'final' : 'draft'} text={shownText} marks={[...styleClues, ...contentClues]} />
        )}
      </div>

      {stage === 'draft' && (
        <div className="tools">
          <span className="hint">
            {recorded
              ? tr('The sample post is fixed in a recorded run.', 'En una revisión grabada, el post de ejemplo no se puede cambiar.')
              : draft === DRAFT
                ? tr('Sample post: an anonymous review of an employer. Edit it, or paste yours.', 'Post de ejemplo (en inglés): una reseña anónima de una empresa. Edítalo o pega el tuyo.')
                : tr('Your post stays on this device until you choose to test it.', 'Tu post se queda en este dispositivo hasta que decidas probarlo.')}
          </span>
          {recorded ? (
            <a className="hint-link" href={location.pathname}>
              {tr('Check your own post, live', 'Revisar tu propio post, en vivo')}
            </a>
          ) : (
            <button
              className="mini"
              onClick={() => {
                setDraft('');
                textareaRef.current?.focus();
              }}
            >
              {tr('Paste my own post', 'Pegar mi propio post')}
            </button>
          )}
        </div>
      )}
      {stage === 'draft' && !recorded && (
        <details ref={ownRef} className="disclosure own-writing" onToggle={(e) => e.currentTarget.open && setWantPacks(true)}>
          {/* The count against the 150 a fingerprint needs, as you type: a tester stopped at 141 without knowing (17-nov). */}
          <summary>
            {tr('Compare with your own public writing', 'Comparar con tus propios textos públicos')}
            <span className="why-s">
              {ownWords
                ? tr(`${num(ownWords)}${ownWords < 150 ? ' of 150' : ''} words`, `${num(ownWords)}${ownWords < 150 ? ' de 150' : ''} palabras`)
                : tr('optional', 'opcional')}
            </span>
          </summary>
          <div className="disclosure-body">
            <p className="hint">
              {tr(
                'Paste things you have already published under your name, 150 words or more: blog posts, LinkedIn posts, comments. The fingerprint compares them with your anonymous post on this device. For the attack they go to the cloud as one of the ten writers, so paste only writing that is already public. Nothing is stored.',
                'Pega textos que ya hayas publicado con tu nombre, 150 palabras o más: entradas de blog, posts de LinkedIn, comentarios. La huella de escritura los compara con tu post anónimo en este dispositivo. Para la prueba, van a la nube como una de las diez personas, así que pega solo textos que ya sean públicos. No se guarda nada.',
              )}
            </p>
            <textarea
              aria-label={tr('Your public writing', 'Tus textos públicos')}
              rows={5}
              value={ownPublic}
              onChange={(e) => setOwnPublic(e.target.value)}
              placeholder={tr('Paste a few paragraphs you have published under your name…', 'Pega unos párrafos que hayas publicado con tu nombre…')}
            />
            {ownWords > 0 && ownWords < 150 && (
              <p className="hint">{tr('At least 150 words make a useful fingerprint.', 'Hacen falta al menos 150 palabras para una huella de escritura útil.')}</p>
            )}
            {canPickField && (
              <p className="field-line">
                <label>
                  {tr('The other nine writers write about', 'Las otras nueve personas escriben sobre')}{' '}
                  <select
                    value={lineupOf.wanted}
                    disabled={!!busy}
                    onChange={(e) => {
                      const id = e.target.value as DecoyPackId;
                      setField(id === lineupOf.matched ? 'auto' : id);
                    }}
                  >
                    {FIELD_IDS.map((id) => (
                      <option key={id} value={id}>
                        {fieldLabel(id)}
                      </option>
                    ))}
                  </select>
                </label>
                {fieldNote}
              </p>
            )}
          </div>
        </details>
      )}

      {stage !== 'draft' && !editing && (nHabits > 0 || nDetails > 0) && (
        <p className="legend" aria-hidden="true">
          {nHabits > 0 && <span className="key style">{tr('Habit your public writing shares', 'Hábito que comparten tus textos públicos')}</span>}
          {nDetails > 0 && <span className="key content">{tr('Detail that identifies you', 'Detalle que te identifica')}</span>}
        </p>
      )}

      {editingByHand && (
        <>
          <div className="tools">
            {/* Steps, not a goal: a tester without Gemini Nano did not know what to change (17-nov). */}
            <span className="hint">
              {tr(
                'Press the button for counts, dates and some names. Then change the rest yourself: a name becomes a role (“the regional manager”), and the words under your habits go.',
                'Pulsa el botón para las cifras, las fechas y algunos nombres. Luego cambia tú el resto: un nombre pasa a ser un cargo (“the regional manager”) y las palabras marcadas como hábitos se quitan.',
              )}
            </span>
            {ruleCounts.length > 0 && (
              <button className="mini" onClick={generaliseForMe}>
                {tr('Generalise details for me', 'Generalizar los detalles por mí')}
              </button>
            )}
          </div>
          {genNote && (
            <p className="hint gen-note" role="status">
              {genNote}
            </p>
          )}
          <div className="to-change">
            {findings}
            {unchecked}
          </div>
        </>
      )}

      {published && (
        <div className="tools">
          <span className="hint">
            {/* Only says the meaning was checked when it was: not for a hand edit, nor when the check failed (22-nov). */}
            {degraded || !claims || claims.meaningCheck === 'failed' || claims.claims.length === 0
              ? tr('Read it before you post: check that it still says what you meant.', 'Léelo antes de publicar: comprueba que sigue diciendo lo que querías.')
              : claims.claims.every((c) => c.kept)
                ? tr(
                    'Read it before you post. A small model on your device checked that it still says what you said; check it yourself too.',
                    'Léelo antes de publicar. Un modelo pequeño de tu dispositivo comprobó que sigue diciendo lo mismo; compruébalo tú también.',
                  )
                : tr(
                    'Read it before you post: the check on your device found a point that may have changed (see “Why?” below).',
                    'Léelo antes de publicar: la comprobación de tu dispositivo encontró un punto que puede haber cambiado (mira «¿Por qué?» abajo).',
                  )}
          </span>
          <span className="tools-end">
            <button className="mini" aria-expanded={showCompare} onClick={() => setShowCompare((v) => !v)}>
              {showCompare ? tr('Hide the comparison', 'Ocultar la comparación') : tr('Compare with your original', 'Comparar con tu original')}
            </button>
            {/* At the end, copying is the step's own button: one Copy, not two (21-nov plan). */}
            {stage !== 'reattacked' && (
              <button className="mini" onClick={copySafe}>
                {copied ? tr('Copied', 'Copiado') : tr('Copy', 'Copiar')}
              </button>
            )}
          </span>
        </div>
      )}
      {published && showCompare && <Compare original={draft} final={published.value} />}
      {/* A failed or lossy meaning check is said where the text is, not only behind "Why?". */}
      {published && claims?.meaningCheck === 'failed' && (
        <p className="notice slim">
          {tr(
            'Gemini Nano gave no answer on the meaning: read the rewrite against your post before you post it.',
            'Gemini Nano no respondió sobre el sentido: compara la reescritura con tu post antes de publicarla.',
          )}
        </p>
      )}

      {stage !== 'draft' && !editingByHand && (
        <Why
          summary={
            published && claims
              ? tr(
                  `${count(generalised.length, ['detail', 'details'], ['detalle', 'detalles'])} generalised${claims.claims.length ? ` · ${claimsKept} of ${claims.claims.length} claims kept` : ''}`,
                  `${count(generalised.length, ['detail', 'details'], ['detalle', 'detalles'])} ${generalised.length === 1 ? 'generalizado' : 'generalizados'}${claims.claims.length ? ` · ${claimsKept} de ${claims.claims.length} puntos conservados` : ''}`,
                )
              : published
                ? tr(
                    `${count(nHabits, ['habit', 'habits'], ['hábito', 'hábitos'])} and ${count(nDetails, ['detail', 'details'], ['detalle', 'detalles'])} left`,
                    `quedan ${count(nHabits, ['habit', 'habits'], ['hábito', 'hábitos'])} y ${count(nDetails, ['detail', 'details'], ['detalle', 'detalles'])}`,
                  )
                : tr(
                    `${count(nHabits, ['habit', 'habits'], ['hábito', 'hábitos'])} · ${count(nDetails, ['detail', 'details'], ['detalle', 'detalles'])} · ${rankShown ? (Math.round(rank) === 1 ? 'your style is the easiest of the 10 to recognise' : `your style ranks #${Math.round(rank)} of 10 (#1 is the easiest to recognise)`) : 'your style: no rank'}`,
                    `${count(nHabits, ['habit', 'habits'], ['hábito', 'hábitos'])} · ${count(nDetails, ['detail', 'details'], ['detalle', 'detalles'])} · ${rankShown ? (Math.round(rank) === 1 ? 'tu estilo es el más fácil de reconocer de los 10' : `tu estilo está en el puesto #${Math.round(rank)} de 10 (el #1 es el más fácil de reconocer)`) : 'tu estilo: sin puesto'}`,
                  )
          }
          open={lost}
        >
          {meaning}
          {findings}
          {unchecked}
          {fingerprint}
        </Why>
      )}
      {editingByHand && (
        <Why
          summary={tr(
            `your edit ranks ${rankShown ? `#${Math.round(rank)}` : '–'} of 10`,
            `tu edición está en el puesto ${rankShown ? `#${Math.round(rank)}` : '–'} de 10`,
          )}
        >
          {fingerprint}
        </Why>
      )}
    </section>
  );

  // ── the lineup: ten writers, the attacker's picks, and what it went by ──
  const attacking = busy === 'attack';
  // Who it took you for: "0/10: about chance" read as a shrug when it had picked F nine times (testers, 22-nov).
  const mistakenFor = (() => {
    const n = new Map<string, number>();
    for (const p of picks) if (p !== SELF_ID && p !== 'none') n.set(p, (n.get(p) ?? 0) + 1);
    const [id, count] = [...n].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
    const letter = seatOf(id);
    return count >= 3 && letter ? { letter, count } : null;
  })();
  const resultTone = !final || attacking ? '' : inconclusive || standIn ? 'mute' : exposedNow ? 'bad' : 'good';
  const lineupSection = (
    <section className="section lineup-section" aria-labelledby="lineup-title">
      <div className="section-head">
        <h2 id="lineup-title">{tr('Ten writers, and one is you', 'Diez personas, y una eres tú')}</h2>
        <span className="chip public">{tr('what the cloud sees', 'lo que ve la nube')}</span>
      </div>
      <p className="section-note">
        {tr(
          'When you test, a cloud AI gets the text and ten public writers, shuffled on every attempt; it is never told which one is you. The other nine write about',
          'Cuando pruebas, una IA en la nube recibe el texto y lo que han publicado diez personas, en un orden distinto en cada intento; nunca se le dice cuál eres tú. Las otras nueve escriben sobre',
        )}{' '}
        <strong>{fieldLabel(lineupOf.field)}</strong>
        {fieldNote}
      </p>

      {(attacking || final) && (
        <div className={`result ${resultTone}`} aria-live="polite">
          <div key={attacking ? 'live' : attacks} className={`result-num ${attacking ? '' : 'land'}`}>
            {attacking ? `${hits}/${picks.length}` : standIn ? '–' : `${final!.hits}/${final!.answered}`}
          </div>
          <div className="result-text">
            <strong>
              {attacking
                ? tr(`Attempt ${Math.min(picks.length + 1, 10)} of 10`, `Intento ${Math.min(picks.length + 1, 10)} de 10`)
                : inconclusive
                  ? tr('Inconclusive: too few answers', 'Sin resultado claro: muy pocas respuestas')
                  : standIn
                    ? tr('It looked for the sample writer', 'Buscó a la persona de ejemplo')
                    : exposedNow
                      ? tr(`It picked you ${final!.hits} of ${final!.answered} times`, `Te eligió ${final!.hits} de ${final!.answered} veces`)
                      : mistakenFor
                        ? final!.hits === 0
                          ? // "0/10" next to "Writer F got 10 of 10" read backwards ("did I fail?", "what if F is me?": round 6, 23-nov).
                            tr(
                              `It did not recognise you: in all ${final!.answered} tries it picked someone else`,
                              `No te reconoció: en los ${final!.answered} intentos eligió a otra persona`,
                            )
                          : tr(
                              `It picked you ${final!.hits} of ${final!.answered} times: it mistook you for Writer ${mistakenFor.letter}`,
                              `Te eligió ${final!.hits} de ${final!.answered} veces: te confundió con la persona ${mistakenFor.letter}`,
                            )
                        : tr(`It picked you ${final!.hits} of ${final!.answered} times: about chance`, `Te eligió ${final!.hits} de ${final!.answered} veces: más o menos al azar`)}
            </strong>
            {/* The count in words: a tester could not tell whether "2/10" meant it picked her (17-nov). */}
            <p>
              {attacking
                ? tr(
                    `${picks.length ? `So far it picked ${standIn ? 'the sample writer' : 'you'} ${hits} of ${picks.length} times. ` : ''}Guessing blindly, it would pick you about 1 time in 10.`,
                    `${picks.length ? `Hasta ahora ${standIn ? 'ha elegido a la persona de ejemplo' : 'te ha elegido'} ${hits} de ${picks.length} veces. ` : ''}Eligiendo a ciegas, te elegiría más o menos 1 vez de cada 10.`,
                  )
                : standIn
                  ? // Not a score of you at all: "picked the sample writer 0 of 10 times" read as "safe" to a tester, three rounds running (17-nov).
                    tr(
                      `Without your own public writing, the AI looked for the sample writer (it picked her ${final!.hits} of ${final!.answered} times).`,
                      `Sin tus propios textos públicos, la IA buscó a la persona de ejemplo (la eligió ${final!.hits} de ${final!.answered} veces).`,
                    )
                  : !exposedNow && mistakenFor
                    ? tr(
                        `It picked Writer ${mistakenFor.letter} ${mistakenFor.count} of ${final!.answered} times, and you are ${seatOf(SELF_ID) ?? 'C'}: your rewrite reads like someone else’s. (Guessing blindly, it would pick you about 1 time in 10.)`,
                        `Eligió a la persona ${mistakenFor.letter} ${mistakenFor.count} de ${final!.answered} veces, y tú eres la ${seatOf(SELF_ID) ?? 'C'}: tu reescritura parece de otra persona. (Eligiendo a ciegas, te elegiría más o menos 1 vez de cada 10.)`,
                      )
                    : exposedNow
                      ? tr('Guessing blindly, it would pick you about 1 time in 10: it recognised your style.', 'Eligiendo a ciegas, te elegiría más o menos 1 vez de cada 10: reconoció tu estilo.')
                      : tr('Guessing blindly, it would pick you about 1 time in 10.', 'Eligiendo a ciegas, te elegiría más o menos 1 vez de cada 10.')}
              {!attacking && final!.answered < final!.attempts
                ? tr(
                    ` ${count(final!.attempts - final!.answered, ['attempt', 'attempts'], ['intento', 'intentos'])} got no answer (model busy).`,
                    ` ${count(final!.attempts - final!.answered, ['attempt', 'attempts'], ['intento', 'intentos'])} sin respuesta (modelo ocupado).`,
                  )
                : ''}
              {!attacking && inconclusive
                ? tr(' Too few answers came back from the cloud: wait a minute and test again.', ' Llegaron muy pocas respuestas de la nube: espera un minuto y prueba de nuevo.')
                : ''}
              {!attacking && before !== null && stage === 'reattacked' ? tr(` Before: ${before}/10.`, ` Antes: ${before}/10.`) : ''}
              {/* An AI is not your boss (a tester, 22-nov): the people who know you read the details, not the style. */}
              {!attacking && stage === 'reattacked' && !exposedNow && !standIn && !inconclusive
                ? tr(
                    ' People who know you still might: reread names, teams, roles, numbers and dates before you post.',
                    ' La gente que te conoce aún podría reconocerte: relee nombres, equipos, cargos, cifras y fechas antes de publicar.',
                  )
                : ''}
            </p>
            <span className="ticks" aria-hidden="true">
              {Array.from({ length: 10 }, (_, i) => (
                <i key={i} className={i < picks.length ? (picks[i] === SELF_ID ? 'hit' : 'miss') : ''} />
              ))}
            </span>
            {/* The original was not sent: its risk comes from the device, said in words so a rank and a count of picks are
                not read as one scale (22-nov). */}
            {!attacking && final && published && !sentAsIs && !inconclusive && !standIn && (
              <BeforeAfter
                good={!exposedNow}
                before={[
                  rankBefore !== null ? (rankBefore === 1 ? tr('your style was the easiest of the 10 to recognise', 'tu estilo era el más fácil de reconocer de los 10') : tr(`your style ranked #${rankBefore} of 10 (#1 is the easiest to recognise)`, `tu estilo estaba en el puesto #${rankBefore} de 10 (el #1 es el más fácil de reconocer)`)) : '',
                  habitsBefore + detailsBefore
                    ? tr(
                        `${count(habitsBefore, ['habit', 'habits'], ['hábito', 'hábitos'])} and ${count(detailsBefore, ['detail', 'details'], ['detalle', 'detalles'])} could give you away`,
                        `${count(habitsBefore, ['habit', 'habits'], ['hábito', 'hábitos'])} y ${count(detailsBefore, ['detail', 'details'], ['detalle', 'detalles'])} podían delatarte`,
                      )
                    : '',
                ]
                  .filter(Boolean)
                  .join('; ')}
                now={tr(`it picked you ${final.hits} of ${final.answered} times`, `te eligió ${final.hits} de ${final.answered} veces`)}
              />
            )}
            {standIn && !attacking && addWriting && !inconclusive && (
              <button className="mini add-writing" onClick={addWriting}>
                {tr('Add my public writing', 'Añadir mis textos públicos')}
              </button>
            )}
          </div>
        </div>
      )}

      <div className={`writers ${attacking ? 'looking' : ''}`} role="list" aria-label={tr('Ten writers', 'Diez personas')}>
        {lineup.map((c, k) => {
          const n = picks.filter((p) => p === c.id).length;
          const isMe = c.id === SELF_ID;
          return (
            <WriterCard
              key={c.id}
              letter={c.letter}
              glyph={glyphs[k] ?? []}
              // Without your own writing this seat holds the sample writer: "you" on it misled a judge (17-nov).
              you={isMe ? (standIn ? tr('Sample', 'Ejemplo') : tr('You', 'Tú')) : undefined}
              count={n}
              pointed={current === c.id}
              found={isMe && n >= 3}
            />
          );
        })}
      </div>
      <p className="glyph-key">
        {tr(
          'Each card is a writing fingerprint: how often a writer uses little words (“the”, “but”, “I”…) and marks (dashes, brackets), compared with the other nine. The AI recognises people by habits like these.',
          'Cada tarjeta es una huella de escritura: cuántas veces usa una persona palabras pequeñas (“the”, “but”, “I”…) y signos (guiones, paréntesis), frente a las otras nueve. La IA reconoce a la gente por hábitos así.',
        )}
      </p>

      {styleGone && !busy && (
        <p className="notice slim">
          {tr(
            `Your writing habits no longer stand out (your fingerprint ranks you #${Math.round(rank)} of 10), yet it still picked you.`,
            `Tus hábitos al escribir ya no destacan (tu huella de escritura te pone en el puesto #${Math.round(rank)} de 10), pero aun así te eligió.`,
          )}{' '}
          {/* What to change, by name: "Change those next" left a tester guessing (17-nov). */}
          {contentClues.length
            ? tr(
                `These details are still in your post: ${contentClues
                  .slice(0, 4)
                  .map((c) => `“${c.phrase}”`)
                  .join(', ')}. Change them next.`,
                `Estos detalles siguen en tu post: ${contentClues
                  .slice(0, 4)
                  .map((c) => `“${c.phrase}”`)
                  .join(', ')}. Cámbialos ahora.`,
              )
            : tr(
                'It goes by what you write about: change the specifics of the story (the events, the people), not your words.',
                'Se fija en lo que cuentas: cambia lo concreto de la historia (los hechos, la gente que aparece), no tus palabras.',
              )}
        </p>
      )}

      {verdict && verdict.reasons.length > 0 && picks.length === verdict.attempts && (
        <Why
          summary={
            reasonsSeat ? tr(`the AI’s reasons for Writer ${reasonsSeat}`, `las razones de la IA para elegir a la persona ${reasonsSeat}`) : tr('the AI’s reasons', 'las razones de la IA')
          }
        >
          {reasonsSeat && (
            <p className="hint reasons-whose">
              {tr(
                `For its last pick, Writer ${reasonsSeat}${standIn ? '' : ', not you'}: why it matched the post with ${reasonsSeat}’s writing.`,
                `Sobre su última elección, la persona ${reasonsSeat}${standIn ? '' : ', no tú'}: por qué relacionó el post con los textos de ${reasonsSeat}.`,
              )}
            </p>
          )}
          <ul className="reasons">
            {shownReasons.map(({ r, notIn, fromPick, fromOther, namesYou }, i) => (
              // A quote that is in none of the texts the attacker was given is the model guessing: say so.
              <li key={`${r}-${i}`}>
                {r}
                {namesYou && (
                  <em className="from-pick">
                    {' '}
                    · {tr(`${seatOf(SELF_ID)} is ${standIn ? 'the sample writer' : 'you'}`, `${seatOf(SELF_ID)} ${standIn ? 'es la persona de ejemplo' : 'eres tú'}`)}
                  </em>
                )}
                {(fromPick.length > 0 || fromOther) && (
                  <em className="from-pick">
                    {' '}
                    · {tr('quotes', 'cita')}{' '}
                    {fromOther
                      ? tr('another writer’s text', 'el texto de otra persona')
                      : verdict?.reasonsPick === SELF_ID
                        ? standIn
                          ? tr('the sample writer’s posts', 'los posts de la persona de ejemplo')
                          : tr('your public writing', 'tus textos públicos')
                        : tr(`Writer ${reasonsSeat}’s writing`, `los textos de la persona ${reasonsSeat}`)}
                  </em>
                )}
                {notIn.length > 0 && (
                  <em className="ungrounded">
                    {' '}
                    ·{' '}
                    {tr(
                      `${notIn.map((q) => `“${q}”`).join(', ')} ${notIn.length > 1 ? 'are' : 'is'} in none of the texts it was given`,
                      `${notIn.map((q) => `“${q}”`).join(', ')} ${notIn.length > 1 ? 'no están' : 'no está'} en ninguno de los textos que recibió`,
                    )}
                  </em>
                )}
              </li>
            ))}
          </ul>
          {foldedReasons > 0 && (
            <button className="mini reasons-more" onClick={() => setShowUngrounded(true)}>
              {/* The action first: "…: show" at the end read as a glitch to a tester (17-nov). */}
              {foldedReasons === 1
                ? tr('Show one more reason: it quotes', 'Mostrar una razón más: cita')
                : tr(`Show ${foldedReasons} more reasons: they quote`, `Mostrar ${foldedReasons} razones más: citan`)}
              {tr(' words that are in none of the texts it was given', ' palabras que no están en ninguno de los textos que recibió')}
            </button>
          )}
          {bySubject && (
            <p className="hint subject-note">
              {tr(
                'Some of its reasons are about what you write about, not how you write. If the other nine writers are not from your field, start over and pick a closer one; if they are, your subject alone gives you away.',
                'Algunas de sus razones hablan de qué escribes, no de cómo escribes. Si las otras nueve personas no son de tu sector, empieza de nuevo y elige uno más cercano; si lo son, tu tema basta para delatarte.',
              )}
            </p>
          )}
        </Why>
      )}

      {/* The ten writers, a line each: "the same field" was a claim a judge could not see (17-nov). */}
      <details className="disclosure lineup-texts">
        <summary>{tr('Read a line from each writer', 'Leer una frase de cada persona')}</summary>
        <ul className="disclosure-body">
          {lineup.map((c) => (
            <li key={c.id}>
              <b>{c.letter}</b>{' '}
              {c.id === SELF_ID && (
                <em>
                  {standIn
                    ? tr('sample writer', 'persona de ejemplo')
                    : ownText
                      ? tr('you, your public writing', 'tú, tus textos públicos')
                      : tr('you, the sample writer’s posts', 'tú, los posts de la persona de ejemplo')}
                  :{' '}
                </em>
              )}
              {firstLine(corpusOf(c.id))}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );

  // What each step shows: your post until it has been attacked, the lineup from the scan on; a verdict comes first.
  const showPost = stage !== 'attacked' || editingByHand;
  // A test that came back inconclusive stays on `rewritten`, and it may be the first test: its result must still show.
  const showLineup = stage !== 'draft' && (stage !== 'rewritten' || attacking || !!final);
  const verdictFirst = stage === 'attacked' || stage === 'reattacked';
  // The mascot reacts to the step, and to what is running (Rafa, 22-nov: the app looked dead).
  const pose: Pose =
    busy === 'scan'
      ? 'scan'
      : busy === 'attack'
        ? 'think'
        : busy === 'rewrite'
          ? 'blur'
          : stage === 'draft'
            ? 'wave'
            : stage === 'scanned'
              ? 'scan'
              : stage === 'rewritten'
                ? 'blur'
                : exposedNow && !standIn
                  ? 'alarm'
                  : 'safe';

  return (
    <div className="stage" ref={stageRef}>
      <Stepper steps={steps} current={STAGE_STEP[stage]} busySince={busySince} outcome={outcome} round={rounds} />
      {error && <ErrorNote message={error} />}
      <header className="stage-head">
        <div className="stage-words">
          <h1 className="stage-title">{head.title}</h1>
          <p className="stage-lede">{head.lede}</p>
        </div>
        <Mascot pose={pose} className="stage-mascot" />
      </header>
      {verdictFirst && showLineup && lineupSection}
      {showPost && post}
      {!verdictFirst && showLineup && lineupSection}
      {dock && createPortal(actions, dock)}
    </div>
  );
}

function Busy({ label }: { label: string }) {
  return (
    <>
      <span className="spinner" aria-hidden="true" />
      {label}
    </>
  );
}
