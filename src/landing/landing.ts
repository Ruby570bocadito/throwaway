// Landing page script. No React and no Firebase: the page already reads on its own; this adds the motion (the photo being
// checked in the hero, the lineup replaying the measured run, the before-and-after slider) and fits the buttons to this browser.
import { deviceModelStatus } from '../framework/device';

declare global {
  interface Window {
    __landing?: boolean;
  }
}
window.__landing = true; // tells the fallback in boot.js that this script ran

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The page's language: English at /, Spanish at /es/ (22-nov). The script's own words follow it. */
const ES = document.documentElement.lang === 'es';
const tr = (en: string, es: string) => (ES ? es : en);

/**
 * Each writer's glyph in the demo lineup, seats A to J (you are C): how often they use the twelve commonest function words
 * and five punctuation habits, against the other nine, in standard deviations. Computed once from src/demo/scenario.ts with
 * the app's own stylometry (src/ui/glyphs.ts), so the landing page draws the same cards as the app without loading the texts.
 */
const GLYPHS: number[][] = [
  [-0.7, -0.7, 0.7, -1.1, -0.2, 0.1, 0.8, 0.2, 1.7, 0.6, -0.6, -0.8, -0.3, -0.3, 2, 0, -0.3],
  [-0.5, 1.8, 1, 0, -0.1, -0.5, -0.6, 2, -1.2, -0.9, -0.6, -0.8, -0.3, -0.3, -0.3, 0, -0.3],
  [-0.1, 0.5, 0.2, 1.3, 0.1, 0.7, -0.1, 0.3, -0.7, 0.7, 1.5, -0.3, 2, 2, -0.3, 0, -0.3],
  [1.2, 0.8, -1.2, -1.1, -1, -0.5, 2, 0, 1.2, -0.9, -0.6, 2, -0.3, -0.3, -0.3, 0, -0.3],
  [-0.1, 0.2, -0.3, -0.2, 0.5, -0.5, -0.6, -0.8, -1.2, 1.9, -0.6, 0.5, -0.3, -0.3, -0.3, 0, -0.3],
  [2, -0.8, -0.3, -1.1, -1, -0.5, -0.6, -0.8, 0.1, -0.9, 2, -0.8, -0.3, -0.3, -0.3, 0, -0.3],
  [-1.3, -1.8, 2, 0, -1, -0.5, -0.6, 0.3, 0.4, 0.7, -0.6, 0.7, -0.3, -0.3, -0.3, 0, -0.3],
  [-0.5, -0.6, -1.2, 2, 0.8, -0.5, 0.2, -0.8, -1.2, 0.8, -0.6, -0.8, -0.3, -0.3, -0.3, 0, -0.3],
  [-0.9, 0.9, 0.4, -0.3, -0.4, 2, -0.6, 0, 0, -0.9, 0.6, 0.3, -0.3, -0.3, -0.3, 0, -0.3],
  [0.7, -0.3, -1.2, 0.2, 2, -0.5, -0.6, -0.8, 0.8, -0.9, -0.6, -0.8, -0.3, -0.3, -0.3, 0, 2],
];

revealOnScroll();
followSections();
rememberLanguage();
void adaptToThisBrowser();
linkManifestAndWorker();
const shot = document.querySelector<HTMLElement>('.hero-shot');
if (shot) heroShot(shot);
const lineup = document.querySelector<HTMLElement>('.lineup');
if (lineup) lineupReplay(lineup);
const compareBox = document.querySelector<HTMLElement>('.compare');
if (compareBox) compareSlider(compareBox);

function revealOnScroll() {
  const items = [...document.querySelectorAll<HTMLElement>('.reveal')];
  if (!('IntersectionObserver' in window)) {
    for (const el of items) el.classList.add('in');
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  for (const el of items) io.observe(el);
}

/** The language switch is remembered, so / does not send a Spanish browser back to /es/ after it chose English (boot.js). */
function rememberLanguage() {
  for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-lang]'))
    a.addEventListener('click', () => {
      try {
        localStorage.setItem('lang', a.dataset.lang ?? 'en');
      } catch {
        // private mode or blocked storage: the link still works, it is just not remembered
      }
    });
}

/** The navigation marks the section you are reading. */
function followSections() {
  const links = [...document.querySelectorAll<HTMLAnchorElement>('.nav nav a[href^="#"]')];
  const sections = links.map((a) => document.querySelector<HTMLElement>(a.hash)).filter((s): s is HTMLElement => !!s);
  if (!sections.length || !('IntersectionObserver' in window)) return;
  const visible = new Map<Element, boolean>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) visible.set(e.target, e.isIntersecting);
      const current = sections.find((s) => visible.get(s));
      for (const a of links) {
        if (current && a.hash === `#${current.id}`) a.setAttribute('aria-current', 'location');
        else a.removeAttribute('aria-current');
      }
    },
    // A section counts once it reaches the upper part of the screen.
    { rootMargin: '-35% 0px -60% 0px' },
  );
  for (const s of sections) io.observe(s);
}

/** Installable, and the shell opens offline. The worker runs in production only: in development it would cache Vite's modules. */
function linkManifestAndWorker() {
  // A few seconds after load, when the browser is idle: nothing on screen needs either, and the manifest in the HTML sat on
  // the first paint's critical path (Lighthouse, 16-nov: ~400 ms of simulated LCP on this page).
  addEventListener('load', () =>
    setTimeout(
      () =>
        whenIdle(() => {
          const manifest = document.createElement('link');
          manifest.rel = 'manifest';
          manifest.href = '/manifest.webmanifest';
          document.head.append(manifest);
          if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => undefined);
        }),
      3000,
    ),
  );
}

function whenIdle(fn: () => void) {
  if ('requestIdleCallback' in window) requestIdleCallback(fn, { timeout: 5000 });
  else setTimeout(fn, 200);
}

/** Most visitors have no Gemini Nano: point them at the demo first, and say what still works here. */
async function adaptToThisBrowser() {
  const status = await deviceModelStatus();
  if (status === 'unavailable') {
    for (const group of document.querySelectorAll<HTMLElement>('.ctas')) {
      for (const live of group.querySelectorAll<HTMLElement>('[data-cta="live"]')) live.classList.replace('primary', 'secondary');
      group.querySelector<HTMLElement>('[data-cta="demo"]')?.classList.replace('demo', 'primary');
    }
  }
  const note = document.querySelector<HTMLElement>('[data-nano]');
  if (!note) return;
  // Three testers read "your first check starts the download" as a hidden download (22-nov): say what, when and how big.
  const appInEnglish = ' La app, de momento, está en inglés.';
  note.textContent =
    status === 'available'
      ? tr(
          'Free, no account. Gemini Nano, the small Google AI that runs on your computer, is ready in this Chrome: the full check works here.',
          'Gratis y sin cuenta. Gemini Nano, la IA pequeña de Google que funciona en tu ordenador, ya está lista en este Chrome: la revisión completa funciona aquí.' + appInEnglish,
        )
      : status === 'downloadable'
        ? tr(
            'Free, no account. This Chrome can add Gemini Nano, a small Google AI that runs on your computer. Chrome downloads it once, when you start your first check, and needs about 22 GB of free disk.',
            'Gratis y sin cuenta. Este Chrome puede añadir Gemini Nano, una IA pequeña de Google que funciona en tu ordenador. Chrome la descarga una vez, cuando empiezas tu primera revisión, y necesita unos 22 GB libres en el disco.' + appInEnglish,
          )
        : tr(
            // The photo was missing here, so a phone-only tester did not know what she could do with one (22-nov).
            'Free, no account. This browser has no Gemini Nano: watch a real check, check a post with fixed rules, or pick what to blur in a photo. The full check needs Chrome on a computer.',
            'Gratis y sin cuenta. Este navegador no tiene Gemini Nano: mira una revisión real, revisa un post con reglas fijas o elige qué difuminar en una foto. La revisión completa necesita Chrome en un ordenador.' + appInEnglish,
          );
}

/**
 * A pause that stops while `el` is off screen or the tab is hidden, so a loop never runs for nobody. Resolves after `ms`
 * of visible time.
 */
function visibleClock(el: Element) {
  let inView = false;
  let wake: (() => void) | null = null;
  const awake = () => inView && document.visibilityState === 'visible';
  new IntersectionObserver(
    (entries) => {
      inView = entries.some((e) => e.isIntersecting);
      if (awake()) wake?.();
    },
    { threshold: 0.25 },
  ).observe(el);
  document.addEventListener('visibilitychange', () => {
    if (awake()) wake?.();
  });
  return async (ms: number) => {
    for (let left = ms; left > 0; left -= 100) {
      while (!awake())
        await new Promise<void>((resolve) => {
          wake = () => {
            wake = null;
            resolve();
          };
        });
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, left)));
    }
  };
}

/** Restart a one-shot CSS animation class (a reflow in between, or the browser keeps the finished one). */
function replay(el: Element, cls: string) {
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
}

type Phase = 'idle' | 'scan' | 'found' | 'blur' | 'safe';

/** The hero: the demo selfie is checked in front of you, with the mascot reacting to each step. */
function heroShot(fig: HTMLElement) {
  const box = fig.querySelector<HTMLElement>('.shot');
  const chip = fig.querySelector<HTMLElement>('[data-chip]');
  const mascot = fig.querySelector<HTMLImageElement>('[data-mascot]');
  if (!box || !chip || !mascot) return;
  const POSE: Record<Phase, string> = { idle: 'wave', scan: 'scan', found: 'alarm', blur: 'blur', safe: 'safe' };
  const CHIP: Record<Phase, string> = {
    idle: tr('Your photo, on your device', 'Tu foto, en tu dispositivo'),
    scan: tr('Looking for clues on your device…', 'Buscando pistas en tu dispositivo…'),
    found: tr('3 clues found on your device', '3 pistas encontradas en tu dispositivo'),
    blur: tr('Blurred on your device', 'Difuminado en tu dispositivo'),
    safe: tr('Tested by an AI in the cloud', 'Probado por una IA en la nube'),
  };
  const show = (phase: Phase) => {
    box.dataset.phase = phase;
    chip.textContent = CHIP[phase];
    const src = `/mascot/${POSE[phase]}-256.webp`;
    if (!mascot.src.endsWith(src)) {
      mascot.src = src;
      if (!reduceMotion) replay(mascot, 'hop');
    }
  };
  if (reduceMotion) {
    show('blur'); // the outcome, still: clues blurred, the face left as it is
    return;
  }
  // The other poses and the blurred photo, before the loop needs them.
  addEventListener('load', () =>
    whenIdle(() => {
      for (const p of Object.values(POSE)) new Image().src = `/mascot/${p}-256.webp`;
    }),
  );
  const wait = visibleClock(box);
  const STEPS: [Phase, number][] = [
    ['idle', 1300],
    ['scan', 2100],
    ['found', 2600],
    ['blur', 2600],
    ['safe', 3400],
  ];
  void (async () => {
    await wait(600);
    for (;;) {
      for (const [phase, ms] of STEPS) {
        show(phase);
        await wait(ms);
      }
    }
  })();
}

/** The lineup replays the measured run: as posted the attacker picks the real author ten times, after the rewrite never. */
function lineupReplay(root: HTMLElement) {
  const cards = [...root.querySelectorAll<HTMLElement>('.w')];
  const chip = root.querySelector<HTMLElement>('[data-chip]');
  const num = root.querySelector<HTMLElement>('.tally-num');
  const what = root.querySelector<HTMLElement>('.tally-what');
  const before = document.querySelector<HTMLElement>('.post-quote.before');
  const after = document.querySelector<HTMLElement>('.post-quote.after');
  if (cards.length !== 10 || !chip || !num || !what) return;
  cards.forEach((card, k) => card.querySelector('b')?.after(glyph(GLYPHS[k])));

  const ME = 2; // C, as in the app
  const AFTER = [5, 5, 6, 5, 5, 5, 5, 5, 5, 5]; // after the rewrite: F nine times, G once (16-nov run)
  const tally = cards.map(() => 0);
  const badge = (k: number) => {
    let b = cards[k].querySelector<HTMLElement>('.w-count');
    if (!b) {
      b = document.createElement('span');
      b.className = 'w-count';
      cards[k].append(b);
    }
    return b;
  };
  const clear = () => {
    tally.fill(0);
    for (const c of cards) {
      c.querySelector('.w-count')?.remove();
      c.classList.remove('pointed', 'found');
    }
  };
  const pick = (k: number) => {
    cards.forEach((c, j) => c.classList.toggle('pointed', j === k));
    tally[k]++;
    const b = badge(k);
    b.textContent = String(tally[k]);
    replay(b, 'w-count');
    if (k === ME) cards[k].classList.toggle('found', tally[k] >= 3);
  };
  const say = (phase: 'before' | 'after', label: string, score: string) => {
    root.dataset.phase = phase;
    chip.textContent = label;
    num.textContent = score;
    what.textContent = tr('tries found the real author', 'intentos acertaron');
    // the version the attacker is reading stands out
    before?.classList.toggle('live', phase === 'before');
    after?.classList.toggle('live', phase === 'after');
  };

  if (reduceMotion) {
    // Still: the original's run, which the verdicts under the lineup then compare with the rewrite.
    say('before', tr('Original', 'Original'), '10/10');
    for (let i = 0; i < 10; i++) pick(ME);
    cards[ME].classList.remove('pointed');
    return;
  }
  const wait = visibleClock(root);
  before?.parentElement?.classList.add('replaying');
  void (async () => {
    for (;;) {
      clear();
      say('before', 'Original', '0/0');
      await wait(900);
      for (let i = 1; i <= 10; i++) {
        pick(ME);
        num.textContent = `${i}/${i}`;
        await wait(260);
      }
      cards[ME].classList.remove('pointed');
      replay(num, 'stamp');
      await wait(2200);

      say('after', tr('Rewritten on your device', 'Reescrita en tu dispositivo'), '0/0');
      clear();
      await wait(1500);
      for (let i = 1; i <= 10; i++) {
        pick(AFTER[i - 1]);
        num.textContent = `0/${i}`;
        await wait(260);
      }
      for (const c of cards) c.classList.remove('pointed');
      replay(num, 'stamp');
      await wait(3800);
    }
  })();
}

function glyph(values: number[]): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const w = values.length * 4;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} 24`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(NS, 'line');
  line.setAttribute('x1', '0');
  line.setAttribute('y1', '12');
  line.setAttribute('x2', String(w));
  line.setAttribute('y2', '12');
  svg.append(line);
  values.forEach((z, i) => {
    const r = document.createElementNS(NS, 'rect');
    r.setAttribute('x', String(i * 4 + 0.6));
    r.setAttribute('width', '2.8');
    r.setAttribute('y', String(z > 0 ? 12 - z * 5 : 12));
    r.setAttribute('height', String(Math.max(0.8, Math.abs(z) * 5)));
    svg.append(r);
  });
  return svg;
}

/** Before and after: drag (or use the arrow keys) to compare the selfie as posted with the blurred one. */
function compareSlider(box: HTMLElement) {
  const range = box.querySelector<HTMLInputElement>('.compare-range');
  if (!range) return;
  range.hidden = false;
  const set = (v: number) => box.style.setProperty('--pos', `${v}%`);
  let touched = false;
  range.addEventListener('input', () => {
    touched = true;
    set(Number(range.value));
  });
  if (reduceMotion || !('IntersectionObserver' in window)) return;
  // Once, as it comes into view: a nudge that shows it moves, and both sides of the line.
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      const keys: [number, number][] = [
        [0, 50],
        [0.32, 22],
        [0.72, 78],
        [1, 50],
      ];
      const ms = 2800;
      let t0 = 0;
      const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
      const tick = (now: number) => {
        if (touched) return;
        t0 ||= now;
        const t = Math.min(1, (now - t0) / ms);
        const k = keys.findIndex(([at]) => at >= t);
        const [a, va] = keys[Math.max(0, k - 1)];
        const [b, vb] = keys[Math.max(1, k)];
        const v = va + (vb - va) * ease(b > a ? (t - a) / (b - a) : 1);
        set(v);
        range.value = String(Math.round(v));
        if (t < 1) requestAnimationFrame(tick);
      };
      setTimeout(() => requestAnimationFrame(tick), 500);
    },
    { threshold: 0.6 },
  );
  io.observe(box);
}
