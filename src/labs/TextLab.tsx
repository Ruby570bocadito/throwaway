import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { readsAsEnglish, styleMarkers, type Reliability } from '../engine/stylometry';
import { DECOYS, DRAFT, MARTA_PUBLIC, SELF_ID } from '../demo/scenario';
import { FIELD_IDS, FIELD_LABELS, type DecoyPackId } from '../demo/fields';
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
import { buildAuthorship, lineupField, loadDecoyPacks, type DecoyPacks } from '../kit';
import { ErrorNote, friendlyError, type LabProps } from '../ui/shared';
import { Compare } from '../ui/Compare';
import { Stepper, type StepDef } from '../ui/Stepper';
import { WorkLog, type PlanStep } from '../ui/WorkLog';
import { useGlyphs } from '../ui/glyphs';
import { WriterCard } from '../ui/Writer';
import { Why } from '../ui/Why';
import { useAnimatedNumber, withTransition } from '../ui/motion';
import { useCloudBusy } from '../ui/busy';

type Stage = 'draft' | 'scanned' | 'attacked' | 'rewritten' | 'reattacked';
const LETTERS = 'ABCDEFGHIJ';
// Fixed seats on screen: you and the nine writers, always in this order (the attacker gets its own shuffle every time).
const SEATS = [3, 7, 0, 5, 9, 1, 8, 2, 6, 4];
const CONFIDENCE: Record<Reliability['level'], string> = {
  'too-short': 'Too short to tell',
  low: 'Low confidence',
  medium: 'Medium confidence',
  high: 'High confidence',
};
const STAGE_STEP: Record<Stage, number> = { draft: 0, scanned: 1, attacked: 2, rewritten: 3, reattacked: 4 };

// What each long action is expected to leave in the ledger, in order (see threats/authorship.ts).
const SCAN_PLAN: PlanStep[] = [
  { match: /^Fingerprint/, label: 'Fingerprint your style', route: 'local-js' },
  { match: /^Find identifying details/, label: 'Find what identifies you', route: 'on-device', slow: true },
  { match: /^Find counts and dates/, label: 'Find every count and date', route: 'local-js' },
];
// Without a local model: no model step runs, and capital letters stand in for it as pointers to names.
const SCAN_PLAN_NO_MODEL: PlanStep[] = [
  { match: /^Fingerprint/, label: 'Fingerprint your style', route: 'local-js' },
  { match: /^Find identifying details/, label: 'Find what identifies you', route: 'skipped' },
  { match: /^Find counts, dates and names/, label: 'Find counts, dates and capitalised names', route: 'local-js' },
];
const REWRITE_PLAN: PlanStep[] = [
  { match: /^Fixed rules generalised/, label: 'Generalise the details', route: 'local-js', optional: true },
  // A long post is rewritten part by part: the step is done with its last part ("Rewrite part 8 of 8 on-device").
  { match: /^Rewrite (?:on-device|part (\d+) of \1 on-device)/, label: 'Rewrite your style', route: 'on-device', slow: true },
  { match: /^Check the final text/, label: 'Check the final text for details', route: 'local-js' },
  { match: /^Meaning check/, label: 'Check that the meaning survived', route: 'on-device', slow: true },
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
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
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
  const [showCompare, setShowCompare] = useState(false);
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
      if (!privateDraft.current) return 'Scan your post first, so the framework knows what is private.';
      try {
        await kit.cloud.generate(['Summarise this review: ' + draft], { op: 'Leak test: draft in a cloud prompt' });
        return 'The draft was sent. This should never happen.';
      } catch (e) {
        return e instanceof PrivacyViolation ? 'Blocked by the privacy guard. 0 bytes left the device.' : (e as Error).message;
      }
    });
    return () => registerLeak(null);
  }, [kit, draft, registerLeak]);

  // After an action, hand keyboard focus to the next one (only if it was in the actions, so nothing else is taken away).
  useEffect(() => {
    if (!dock || busy || !acted.current) return;
    const active = document.activeElement;
    if (active && active !== document.body && !dock.contains(active)) return;
    dock.querySelector<HTMLElement>('button:not(:disabled), a[href]')?.focus({ preventScroll: true });
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
  // Habits in the version you would post: only needed once there is one.
  const liveStyle = useMemo(
    () => (published ? styleMarkers(shownText, selfCorpus, decoys.map((d) => d.corpus)).map((m) => ({ ...m, kind: 'style' as const })) : []),
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
  const editingByHand = degraded && stage === 'attacked';
  // The edit is the draft until you change it; after a release, the released text.
  const editUnchanged = edited.trim() === (published ? published.value : draft).trim();
  // The same match as the highlighter: a habit like "so honestly i" is still there in "So, honestly, I".
  const goneFromEdit = (phrase: string) => editingByHand && !new RegExp(phraseRe(phrase), 'i').test(edited);
  const generaliseForMe = () => {
    const r = deterministicGeneralise(edited, ruleCounts);
    setEdited(r.text);
    const n = r.done.length;
    const shown = r.done.slice(0, 3).map((d) => `“${d.phrase}” → “${d.generic || 'removed'}”`);
    setGenNote(
      n
        ? `Generalised ${n} detail${n > 1 ? 's' : ''} with fixed rules, no AI: ${shown.join(', ')}${n > 3 ? ` and ${n - 3} more` : ''}. Names on their own and your habits are still yours to change.`
        : 'Nothing left that the rules can generalise in your edit.',
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
              ? `Your edit still keeps this passage of your original: ${quote(kept[0])}. Put it in other words (about 7 words in a row from your original are refused), then try again.`
              : `Your edit still keeps ${kept.length >= 4 ? 'at least 4' : kept.length} passages of your original: ${kept.map(quote).join(', ')}. Put each in other words (about 7 words in a row from your original are refused), then try again.`;
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
      setError('Your browser blocked the clipboard. Select the text and copy it by hand.');
    }
  };

  const steps: StepDef[] = [
    { label: 'Scan', where: degraded ? 'fixed rules, no model' : 'on your device' },
    { label: 'Attack', where: 'in the cloud' },
    { label: 'Fix', where: degraded ? 'you edit it' : 'on your device' },
    { label: 'Attack again', where: 'in the cloud' },
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

  // Whose field the nine writers share, and what follows from it.
  const canPickField = stage === 'draft' && !!ownText && !!packs;
  // "like you" read as "they resemble you" to both testers (16-nov): the field is what is shared, so it says so.
  const sameField = ', the same field as you: the attacker has to recognise your style, not your subject.';
  const fieldNote = !ownText
    ? recorded || draft === DRAFT
      ? sameField
      : ', the sample writer’s field: she stands in for you until you add your own public writing.'
    : packsFailed
      ? ' (the other fields did not load).'
      : !lineupOf.clear
        ? `: no field stood out in your writing${stage === 'draft' ? ', so pick the closest one' : ''}.`
        : lineupOf.wanted === lineupOf.matched
          ? sameField
          : `. Your writing reads as ${FIELD_LABELS[lineupOf.matched]}, so the attacker may go by subject, not style.`;

  const busyLabel =
    busy === 'scan'
      ? degraded
        ? 'Scanning…'
        : 'Scanning on your device…'
      : busy === 'attack'
        ? `Attacking · ${Math.min(picks.length + 1, 10)} of 10`
        : busy === 'rewrite'
          ? degraded
            ? 'Checking your edit…'
            : 'Rewriting on your device…'
          : '';

  // ── what this step says: a title and one sentence ──
  const nHabits = styleClues.length;
  const nDetails = contentClues.length;
  const verdictTitle = standIn ? 'Not a test of you yet' : exposedNow ? 'The attacker found you' : 'You are one of ten';
  const head: { title: ReactNode; lede: string } =
    stage === 'draft'
      ? {
          title: (
            <>
              Before you post anonymously, let an AI try to <span className="marker">unmask you</span>.
            </>
          ),
          lede: recorded
            ? 'A recorded run: Gemini Nano’s answers on this sample post were recorded in Chrome, and replay here.'
            : 'Throwaway scans your post on this device first. Nothing leaves it until you choose to test it.',
        }
      : stage === 'scanned'
        ? {
            title: nHabits + nDetails ? `${capital(plural(nHabits, 'habit'))} and ${plural(nDetails, 'detail')} could give you away` : 'Nothing obvious gives you away',
            lede: degraded
              ? 'Found with fixed rules on this device; names only by their capital letters. Next, a cloud AI tries to pick you out of ten writers.'
              : 'Found on this device. Next, a cloud AI tries to pick you out of ten writers.',
          }
        : stage === 'attacked'
          ? {
              title: verdictTitle,
              lede: degraded
                ? 'No on-device AI here, so you change it: your habits and details are marked in the post below.'
                : rounds > 1
                  ? 'Still found after a rewrite. Gemini Nano can rewrite it again, keeping what the attacker went by in mind.'
                  : exposedNow
                    ? 'Next, Gemini Nano rewrites your style and the details, on this device.'
                    : 'You could post it as it is. Gemini Nano can still rewrite it on this device, to be safe.',
            }
          : stage === 'rewritten'
            ? {
                title: degraded ? 'Your edited version' : 'Rewritten on your device',
                lede: degraded
                  ? 'Checked on this device: no long passage of your original is left. Next, attack it again.'
                  : 'In a plain, neutral voice on purpose: your style is what gave you away. Read it, then attack it again.',
              }
            : {
                title: nDetails ? `Your style is hidden, but ${plural(nDetails, 'detail')} can still identify you` : verdictTitle,
                lede: standIn
                  ? 'Without your own public writing, this test looked for the sample writer, not you.'
                  : nDetails
                    ? 'Change them before you post.'
                    : `It cannot tell you apart from the other nine writers${degraded ? ', and no counts or dates are left. Names, places and companies were not checked.' : ', and no identifying details are left.'}`,
              };

  // ── the note before the button: one, the one that matters most ──
  const note: { text: string; warn: boolean } | null =
    stage === 'draft'
      ? standIn
        ? { text: 'Without your own public writing, the attack will look for the sample writer, not you. Add yours under the post first.', warn: true }
        : !recorded && readsAsEnglish(draft) === false
          ? {
              text: 'This post does not read as English. Throwaway is tuned for English: counts, dates and habits in other languages are mostly not caught, and the rewrite comes back in English.',
              warn: true,
            }
          : null
      : stage === 'scanned'
        ? standIn
          ? { text: 'No public writing of yours: this attack looks for the sample writer, not you. Start over to add yours: your post stays.', warn: true }
          : // A judge read the as-is test as at odds with "the draft is the secret" (17-nov): say it is the only such step.
            { text: 'Sends this exact text to a cloud AI, ten times (more if the model is busy), as if you had posted it: the only step that sends your original.', warn: true }
        : stage === 'rewritten' && published
          ? { text: degraded ? 'Sends only your edited version, never the original.' : 'Sends only the rewritten version, never the original.', warn: false }
          : null;

  const actions = (
    <>
      {working && busySince !== null && (
        <WorkLog
          ledger={kit.ledger}
          since={busySince}
          plan={busy === 'scan' ? (degraded ? SCAN_PLAN_NO_MODEL : SCAN_PLAN) : REWRITE_PLAN}
          title={busy === 'scan' ? 'Scanning your post on this device' : 'Fixing your post on this device'}
          recorded={recorded}
          download={download}
        />
      )}
      {busyNote && (
        <p className="dock-note busy" role="status">
          {busyNote}
        </p>
      )}
      {!busy && note && <p className={`dock-note ${note.warn ? 'warn' : ''}`}>{note.text}</p>}
      <div className="dock-row">
        {stage === 'draft' && (
          <button className="primary" onClick={scan} disabled={!!busy || !draft.trim() || lineupPending} aria-busy={busy === 'scan'}>
            {busy ? <Busy label={busyLabel} /> : 'Scan my post locally'}
          </button>
        )}
        {stage === 'scanned' && (
          <button className="primary" onClick={attackAsIs} disabled={!!busy} aria-busy={busy === 'attack'}>
            {busy ? <Busy label={busyLabel} /> : 'Attack it as I would post it'}
          </button>
        )}
        {stage === 'attacked' && (
          // Nothing edited yet, nothing to use: the button read as a step already done to a tester (17-nov).
          <button className="primary" onClick={rewrite} disabled={!!busy || (degraded && editUnchanged)} aria-busy={busy === 'rewrite'}>
            {busy
              ? <Busy label={busyLabel} />
              : degraded
                ? editUnchanged
                  ? 'Edit your post below first'
                  : 'Use my edited version'
                : published
                  ? 'Rewrite again on-device'
                  : 'Rewrite on-device with Gemini Nano'}
          </button>
        )}
        {stage === 'rewritten' && published && (
          <button className="primary" onClick={() => attack(published, true)} disabled={!!busy} aria-busy={busy === 'attack'}>
            {busy ? <Busy label={busyLabel} /> : 'Attack again'}
          </button>
        )}
        {stage === 'reattacked' && published && (
          <button className="primary" onClick={copySafe}>
            {copied ? 'Copied' : 'Copy this version'}
          </button>
        )}
      </div>
    </>
  );

  // ── pieces ──
  const findings = (
    <div className="findings" key={published ? 'after' : 'before'}>
      <div className="finding-col">
        <h3>Style habits</h3>
        {styleClues.length === 0 ? (
          <p className="good rise">No habits from your public writing.</p>
        ) : (
          styleClues.map((m, i) => (
            <div key={`${m.phrase}-${i}`} className={`finding style rise ${goneFromEdit(m.phrase) ? 'gone' : ''}`} style={at(i)}>
              <code>{m.phrase}</code>{' '}
              <span>
                {m.why}
                {goneFromEdit(m.phrase) && <em className="gone-tag"> · gone from your edit</em>}
              </span>
            </div>
          ))
        )}
      </div>
      <div className="finding-col">
        <h3>Identifying details</h3>
        {contentClues.length === 0 ? (
          <p className="good rise">
            {degraded
              ? published
                ? 'No counts, dates or capitalised names left.'
                : 'No counts, dates or capitalised names found.'
              : published
                ? 'None left (checked on your device).'
                : 'None found.'}
          </p>
        ) : (
          contentClues.map((m, i) => (
            <div key={`${m.phrase}-${i}`} className={`finding content rise ${goneFromEdit(m.phrase) ? 'gone' : ''}`} style={at(i)}>
              <code>{m.phrase}</code>{' '}
              <span>
                {m.why}
                {goneFromEdit(m.phrase) && <em className="gone-tag"> · gone from your edit</em>}
              </span>
            </div>
          ))
        )}
        {generalised.map((g, i) => (
          <div key={`${g.phrase}-${i}`} className="finding generalised rise" style={at(i)}>
            <code>{g.phrase}</code>{' '}
            <span>
              {g.generic ? `→ “${g.generic.length > 70 ? `${g.generic.slice(0, 70)}…` : g.generic}”` : '→ removed'}
              <em className="by">{g.by === 'rule' ? ' · fixed rule, no AI' : ' · Gemini Nano'}, on your device</em>
            </span>
          </div>
        ))}
      </div>
    </div>
  );

  // Without a local model only the fixed rules ran: say what that left unchecked, where the findings are (16-nov).
  const unchecked = degraded && (
    <p className="unchecked">
      <strong>Names, places and companies: only guessed from capital letters.</strong> There is no local model on this device, so read your post for them
      too before you post.
    </p>
  );

  const fingerprint = (
    <div className="meter">
      <div className="meter-top">
        {/* While you edit by hand the rank follows your edit: it moved with no word of why for a tester (17-nov). */}
        <span className="meter-label">{editingByHand ? 'Your edit’s rank' : 'Your rank'} among ten writers: #1 reads most like you, #10 least</span>
        <strong className={!rankShown || !stylo ? '' : stylo.rank <= 2 ? 'bad' : stylo.rank <= 5 ? 'warn' : 'good'}>
          #{rankShown ? Math.round(rank) : '–'} <span>of 10</span>
        </strong>
      </div>
      <div className="bar">
        <i style={{ transform: `scaleX(${rankShown && stylo ? stylo.score : 0})` }} className={(stylo?.score ?? 0) > 0.6 ? 'bad' : 'good'} />
      </div>
      {trust && !standIn && (
        <div className={`trust ${trust.level}`}>
          <span className="conf">{CONFIDENCE[trust.level]}</span>
          {!tooShort && (
            <span>{trust.rankRange[0] === trust.rankRange[1] ? `Steady at #${trust.rankRange[0]}` : `Likely #${trust.rankRange[0]} to #${trust.rankRange[1]}`}</span>
          )}
          {trust.notes.length > 0 && <p className="trust-notes">{trust.notes.join(' ')}</p>}
        </div>
      )}
      {/* What the rank means, in words: "#2 of 10" read as good to a tester (17-nov). */}
      {rankShown && stylo && (
        <p className="meter-read">
          {stylo.rank <= 2
            ? 'It reads a lot like your public writing: easy to link.'
            : stylo.rank <= 5
              ? 'It reads somewhat like your public writing.'
              : 'It reads less like you than most of the other writers.'}
        </p>
      )}
      <small>Local fingerprint: Burrows’ Delta on function words, range from 100 resamples · in your browser · 0 bytes sent</small>
      {/* Without your writing there is no rank of you: the sample writer's rank confused a tester (17-nov). */}
      {standIn && <p className="hint">Add your own public writing to see how much your post reads like you.</p>}
    </div>
  );

  const meaning = published && claims && (claims.meaningCheck === 'failed' || claims.claims.length > 0) && (
    <div className={`claims ${claims.meaningCheck === 'failed' ? 'failed' : ''}`}>
      {claims.meaningCheck === 'failed' ? (
        <>
          <h3>Same meaning? No answer</h3>
          <p>Gemini Nano gave no readable answer, so nothing checked that the rewrite still says what you meant. Read it before you post.</p>
        </>
      ) : (
        <>
          <h3>
            Same meaning? {claims.claims.filter((c) => c.kept).length} of {claims.claims.length} claims kept · checked on your device
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
  const postLabel = published ? (degraded ? 'Your edit' : 'The rewritten version') : editingByHand ? 'Your edit' : 'Your post';
  const post = (
    <section className="post panel" aria-labelledby="post-title">
      <div className="post-head">
        <h2 id="post-title">{postLabel}</h2>
        <span className={`chip ${!published && sentAsIs ? 'asis' : 'private'}`}>
          {published ? 'released for publication' : sentAsIs ? 'sent as-is to the attacker · your choice' : 'private · stays on this device'}
        </span>
      </div>
      <div className={`sheet-wrap ${working ? 'reading' : ''}`}>
        {editing ? (
          <textarea
            ref={textareaRef}
            aria-labelledby="post-title"
            placeholder="Paste the post you are about to publish…"
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
              ? 'The sample post is fixed in a recorded run.'
              : draft === DRAFT
                ? 'Sample post: an anonymous review of an employer. Edit it, or paste yours.'
                : 'Your post stays on this device until you choose to test it.'}
          </span>
          {recorded ? (
            <a className="hint-link" href={location.pathname}>
              Check your own post, live
            </a>
          ) : (
            <button
              className="mini"
              onClick={() => {
                setDraft('');
                textareaRef.current?.focus();
              }}
            >
              Paste my own post
            </button>
          )}
        </div>
      )}
      {stage === 'draft' && !recorded && (
        <details ref={ownRef} className="disclosure own-writing" onToggle={(e) => e.currentTarget.open && setWantPacks(true)}>
          {/* The count against the 150 a fingerprint needs, as you type: a tester stopped at 141 without knowing (17-nov). */}
          <summary>
            Compare with your own public writing
            <span className="why-s">{ownWords ? `${ownWords}${ownWords < 150 ? ' of 150' : ''} words` : 'optional'}</span>
          </summary>
          <div className="disclosure-body">
            <p className="hint">
              Paste things you have already published under your name, 150 words or more: blog posts, LinkedIn posts, comments. The fingerprint compares them
              with your anonymous post on this device. For the attack they go to the cloud as one of the ten writers, so paste only writing that is already
              public. Nothing is stored.
            </p>
            <textarea
              aria-label="Your public writing"
              rows={5}
              value={ownPublic}
              onChange={(e) => setOwnPublic(e.target.value)}
              placeholder="Paste a few paragraphs you have published under your name…"
            />
            {ownWords > 0 && ownWords < 150 && <p className="hint">At least 150 words make a useful fingerprint.</p>}
            {canPickField && (
              <p className="field-line">
                <label>
                  The other nine writers write about{' '}
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
                        {FIELD_LABELS[id]}
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
          {nHabits > 0 && <span className="key style">Habit your public writing shares</span>}
          {nDetails > 0 && <span className="key content">Detail that identifies you</span>}
        </p>
      )}

      {editingByHand && (
        <>
          <div className="tools">
            {/* Steps, not a goal: a tester without Gemini Nano did not know what to change (17-nov). */}
            <span className="hint">
              Press the button for counts, dates and some names. Then change the rest yourself: a name becomes a role (“the regional manager”), and the words
              under your habits go.
            </span>
            {ruleCounts.length > 0 && (
              <button className="mini" onClick={generaliseForMe}>
                Generalise details for me
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
          <span className="hint">Read it before you post: the meaning check runs on a small model and can miss a change.</span>
          <span className="tools-end">
            <button className="mini" aria-expanded={showCompare} onClick={() => setShowCompare((v) => !v)}>
              {showCompare ? 'Hide the comparison' : 'Compare with your original'}
            </button>
            {/* At the end, copying is the step's own button: one Copy, not two (21-nov plan). */}
            {stage !== 'reattacked' && (
              <button className="mini" onClick={copySafe}>
                {copied ? 'Copied' : 'Copy'}
              </button>
            )}
          </span>
        </div>
      )}
      {published && showCompare && <Compare original={draft} final={published.value} />}
      {/* A failed or lossy meaning check is said where the text is, not only behind "Why?". */}
      {published && claims?.meaningCheck === 'failed' && <p className="notice slim">Gemini Nano gave no answer on the meaning: read the rewrite against your post before you post it.</p>}

      {stage !== 'draft' && !editingByHand && (
        <Why
          summary={
            published && claims
              ? `${plural(generalised.length, 'detail')} generalised${claims.claims.length ? ` · ${claimsKept} of ${claims.claims.length} claims kept` : ''}`
              : published
                ? `${plural(nHabits, 'habit')} and ${plural(nDetails, 'detail')} left`
                : `${plural(nHabits, 'habit')} · ${plural(nDetails, 'detail')} · your style ranks ${rankShown ? `#${Math.round(rank)}` : '–'} of 10`
          }
          open={lost}
        >
          {meaning}
          {findings}
          {unchecked}
          {fingerprint}
        </Why>
      )}
      {editingByHand && <Why summary={`your edit ranks ${rankShown ? `#${Math.round(rank)}` : '–'} of 10`}>{fingerprint}</Why>}
    </section>
  );

  // ── the lineup: ten writers, the attacker's picks, and what it went by ──
  const attacking = busy === 'attack';
  const resultTone = !final || attacking ? '' : inconclusive || standIn ? 'mute' : exposedNow ? 'bad' : 'good';
  const lineupSection = (
    <section className="section lineup-section" aria-labelledby="lineup-title">
      <div className="section-head">
        <h2 id="lineup-title">The lineup</h2>
        <span className="chip public">what the cloud sees</span>
      </div>
      <p className="section-note">
        A cloud AI gets the text and ten public writers, shuffled on every attempt; it is never told which one is you. The other nine write about{' '}
        <strong>{FIELD_LABELS[lineupOf.field]}</strong>
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
                ? `Attempt ${Math.min(picks.length + 1, 10)} of 10`
                : inconclusive
                  ? 'Inconclusive: too few answers'
                  : standIn
                    ? 'It looked for the sample writer'
                    : exposedNow
                      ? `It picked you ${final!.hits} of ${final!.answered} times`
                      : `It picked you ${final!.hits} of ${final!.answered} times: about chance`}
            </strong>
            {/* The count in words: a tester could not tell whether "2/10" meant it picked her (17-nov). */}
            <p>
              {attacking
                ? `${picks.length ? `So far it picked ${standIn ? 'the sample writer' : 'you'} ${hits} of ${picks.length} times. ` : ''}Chance level is 1 in 10.`
                : standIn
                  ? // Not a score of you at all: "picked the sample writer 0 of 10 times" read as "safe" to a tester, three rounds running (17-nov).
                    `Without your own public writing, the attacker looked for the sample writer (it picked her ${final!.hits} of ${final!.answered} times).`
                  : 'Chance level is 1 in 10.'}
              {!attacking && final!.answered < final!.attempts ? ` ${final!.attempts - final!.answered} attempts got no answer (model busy).` : ''}
              {!attacking && inconclusive ? ' Too few answers came back from the cloud: wait a minute and attack again.' : ''}
              {!attacking && before !== null && stage === 'reattacked' ? ` Before: ${before}/10.` : ''}
            </p>
            <span className="ticks" aria-hidden="true">
              {Array.from({ length: 10 }, (_, i) => (
                <i key={i} className={i < picks.length ? (picks[i] === SELF_ID ? 'hit' : 'miss') : ''} />
              ))}
            </span>
            {standIn && !attacking && addWriting && !inconclusive && (
              <button className="mini add-writing" onClick={addWriting}>
                Add my public writing
              </button>
            )}
          </div>
        </div>
      )}

      <div className={`writers ${attacking ? 'looking' : ''}`} role="list" aria-label="Ten writers">
        {lineup.map((c, k) => {
          const n = picks.filter((p) => p === c.id).length;
          const isMe = c.id === SELF_ID;
          return (
            <WriterCard
              key={c.id}
              letter={c.letter}
              glyph={glyphs[k] ?? []}
              // Without your own writing this seat holds the sample writer: "you" on it misled a judge (17-nov).
              you={isMe ? (standIn ? 'Sample' : 'You') : undefined}
              count={n}
              pointed={current === c.id}
              found={isMe && n >= 3}
            />
          );
        })}
      </div>
      <p className="glyph-key">
        Each card draws how often a writer uses the commonest words (“the”, “but”, “I”…) and marks (dashes, brackets) next to the other nine: the habits the attacker can recognise.
      </p>

      {styleGone && !busy && (
        <p className="notice slim">
          Your writing habits no longer stand out (your fingerprint ranks you #{Math.round(rank)} of 10), yet it still picked you.{' '}
          {/* What to change, by name: "Change those next" left a tester guessing (17-nov). */}
          {contentClues.length
            ? `These details are still in your post: ${contentClues
                .slice(0, 4)
                .map((c) => `“${c.phrase}”`)
                .join(', ')}. Change them next.`
            : 'It goes by what you write about: change the specifics of the story (the events, the people), not your words.'}
        </p>
      )}

      {verdict && verdict.reasons.length > 0 && picks.length === verdict.attempts && (
        <Why summary={reasonsSeat ? `the attacker’s reasons for Writer ${reasonsSeat}` : 'the attacker’s reasons'}>
          {reasonsSeat && (
            <p className="hint reasons-whose">
              For its last pick, Writer {reasonsSeat}
              {standIn ? '' : ', not you'}: why it matched the post with {reasonsSeat}’s writing.
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
                    · {seatOf(SELF_ID)} is {standIn ? 'the sample writer' : 'you'}
                  </em>
                )}
                {(fromPick.length > 0 || fromOther) && (
                  <em className="from-pick">
                    {' '}
                    · quotes{' '}
                    {fromOther
                      ? 'another writer’s text'
                      : verdict?.reasonsPick === SELF_ID
                        ? standIn
                          ? 'the sample writer’s posts'
                          : 'your public writing'
                        : `Writer ${reasonsSeat}’s writing`}
                  </em>
                )}
                {notIn.length > 0 && (
                  <em className="ungrounded">
                    {' '}
                    · {notIn.map((q) => `“${q}”`).join(', ')} {notIn.length > 1 ? 'are' : 'is'} in none of the texts it was given
                  </em>
                )}
              </li>
            ))}
          </ul>
          {foldedReasons > 0 && (
            <button className="mini reasons-more" onClick={() => setShowUngrounded(true)}>
              {/* The action first: "…: show" at the end read as a glitch to a tester (17-nov). */}
              {foldedReasons === 1 ? 'Show one more reason: it quotes' : `Show ${foldedReasons} more reasons: they quote`} words that are in none of the texts it
              was given
            </button>
          )}
          {bySubject && (
            <p className="hint subject-note">
              Some of its reasons are about what you write about, not how you write. If the other nine writers are not from your field, start over and pick a
              closer one; if they are, your subject alone gives you away.
            </p>
          )}
        </Why>
      )}

      {/* The ten writers, a line each: "the same field" was a claim a judge could not see (17-nov). */}
      <details className="disclosure lineup-texts">
        <summary>Read a line from each writer</summary>
        <ul className="disclosure-body">
          {lineup.map((c) => (
            <li key={c.id}>
              <b>{c.letter}</b>{' '}
              {c.id === SELF_ID && <em>{standIn ? 'sample writer' : ownText ? 'you, your public writing' : 'you, the sample writer’s posts'}: </em>}
              {firstLine(corpusOf(c.id))}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );

  // What each step shows: your post until it has been attacked, the lineup from the scan on; a verdict comes first.
  const showPost = stage !== 'attacked' || editingByHand;
  const showLineup = stage !== 'draft' && (stage !== 'rewritten' || attacking);
  const verdictFirst = stage === 'attacked' || stage === 'reattacked';

  return (
    <div className="stage" ref={stageRef}>
      <Stepper steps={steps} current={STAGE_STEP[stage]} busySince={busySince} outcome={outcome} round={rounds} />
      {error && <ErrorNote message={error} />}
      <header className="stage-head">
        <h1 className="stage-title">{head.title}</h1>
        <p className="stage-lede">{head.lede}</p>
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
