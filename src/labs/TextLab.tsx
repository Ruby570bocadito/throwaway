import { useEffect, useMemo, useRef, useState } from 'react';
import { styleMarkers } from '../engine/stylometry';
import { DECOYS, DRAFT, LINEUP, MARTA_PUBLIC, SELF_ID } from '../demo/scenario';
import { PrivacyViolation, release, secret, type Private, type Publishable } from '../framework';
import { hasPhrase, type AuthorshipVerdict, type Clue } from '../threats/authorship';
import { buildAuthorship } from '../kit';
import { Silhouette, type LabProps } from '../ui/shared';

type Stage = 'draft' | 'scanned' | 'attacked' | 'rewritten' | 'reattacked';
const LETTERS = 'ABCDEFGHIJ';

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (p: string) => (p.includes(' ') ? esc(p).replace(/ /g, '[\\s,]+') : p === '—' ? '—' : `\\b${esc(p)}\\b`);

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
  return <p className="draft-text">{parts.map((p, i) => (p.k ? <mark key={i} className={p.k}>{p.t}</mark> : <span key={i}>{p.t}</span>))}</p>;
}

export function TextLab({ kit, localBackend, degraded, registerLeak }: LabProps) {
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
  const [error, setError] = useState('');
  const privateDraft = useRef<Private<string> | null>(null);
  // On-device steps can take a while on a laptop (measured: 15–40 s each): show which one just finished.
  const [lastStep, setLastStep] = useState('');
  useEffect(() => {
    const off = kit.ledger.subscribe((e) =>
      setLastStep(e[0] ? `${e[0].op}${e[0].note && e[0].note !== 'recorded' ? ` · ${e[0].note}` : ' ✓'}` : ''),
    );
    return () => {
      off();
    };
  }, [kit]);

  const threat = useMemo(
    () =>
      buildAuthorship((pickId) => {
        setCurrent(pickId);
        setPicks((p) => [...p, pickId]);
      }),
    [],
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

  // Fixed on-screen letters. Only this browser knows which card is "you"; the attacker gets a fresh shuffle each time.
  const lineup = useMemo(() => [3, 7, 0, 5, 9, 1, 8, 2, 6, 4].map((i, k) => ({ ...LINEUP[i], letter: LETTERS[k] })), []);

  const shownText = published ? published.value : stage === 'draft' ? draft : degraded && edited ? edited : draft;
  const stylo = useMemo(() => threat.fingerprint(shownText), [threat, shownText]);
  const liveStyle = useMemo(
    () => styleMarkers(shownText, MARTA_PUBLIC, DECOYS.map((d) => d.corpus)).map((m) => ({ ...m, kind: 'style' as const })),
    [shownText],
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
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof PrivacyViolation ? e.message : `Something failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
      setCurrent(null);
    }
  }

  const scan = () =>
    run('scan', async () => {
      privateDraft.current = secret(draft, 'your draft');
      if (degraded) {
        // No local model: only the deterministic fingerprint runs. Nothing is sent anywhere.
        setClues(styleMarkers(draft, MARTA_PUBLIC, DECOYS.map((d) => d.corpus)).map((m) => ({ ...m, kind: 'style' as const })));
        kit.ledger.add({ op: 'Fingerprint (Burrows’ Delta)', route: 'local-js', ms: 3, bytesOut: 0 });
        kit.ledger.add({ op: 'Find identifying details', route: 'blocked', ms: 0, bytesOut: 0, note: 'no local model — skipped, not sent to cloud' });
        setEdited(draft);
      } else {
        if (localBackend.prepare) await localBackend.prepare(); // first user gesture: Chrome requires it before on-device inference
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
      if (threat.inconclusive(v)) {
        // Too few answers: stay on the same step so the user can attack again.
        setStage(after ? 'rewritten' : 'scanned');
        return;
      }
      if (!after) setBefore(v.hits);
      setStage(after && !threat.exposed(v) ? 'reattacked' : 'attacked');
    });

  // Baseline: the user confirms they would publish the draft exactly as it is, so the attacker may see it.
  const attackAsIs = () => attack(release(draft, 'baseline — user would publish as-is', { userConfirmedAsIs: true }), false);

  const rewrite = () =>
    run('rewrite', async () => {
      if (degraded) {
        // release() refuses the edit if it still contains 8+ word spans of the private draft.
        setPublished(release(edited, 'edited by the user'));
      } else {
        if (localBackend.prepare) await localBackend.prepare(); // user gesture: may download Gemini Nano
        setPublished(await threat.sanitize(privateDraft.current!, clues, verdict, kit));
      }
      setPicks([]);
      setStage('rewritten');
    });

  const editing = stage === 'draft' || (degraded && (stage === 'scanned' || stage === 'attacked'));

  return (
    <>
      {error && <div className="banner error span">{error}</div>}
      <section className="card draft">
        <div className="card-head">
          <h2>
            <span className="step">1</span> Your anonymous post
          </h2>
          <span className="chip private">{published ? 'released for publication' : 'private · stays on this device'}</span>
        </div>
        <p className="context">Glassdoor review · posted from a throwaway account</p>
        {editing ? (
          <textarea
            aria-label="Your anonymous post"
            value={stage === 'draft' ? draft : edited}
            onChange={(e) => (stage === 'draft' ? setDraft(e.target.value) : setEdited(e.target.value))}
            rows={9}
          />
        ) : (
          <Highlighted text={shownText} marks={[...styleClues, ...contentClues]} />
        )}

        {stage !== 'draft' && (
          <div className="findings">
            <div className="finding-col">
              <h3>Style habits</h3>
              {styleClues.length === 0 ? (
                <p className="good">No habits from your public writing.</p>
              ) : (
                styleClues.map((m) => (
                  <div key={m.phrase} className="finding style">
                    <code>{m.phrase}</code> <span>{m.why}</span>
                  </div>
                ))
              )}
            </div>
            <div className="finding-col">
              <h3>Identifying details</h3>
              {contentClues.length === 0 ? (
                <p className="good">{published ? 'None left (checked on your device).' : degraded ? 'Needs the local model.' : 'None found.'}</p>
              ) : (
                contentClues.map((m) => (
                  <div key={m.phrase} className="finding content">
                    <code>{m.phrase}</code> <span>{m.why}</span>
                  </div>
                ))
              )}
              {generalised.map((g, i) => (
                <div key={`${g.phrase}-${i}`} className="finding generalised">
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

        {published && claims && claims.claims.length > 0 && (
          <div className="claims">
            <h3>
              Meaning check · {claims.claims.filter((c) => c.kept).length}/{claims.claims.length} claims kept · checked on your device
            </h3>
            <ul>
              {claims.claims.map((c) => (
                <li key={c.claim} className={c.kept ? '' : 'lost'}>
                  {c.kept ? '✓' : '✗'} {c.claim}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="meter">
          <div>
            <span className="meter-label">Local fingerprint match</span>
            <strong className={stylo.rank === 1 ? 'bad' : 'good'}>#{stylo.rank} of 10</strong>
          </div>
          <div className="bar">
            <i style={{ width: `${Math.round(stylo.score * 100)}%` }} className={stylo.score > 0.6 ? 'bad' : 'good'} />
          </div>
          <small>Burrows’ Delta on function words · computed in your browser · 0 bytes sent</small>
        </div>
      </section>

      <section className="card lineup">
        <div className="card-head">
          <h2>
            <span className="step">2</span> The lineup
          </h2>
          <span className="chip public">what the cloud sees</span>
        </div>
        <p className="context">A cloud AI gets the text and ten public writers, shuffled on every attempt. It is never told which one is you.</p>
        <div className="suspects">
          {lineup.map((c) => {
            const n = picks.filter((p) => p === c.id).length;
            const isMe = c.id === SELF_ID;
            return (
              <div key={c.id} className={`suspect ${current === c.id ? 'pointed' : ''} ${n > 0 ? 'picked' : ''} ${isMe ? 'me' : ''}`}>
                <Silhouette hot={isMe && n >= 3} />
                <span className="letter">{c.letter}</span>
                {isMe && <span className="you">you · local only</span>}
                {n > 0 && <span className="count">{n}</span>}
              </div>
            );
          })}
        </div>
        <div className="score">
          {busy === 'attack' || !final ? (
            <>
              <div className="big">{picks.length ? `${hits}/${picks.length}` : '—'}</div>
              <div>
                <strong>{busy === 'attack' ? `Attacking… attempt ${Math.min(picks.length + 1, 10)} of 10` : 'Not attacked yet'}</strong>
                <p>Chance level is 1 in 10.</p>
              </div>
            </>
          ) : (
            <>
              <div className={`big ${inconclusive ? '' : exposedNow ? 'bad' : 'good'}`}>
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
          <ul className="reasons">
            {verdict.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        )}
      </section>

      <footer className="actions">
        {stage === 'draft' && (
          <button onClick={scan} disabled={!!busy}>
            {busy ? `Reading your draft locally…${lastStep ? ` · ${lastStep}` : ''}` : 'Scan my post locally'}
          </button>
        )}
        {stage === 'scanned' && (
          <button className="danger" onClick={attackAsIs} disabled={!!busy}>
            {busy ? 'Attacking…' : 'Attack it as I would post it'}
          </button>
        )}
        {stage === 'attacked' && (
          <button className="safe" onClick={rewrite} disabled={!!busy}>
            {busy
              ? degraded
                ? 'Checking your edit…'
                : `Gemini Nano is working on your device…${lastStep ? ` · ${lastStep}` : ''}`
              : degraded
                ? 'Use my edited version'
                : published
                  ? 'Rewrite again on-device'
                  : 'Rewrite on-device with Gemini Nano'}
          </button>
        )}
        {stage === 'rewritten' && published && (
          <button className="danger" onClick={() => attack(published, true)} disabled={!!busy}>
            {busy ? 'Attacking…' : 'Attack again'}
          </button>
        )}
        {stage === 'reattacked' &&
          (contentClues.length ? (
            <span className="done bad">
              Your style is hidden, but {contentClues.length} detail{contentClues.length > 1 ? 's' : ''} can still identify you.
            </span>
          ) : (
            <span className="done">Safe to publish: you are just one of ten, and no identifying details are left.</span>
          ))}
      </footer>
    </>
  );
}
