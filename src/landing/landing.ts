// Landing page script. No React and no Firebase: the page already reads on its own, this only adds motion and the photo demo.
import { SCENE_H, SCENE_SVG, SCENE_W } from '../demo/photo';
import { browserImageOps, svgToPng } from '../engine/image';
import { deviceModelStatus } from '../framework/device';

declare global {
  interface Window {
    __landing?: boolean;
  }
}
window.__landing = true; // tells the fallback in index.html that this script ran

const GRID = 4; // the photo threat's grid (src/threats/location.ts)
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

revealOnScroll();
void adaptToThisBrowser();
const replayFigure = document.querySelector<HTMLElement>('.replay');
if (replayFigure && !reduceMotion) replay(replayFigure);
const photoCard = document.querySelector<HTMLElement>('[data-photo]');
// Drawing and pixelating the scene takes a few hundred ms of main thread: do it when the card is near, not at load
// (Lighthouse, 16-nov: 740 ms of blocking time on the landing page, almost all of it this).
if (photoCard) whenNear(photoCard, () => void photoDemo(photoCard));

function whenNear(el: Element, run: () => void) {
  if (!('IntersectionObserver' in window)) return run();
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      io.disconnect();
      run();
    },
    { rootMargin: '600px 0px' },
  );
  io.observe(el);
}

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

/** Most visitors have no Gemini Nano: point them at the recorded run first, and say why. */
async function adaptToThisBrowser() {
  const status = await deviceModelStatus();
  if (status === 'unavailable') {
    for (const group of document.querySelectorAll<HTMLElement>('.ctas')) {
      const live = group.querySelector<HTMLElement>('[data-cta="live"]');
      const demo = group.querySelector<HTMLElement>('[data-cta="demo"]');
      if (!live || !demo) continue;
      // Swap the emphasis, not the order: moving the buttons after the first paint is a layout shift (Lighthouse CLS).
      live.classList.replace('primary', 'ghost');
      demo.classList.replace('ghost', 'primary');
    }
  }
  const note = document.querySelector<HTMLElement>('[data-nano]');
  if (!note) return;
  note.textContent =
    status === 'available'
      ? 'Gemini Nano is ready in this browser, so the live run works here. The recorded run works anywhere.'
      : status === 'downloadable'
        ? 'This browser can download Gemini Nano: the live run starts the download the first time. The recorded run works anywhere.'
        : 'This browser has no Gemini Nano, so start with the recorded run: it replays a real one, step by step. The live run needs Chrome on a desktop with Gemini Nano.';
}

/** The hero replays the recorded run: scan on the device, attack (10/10), rewrite on the device, attack again (0/10). */
function replay(fig: HTMLElement) {
  const pols = [...fig.querySelectorAll<HTMLElement>('.pol')];
  const counts = pols.map((p) => p.querySelector<HTMLElement>('.count'));
  const chip = fig.querySelector<HTMLElement>('[data-label]');
  const verdict = fig.querySelector<HTMLElement>('.verdict');
  const num = verdict?.querySelector<HTMLElement>('.num');
  const what = verdict?.querySelector<HTMLElement>('.what');
  if (pols.length !== 10 || !chip || !verdict || !num || !what) return;

  // The same seats as the app's lineup: you are C. After the rewrite the attacker picked F nine times and G once.
  const ME = 2;
  const AFTER = [5, 5, 6, 5, 5, 5, 5, 5, 5, 5];
  const tally = pols.map(() => 0);

  let inView = false;
  let wake: (() => void) | null = null;
  const awake = () => inView && document.visibilityState === 'visible';
  new IntersectionObserver(
    (entries) => {
      inView = entries.some((e) => e.isIntersecting);
      if (awake()) wake?.();
    },
    { threshold: 0.2 },
  ).observe(fig);
  document.addEventListener('visibilitychange', () => {
    if (awake()) wake?.();
  });
  /** A pause that stops while the hero is off screen or the tab is hidden. */
  const wait = async (ms: number) => {
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
  const label = (text: string, kind: 'private' | 'asis' | 'public') => {
    chip.textContent = text;
    chip.className = `chip ${kind}`;
  };
  const say = (kind: '' | 'bad' | 'good', score: string, words: string) => {
    verdict.className = kind ? `verdict ${kind}` : 'verdict';
    num.textContent = score;
    what.textContent = words;
  };
  const clear = () => {
    tally.fill(0);
    for (const c of counts) if (c) c.hidden = true;
    for (const p of pols) p.classList.remove('pointed', 'hot');
  };
  const pick = (k: number) => {
    pols.forEach((p, j) => p.classList.toggle('pointed', j === k));
    tally[k]++;
    const c = counts[k];
    if (c) {
      c.textContent = String(tally[k]);
      c.hidden = false;
    }
    if (k === ME) pols[k].classList.toggle('hot', tally[k] >= 3);
  };

  fig.classList.add('is-animated');
  void (async () => {
    for (;;) {
      fig.classList.remove('p-scan', 'p-strike', 'p-rewrite');
      clear();
      label('your anonymous post · private', 'private');
      say('', '—', 'nobody has looked yet');
      await wait(1200);

      fig.classList.add('p-scan');
      label('scanned on your device · 0 bytes sent', 'private');
      await wait(2200);

      label('sent as-is to the attacker · your choice', 'asis');
      for (let i = 1; i <= 10; i++) {
        pick(ME);
        say('bad', `${i}/${i}`, 'the attacker found you');
        await wait(200);
      }
      pols[ME].classList.remove('pointed');
      await wait(1800);

      fig.classList.add('p-strike');
      label('rewritten on your device · Gemini Nano', 'private');
      await wait(1200);
      fig.classList.add('p-rewrite');
      await wait(1600);

      clear();
      label('released for publication', 'public');
      for (let i = 1; i <= 10; i++) {
        pick(AFTER[i - 1]);
        say('', `0/${i}`, 'looking for you…');
        await wait(200);
      }
      for (const p of pols) p.classList.remove('pointed');
      say('good', '0/10', 'you are one of ten');
      await wait(3800);
    }
  })();
}

/** The photo card: the real demo scene, and the same pixelation the app runs on your device. */
async function photoDemo(card: HTMLElement) {
  const scene = card.querySelector<HTMLElement>('.scene');
  const guess = card.querySelector<HTMLElement>('.guess');
  const buttons = [...card.querySelectorAll<HTMLButtonElement>('button[data-show]')];
  if (!scene || !guess) return;
  let urls: { asis: string; masked: string };
  try {
    const png = await svgToPng(SCENE_SVG, SCENE_W, SCENE_H);
    // The five cells Gemini Nano flagged in a live run: a poster, the street plaque, the house number, the bakery sign, the orange tree.
    const masked = await browserImageOps.maskCells(png, [1, 3, 7, 8, 12], GRID);
    const toUrl = (bytes: Uint8Array) => URL.createObjectURL(new Blob([bytes.slice()], { type: 'image/png' }));
    urls = { asis: toUrl(png), masked: toUrl(masked) };
  } catch {
    return; // the text around the card already tells the story
  }
  const img = new Image(SCENE_W, SCENE_H);
  img.alt = '';
  img.decoding = 'async';
  img.src = urls.asis;
  scene.querySelector('.scene-fallback')?.remove();
  scene.prepend(img);
  scene.classList.add('ready');

  const show = (which: 'asis' | 'masked') => {
    card.dataset.show = which;
    img.src = urls[which];
    for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.show === which));
    const place = document.createElement('strong');
    place.textContent = which === 'asis' ? '“Carrer de la Llum, 23, Palma”' : '“Rome, Italy”';
    guess.replaceChildren('Cloud’s guess: ', place, which === 'asis' ? ' · 0.5 km from the spot' : ' · ~950 km off');
  };
  for (const b of buttons) {
    b.disabled = false;
    b.addEventListener('click', () => show(b.dataset.show === 'masked' ? 'masked' : 'asis'));
  }
}
