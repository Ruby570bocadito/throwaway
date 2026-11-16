import { useDeferredValue, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { styleMarkers, type Reliability } from '../engine/stylometry';
import { DECOYS, DRAFT, MARTA_PUBLIC, SELF_ID } from '../demo/scenario';
import { FIELD_IDS, FIELD_LABELS, type DecoyPackId } from '../demo/fields';
import { PrivacyViolation, release, secret, type Private, type Publishable } from '../framework';
import { hasPhrase, ruleDetails, type AuthorshipVerdict, type Clue } from '../threats/authorship';
import { buildAuthorship, lineupField, loadDecoyPacks, type DecoyPacks } from '../kit';
import { ErrorNote, friendlyError, Silhouette, type LabProps } from '../ui/shared';
import { Compare } from '../ui/Compare';
import { Stepper, type StepDef } from '../ui/Stepper';
import { WorkLog, type PlanStep } from '../ui/WorkLog';
import { useAnimatedNumber } from '../ui/motion';

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
const REWRITE_PLAN: PlanStep[] = [
  { match: /^Fixed rules generalised/, label: 'Generalise the details', route: 'local-js', optional: true },
  { match: /^Rewrite on-device/, label: 'Rewrite your style', route: 'on-device', slow: true },
  { match: /^Check the final text/, label: 'Check the final text for details', route: 'local-js' },
  { match: /^Meaning check/, label: 'Check that the meaning survived', route: 'on-device', slow: true },
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (p: string) => (p.includes(' ') ? esc(p).replace(/ /g, '[\\s,]+') : p === '—' ? '—' : `\\b${esc(p)}\\b`);
const at = (i: number) => ({ '--i': i }) as CSSProperties;

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

export function TextLab({ kit, localBackend, degraded, registerLeak, recorded, dock }: LabProps) {
  const [stage, setStage] = useState<Stage>('draft');
  const [draft, setDraft] = useState(DRAFT);
  const [edited, setEdited] = useState('');
  const [published, setPublished] = useState<Publishable<string> | null>(null);
  const [clues, setClues] = useState<Clue[]>([]);
  const [verdict, setVerdict] = useState<AuthorshipVerdict | null>(null);
  const [before, setBefore] = useState<number | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [busySince, setBusySince] = useState<number | null>(null);
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
  // Writing you already published under your name (optional, live only, never stored): the fingerprint compares you with you.
  const [ownPublic, setOwnPublic] = useState('');
  const ownWords = ownPublic.trim() ? ownPublic.trim().split(/\s+/).length : 0;
  const selfCorpus = ownPublic.trim() || MARTA_PUBLIC;
  const [error, setError] = useState('');
  const privateDraft = useRef<Private<string> | null>(null);
  const acted = useRef(false);

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

  const threat = useMemo(
    () =>
      buildAuthorship(
        (pickId) => {
          setCurrent(pickId);
          setPicks((p) => [...p, pickId]);
        },
        ownPublic,
        decoys,
      ),
    [ownPublic, decoys],
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

  // After an action, hand keyboard focus to the next one (only if it was in the dock, so nothing else is taken away).
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

  const shownText = published ? published.value : stage === 'draft' ? draft : degraded && edited ? edited : draft;
  // The fingerprint meter sits below the fold: it is computed when it comes into view (or once a scan starts), in a
  // background render, so loading the page and typing never wait for it.
  const meterRef = useRef<HTMLDivElement>(null);
  const [meterNear, setMeterNear] = useState(false);
  useEffect(() => {
    const el = meterRef.current;
    if (!el || meterNear) return;
    if (!('IntersectionObserver' in window)) return setMeterNear(true);
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setMeterNear(true));
    io.observe(el);
    return () => io.disconnect();
  }, [meterNear]);
  const fingerprintText = useDeferredValue(meterNear || stage !== 'draft' ? shownText : '', '');
  const stylo = useMemo(() => (fingerprintText ? threat.fingerprint(fingerprintText) : null), [threat, fingerprintText]);
  const rank = useAnimatedNumber(stylo?.rank ?? 1, { duration: 900 });
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
      setError(friendlyError(e));
    } finally {
      setBusy('');
      setBusySince(null);
      setDownload(null);
      setCurrent(null);
    }
  }

  const prepare = async () => {
    if (localBackend.prepare) await localBackend.prepare((p) => setDownload(p)); // a user gesture: Chrome requires it, and it may download Gemini Nano
  };

  const scan = () =>
    run('scan', async () => {
      privateDraft.current = secret(draft, 'your draft');
      if (degraded) {
        // No local model: only the deterministic fingerprint and fixed rules run. Nothing is sent anywhere.
        const rules = ruleDetails(draft).map((d) => ({ ...d, kind: 'content' as const }));
        setClues([...styleMarkers(draft, selfCorpus, decoys.map((d) => d.corpus)).map((m) => ({ ...m, kind: 'style' as const })), ...rules]);
        kit.ledger.add({ op: 'Fingerprint (Burrows’ Delta)', route: 'local-js', ms: 3, bytesOut: 0 });
        kit.ledger.add({ op: 'Find identifying details', route: 'blocked', ms: 0, bytesOut: 0, note: 'no local model — skipped, not sent to cloud' });
        kit.ledger.add({ op: 'Find counts and dates (fixed rules)', route: 'local-js', ms: 1, bytesOut: 0, note: `no model · ${rules.length} found` });
        setEdited(draft);
      } else {
        await prepare();
        setClues(await threat.findClues(privateDraft.current, kit));
      }
      setStage('scanned');
    });

  const attack = (target: Publishable<string>, after: boolean) =>
    run('attack', async () => {
      setPicks([]);
      setVerdict(null);
      const v = await threat.attack(target, kit);
      setVerdict(v);
      setAttacks((n) => n + 1);
      if (threat.inconclusive(v)) {
        // Too few answers: stay on the same step so the user can attack again.
        setStage(after ? 'rewritten' : 'scanned');
        return;
      }
      if (!after) setBefore(v.hits);
      if (after && threat.exposed(v)) setRounds((r) => r + 1);
      setStage(after && !threat.exposed(v) ? 'reattacked' : 'attacked');
    });

  // Baseline: the user confirms they would publish the draft exactly as it is, so the attacker may see it.
  const attackAsIs = () => {
    setSentAsIs(true);
    return attack(release(draft, 'baseline — user would publish as-is', { userConfirmedAsIs: true }), false);
  };

  const rewrite = () =>
    run('rewrite', async () => {
      if (degraded) {
        // release() refuses the edit if it still contains 8+ word spans of the private draft.
        setPublished(release(edited, 'edited by the user'));
      } else {
        await prepare();
        setPublished(await threat.sanitize(privateDraft.current!, clues, verdict, kit));
      }
      setPicks([]);
      setStage('rewritten');
    });

  const editing = stage === 'draft' || (degraded && (stage === 'scanned' || stage === 'attacked'));
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

  // The line under the lineup: whose field the nine writers share, and what follows from it.
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

  const actions = (
    <>
      {working && busySince !== null && (
        <WorkLog
          ledger={kit.ledger}
          since={busySince}
          plan={busy === 'scan' ? SCAN_PLAN : REWRITE_PLAN}
          title={busy === 'scan' ? 'Scanning your post on this device' : 'Fixing your post on this device'}
          recorded={recorded}
          download={download}
        />
      )}
      {/* What the next attack sends, said before it is sent: the as-is test read as a formality to two testers (16-nov). */}
      {!busy && stage === 'scanned' && <p className="dock-note">Sends this exact text to a cloud AI, ten times, as if you had posted it.</p>}
      {!busy && stage === 'rewritten' && published && (
        <p className="dock-note">{degraded ? 'Sends only your edited version, never the original.' : 'Sends only the rewritten version, never the original.'}</p>
      )}
      <div className="dock-row">
        {stage === 'draft' && (
          <button className="primary" onClick={scan} disabled={!!busy || !draft.trim() || lineupPending} aria-busy={busy === 'scan'}>
            {busy ? <Busy label={busyLabel} /> : 'Scan my post locally'}
          </button>
        )}
        {stage === 'scanned' && (
          <button className="danger" onClick={attackAsIs} disabled={!!busy} aria-busy={busy === 'attack'}>
            {busy ? <Busy label={busyLabel} /> : 'Attack it as I would post it'}
          </button>
        )}
        {stage === 'attacked' && (
          <button className="safe" onClick={rewrite} disabled={!!busy} aria-busy={busy === 'rewrite'}>
            {busy
              ? <Busy label={busyLabel} />
              : degraded
                ? 'Use my edited version'
                : published
                  ? 'Rewrite again on-device'
                  : 'Rewrite on-device with Gemini Nano'}
          </button>
        )}
        {stage === 'rewritten' && published && (
          <button className="danger" onClick={() => attack(published, true)} disabled={!!busy} aria-busy={busy === 'attack'}>
            {busy ? <Busy label={busyLabel} /> : 'Attack again'}
          </button>
        )}
        {stage === 'reattacked' &&
          (contentClues.length ? (
            <p className="outcome bad" role="status">
              Your style is hidden, but {contentClues.length} detail{contentClues.length > 1 ? 's' : ''} can still identify you.
            </p>
          ) : (
            <>
              <p className="outcome" role="status">
                {final ? `The attacker picked you ${final.hits} of ${final.answered} times, no better than chance` : 'The attacker did not find you'}
                {degraded ? ', and no counts or dates are left. Names, places and companies were not checked.' : ', and no identifying details are left.'}
              </p>
              <button className="safe" onClick={copySafe}>
                {copied ? 'Copied' : 'Copy this version'}
              </button>
            </>
          ))}
      </div>
    </>
  );

  return (
    <>
      <Stepper steps={steps} current={STAGE_STEP[stage]} busySince={busySince} outcome={outcome} round={rounds} />
      {error && <ErrorNote message={error} />}
      <section className="card draft" aria-labelledby="draft-title">
        <div className="card-head">
          <div>
            <p className="kicker">Your device</p>
            <h2 id="draft-title">Your anonymous post</h2>
          </div>
          <span className={`chip ${!published && sentAsIs ? 'asis' : 'private'}`}>
            {published ? 'released for publication' : sentAsIs ? 'sent as-is to the attacker · your choice' : 'private · stays on this device'}
          </span>
        </div>
        <p className="context">
          {draft === DRAFT ? 'Sample post: an anonymous review of an employer, from a throwaway account' : 'Your post, about to be published anonymously'}
        </p>
        <div className={`sheet-wrap ${working ? 'reading' : ''}`}>
          {editing ? (
            <textarea
              ref={textareaRef}
              aria-label="Your anonymous post"
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
        {degraded && stage === 'attacked' && (
          <p className="hint">Your turn to rewrite (no local model here): edit the text above, drop the habits and details listed below, then use your edited version.</p>
        )}
        {published && claims && <p className="hint">Rewritten in a plain, neutral voice on purpose: your writing style is what gave you away.</p>}
        {stage === 'draft' && !recorded && (
          <div className="draft-tools">
            <span className="hint">Edit this sample, or paste the post you are about to publish.</span>
            <button
              className="mini"
              onClick={() => {
                setDraft('');
                textareaRef.current?.focus();
              }}
            >
              Clear and paste mine
            </button>
          </div>
        )}
        {stage === 'draft' && !recorded && (
          <details className="own-writing" onToggle={(e) => e.currentTarget.open && setWantPacks(true)}>
            <summary>Compare with your own public writing{ownWords ? ` · ${ownWords} words` : ' (optional)'}</summary>
            <p className="hint">
              Paste things you have already published under your name: blog posts, LinkedIn posts, comments. The fingerprint compares them with your
              anonymous post on this device. For the attack they go to the cloud as one of the ten writers, so paste only writing that is already public.
              Nothing is stored.
            </p>
            <textarea
              aria-label="Your public writing"
              rows={5}
              value={ownPublic}
              onChange={(e) => setOwnPublic(e.target.value)}
              placeholder="Paste a few paragraphs you have published under your name…"
            />
            {ownWords > 0 && ownWords < 150 && <p className="hint">At least 150 words make a useful fingerprint.</p>}
          </details>
        )}
        {stage === 'draft' && recorded && (
          <p className="hint">
            Recorded run: the sample post is fixed, because the model answers were recorded for it. To check your own post,{' '}
            <a href={location.pathname}>open the live version</a> in Chrome with Gemini Nano.
          </p>
        )}
        {published && (
          <div className="takeaway rise">
            <div className="takeaway-actions">
              <button className="mini" onClick={copySafe}>
                {copied ? 'Copied' : 'Copy this version'}
              </button>
              <button className="mini" aria-expanded={showCompare} onClick={() => setShowCompare((v) => !v)}>
                {showCompare ? 'Hide the comparison' : 'Compare with your original'}
              </button>
            </div>
            {showCompare && <Compare original={draft} final={published.value} />}
            <p className="hint">Read it before you post: the meaning check runs on a small model and can miss a change.</p>
          </div>
        )}

        {stage !== 'draft' && (
          <div className="findings" key={published ? 'after' : 'before'}>
            <div className="finding-col">
              <h3>Style habits</h3>
              {styleClues.length === 0 ? (
                <p className="good rise">No habits from your public writing.</p>
              ) : (
                styleClues.map((m, i) => (
                  <div key={`${m.phrase}-${i}`} className="finding style rise" style={at(i)}>
                    <code>{m.phrase}</code> <span>{m.why}</span>
                  </div>
                ))
              )}
            </div>
            <div className="finding-col">
              <h3>Identifying details</h3>
              {contentClues.length === 0 ? (
                <p className="good rise">
                  {degraded ? (published ? 'No counts or dates left.' : 'No counts or dates found.') : published ? 'None left (checked on your device).' : 'None found.'}
                </p>
              ) : (
                contentClues.map((m, i) => (
                  <div key={`${m.phrase}-${i}`} className="finding content rise" style={at(i)}>
                    <code>{m.phrase}</code> <span>{m.why}</span>
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
        )}

        {/* Without a local model only the fixed rules ran: say what that left unchecked, where the findings are (16-nov). */}
        {stage !== 'draft' && degraded && (
          <p className="unchecked rise">
            <strong>Not checked: names, places and companies.</strong> There is no local model on this device, so look for them yourself before you
            post.
          </p>
        )}

        {published && claims?.meaningCheck === 'failed' && (
          <div className="claims failed rise">
            <h3>Meaning check · no answer</h3>
            <p>Gemini Nano gave no readable answer, so nothing checked that the rewrite still says what you meant. Read it before you post.</p>
          </div>
        )}
        {published && claims && claims.claims.length > 0 && (
          <div className="claims rise">
            <h3>
              Meaning check · {claims.claims.filter((c) => c.kept).length}/{claims.claims.length} claims kept · checked on your device
            </h3>
            <ul>
              {claims.claims.map((c, i) => (
                <li key={`${c.claim}-${i}`} className={`rise ${c.kept ? '' : 'lost'}`} style={at(i + 2)}>
                  <span aria-hidden="true">{c.kept ? '✓' : '✗'}</span> {c.claim}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="meter" ref={meterRef}>
          <div className="meter-top">
            <span className="meter-label">Your rank among ten writers: #1 reads most like you, #10 least</span>
            <strong className={!stylo || tooShort ? '' : stylo.rank === 1 ? 'bad' : 'good'}>
              #{stylo && !tooShort ? Math.round(rank) : '–'} <span>of 10</span>
            </strong>
          </div>
          <div className="bar">
            <i style={{ transform: `scaleX(${stylo && !tooShort ? stylo.score : 0})` }} className={(stylo?.score ?? 0) > 0.6 ? 'bad' : 'good'} />
          </div>
          {trust && (
            <div className={`trust ${trust.level}`}>
              <span className="conf">{CONFIDENCE[trust.level]}</span>
              {!tooShort && (
                <span>
                  {trust.rankRange[0] === trust.rankRange[1] ? `Steady at #${trust.rankRange[0]}` : `Likely #${trust.rankRange[0]} to #${trust.rankRange[1]}`}
                </span>
              )}
              {trust.notes.length > 0 && <p className="trust-notes">{trust.notes.join(' ')}</p>}
            </div>
          )}
          <small>Local fingerprint: Burrows’ Delta on function words, range from 100 resamples · in your browser · 0 bytes sent</small>
          {draft !== DRAFT && !ownPublic.trim() && !recorded && (
            <p className="hint">Compared with the sample writer’s public posts. Add your own public writing above for a fingerprint of you.</p>
          )}
        </div>
      </section>

      <section className="card lineup" aria-labelledby="lineup-title">
        <div className="card-head">
          <div>
            <p className="kicker">The cloud</p>
            <h2 id="lineup-title">The lineup</h2>
          </div>
          <span className="chip public">what the cloud sees</span>
        </div>
        <p className="context">A cloud AI gets the text and ten public writers, shuffled on every attempt. It is never told which one is you.</p>
        <p className="field-line">
          {canPickField ? (
            <label>
              The other nine write about{' '}
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
          ) : (
            <>
              The other nine write about <strong>{FIELD_LABELS[lineupOf.field]}</strong>
            </>
          )}
          {fieldNote}
        </p>
        <div className={`suspects ${busy === 'attack' ? 'looking' : ''}`}>
          {lineup.map((c) => {
            const n = picks.filter((p) => p === c.id).length;
            const isMe = c.id === SELF_ID;
            return (
              <div key={c.id} className={`suspect ${current === c.id ? 'pointed' : ''} ${n > 0 ? 'picked' : ''} ${isMe ? 'me' : ''}`}>
                <div className="shot">
                  <Silhouette hot={isMe && n >= 3} />
                </div>
                <span className="letter">{c.letter}</span>
                {isMe && <span className="you">you · local only</span>}
                {n > 0 && (
                  <span className="count" key={n}>
                    {n}
                  </span>
                )}
              </div>
            );
          })}
        </div>
        <div className={`score ${final && !busy ? (inconclusive ? 'mute' : exposedNow ? 'bad' : 'good') : ''}`} aria-live="polite">
          {busy === 'attack' || !final ? (
            <>
              <div className="big">{picks.length ? `${hits}/${picks.length}` : '?/10'}</div>
              <div>
                <strong>{busy === 'attack' ? `Attacking… attempt ${Math.min(picks.length + 1, 10)} of 10` : 'No one has looked yet'}</strong>
                <p>{busy === 'attack' ? 'Chance level is 1 in 10.' : 'Attack it to see who the cloud picks. Chance level is 1 in 10.'}</p>
                {busy === 'attack' && (
                  <span className="ticks" aria-hidden="true">
                    {Array.from({ length: 10 }, (_, i) => (
                      <i key={i} className={i < picks.length ? (picks[i] === SELF_ID ? 'hit' : 'miss') : ''} />
                    ))}
                  </span>
                )}
              </div>
            </>
          ) : (
            <>
              <div key={attacks} className={`big stamp ${inconclusive ? '' : exposedNow ? 'bad' : 'good'}`}>
                {final.hits}/{final.answered}
              </div>
              <div>
                <strong>{inconclusive ? 'Inconclusive: the cloud model was too busy' : exposedNow ? 'The attacker found you' : 'You are one of ten'}</strong>
                <p>
                  Chance level is 1 in 10.
                  {final.answered < final.attempts ? ` ${final.attempts - final.answered} attempts got no answer (model busy).` : ''}
                  {before !== null && stage === 'reattacked' ? ` Before: ${before}/10.` : ''}
                </p>
              </div>
            </>
          )}
        </div>
        {verdict && verdict.reasons.length > 0 && picks.length === verdict.attempts && (
          <div className="reasons-box rise">
            <h3>The attacker’s reasons</h3>
            <ul className="reasons">
              {verdict.reasons.map((r, i) => (
                <li key={`${r}-${i}`} className="rise" style={at(i + 1)}>
                  {r}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      {dock && createPortal(actions, dock)}
    </>
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
