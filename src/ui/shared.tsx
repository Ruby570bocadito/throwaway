import type { ReactNode } from 'react';
import { cloudTrouble, errorCode, isBlocked, isDeviceError, ModelTimeout, PrivacyViolation, type Kit } from '../framework';
import { lang, num, tr } from '../i18n';

const short = (s: string, n = 140) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s).replace(/\.$/, '');

/** A number as the engine wrote it in English ("1,234"), as the reader writes it. */
const readNum = (s: string) => num(Number(s.replace(/,/g, '')));

/** Where the privacy guard stopped a leak, the part in brackets of its message. */
const WHERE_ES = new Map([
  ['cloud call', 'llamada a la nube'],
  ['cloud prompt text', 'texto de una petición a la nube'],
  ['cloud prompt (parts joined)', 'petición a la nube, con sus partes unidas'],
  ['structured-output schema', 'formato de respuesta pedido a la nube'],
  ['release: rewritten on-device', 'versión reescrita en el dispositivo'],
]);

/**
 * The sentences the engine, the threats and the framework write for people, in Spanish. They stay English at the source,
 * where code and tests match them ("Nothing to mask…", "Blocked…"); the Spanish is given here, on screen only.
 */
const MESSAGES_ES: [RegExp, (...groups: string[]) => string][] = [
  // The privacy guard (framework/guard.ts). A ledger note keeps only its first 90 characters: the end may be cut.
  [
    /^Blocked: private data was about to leave the device \((.*?)(\)\.)?$/s,
    (where, end) => `Bloqueado: iban a salir datos privados del dispositivo (${WHERE_ES.get(where) ?? where}${end ?? ''}`,
  ],
  [/^The cloud model did not answer within (\d+) s\.?$/, (s) => `El modelo de la nube no ha respondido en ${s} s.`],
  [/^Gemini Nano did not answer within (\d+) s on this device\.?$/, (s) => `Gemini Nano no ha respondido en ${s} s en este dispositivo.`],
  [/^The model did not return valid JSON\.?$/, () => 'El modelo no ha devuelto un JSON válido.'],
  [/^The model returned an empty answer\.?$/, () => 'El modelo ha devuelto una respuesta vacía.'],
  [/^No model answered in time\.?$/, () => 'Ningún modelo ha respondido a tiempo.'],
  // The post (threats/authorship.ts).
  [
    /^This post is too long for Gemini Nano on this device \(([\d,]+) words; up to ([\d,]+) fit\)\. Check it in parts\.?$/,
    (words, max) => `Este post es demasiado largo para Gemini Nano en este dispositivo (${readNum(words)} palabras; caben ${readNum(max)} como mucho). Revísalo por partes.`,
  ],
  [/^There is nothing to rewrite: the post is empty\.?$/, () => 'No hay nada que reescribir: el post está vacío.'],
  [/^The local model returned no rewrite it could read\.?$/, () => 'El modelo local no ha devuelto ninguna reescritura que se pueda leer.'],
  [/^The local model repeated the same phrase over and over\.?$/, () => 'El modelo local ha repetido la misma frase una y otra vez.'],
  [/^The local model declined, or dropped most of the post\.?$/, () => 'El modelo local se ha negado, o ha quitado casi todo el post.'],
  [
    /^Gemini Nano kept (?:a passage|(\d+) passages) of your post almost word for word, even when asked again: (.*)\. Try the rewrite again: Gemini Nano words things differently each time\.?$/s,
    (many, quotes) =>
      `Gemini Nano ha copiado ${many ? `${many} trozos` : 'un trozo'} de tu post casi palabra por palabra, incluso al pedírselo otra vez: ` +
      `${quotes.replace(/“/g, '«').replace(/”/g, '»')}. Vuelve a probar la reescritura: Gemini Nano lo dice de otra forma cada vez.`,
  ],
  // The photo (threats/location.ts).
  [
    /^Nothing to mask: no cell of this photo was flagged as a location clue\. If you would post it as it is, attack it as it is\.?$/,
    () => 'No hay nada que difuminar: ninguna casilla de esta foto se ha marcado como pista del lugar. Si la vas a publicar así, pruébala tal como está.',
  ],
  [
    /^Nothing to mask: what was flagged in this photo is all face\. If you would post it as it is, attack it as it is\.?$/,
    () => 'No hay nada que difuminar: todo lo marcado en esta foto es cara. Si la vas a publicar así, pruébala tal como está.',
  ],
  [/^Nothing to mask: tap the cells you want to hide first\.?$/, () => 'No hay nada que difuminar: primero toca las casillas que quieras ocultar.'],
  [
    /^Nothing would stay hidden: if you would post the photo as it is, attack it as it is\.?$/,
    () => 'No quedaría nada oculto: si vas a publicar la foto así, pruébala tal como está.',
  ],
  [/^Gemini Nano gave no answer it could read about this photo\. Scan it again\.?$/, () => 'Gemini Nano no ha dado ninguna respuesta legible sobre esta foto. Vuelve a revisarla.'],
  // The photo you pick (engine/image.ts, PhotoInputError).
  [/^That file is empty\.?$/, () => 'Ese archivo está vacío.'],
  [/^That file is (\d+) MB; photos up to (\d+) MB can be checked\.?$/, (size, max) => `Ese archivo ocupa ${size} MB; se pueden revisar fotos de hasta ${max} MB.`],
  [
    /^This browser cannot open HEIC photos\. Export it as JPEG first \(on an iPhone: Settings → Camera → Formats → Most Compatible\)\.?$/,
    () => 'Este navegador no puede abrir fotos HEIC. Expórtala antes como JPEG (en un iPhone: Ajustes → Cámara → Formatos → Más compatible).',
  ],
  [/^That is a drawing \(SVG\), not a photo\. Use a JPEG, PNG or WebP photo\.?$/, () => 'Eso es un dibujo (SVG), no una foto. Usa una foto JPEG, PNG o WebP.'],
  [/^That file is not an image\. Use a JPEG, PNG or WebP photo\.?$/, () => 'Ese archivo no es una imagen. Usa una foto JPEG, PNG o WebP.'],
  [/^That image has no pixels to check\.?$/, () => 'Esa imagen no tiene píxeles que revisar.'],
  [
    /^That image is only (\d+) × (\d+) pixels, too small to check\. Use a photo at least (\d+) pixels on each side\.?$/,
    (w, h, min) => `Esa imagen solo tiene ${w} × ${h} píxeles: es demasiado pequeña para revisarla. Usa una foto de al menos ${min} píxeles por lado.`,
  ],
  [/^That image is (\d+) megapixels; up to 100 can be checked\.?$/, (mp) => `Esa imagen tiene ${readNum(mp)} megapíxeles; se pueden revisar hasta 100.`],
  [/^That file could not be read as an image\. Use a JPEG, PNG or WebP photo\.?$/, () => 'Ese archivo no se ha podido leer como imagen. Usa una foto JPEG, PNG o WebP.'],
];

/**
 * A message from the engine, the threats or the framework in the reader's language: in Spanish when the app is, if it is
 * one of theirs. Anything else (Chrome's own words, a message already in Spanish) is shown as it is.
 */
export function translateMessage(msg: string): string {
  if (lang !== 'es') return msg;
  for (const [pattern, say] of MESSAGES_ES) {
    const m = pattern.exec(msg);
    if (m) return say(...m.slice(1));
  }
  return msg;
}

/** One of those sentences after a colon: in Spanish it goes on in lower case, unless it starts with a name (Gemini Nano). */
const afterColon = (s: string) => (/^Gemini\b/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1));

/** The DOMException name Chrome's Prompt API threw, on the error or on the error the SDK wrapped it in. */
const deviceErrorName = (e: unknown): string => {
  const own = (e as { name?: unknown } | null)?.name;
  const cause = (e as { cause?: { name?: unknown } } | null)?.cause?.name;
  return [own, cause].find((n): n is string => typeof n === 'string' && /^(QuotaExceeded|NotAllowed|NotSupported|InvalidState|Network)Error$/.test(n)) ?? '';
};

/**
 * What happened and what to do, in plain words, with a short error code a report can quote. A raw exception string is
 * never shown alone. Each cause has its own sentence: one "the cloud is overloaded" for every failure (a Gemini Nano
 * error, a blocked request, a spent quota) sent a user looking in the wrong place (17-nov).
 */
export function friendlyError(e: unknown): string {
  // Messages the app wrote for people, with what to do in them.
  if (e instanceof Error && e.name === 'UserFacingError') return translateMessage(e.message);
  if (e instanceof PrivacyViolation) {
    // Without a local model the user edits by hand; release() refuses an edit that keeps a long run of the original.
    if (e.where.includes('edited by the user'))
      return tr(
        'Your edit still keeps a long passage of your original (about 7 words in a row). Put it in other words, then try again.',
        'Tu edición aún conserva un trozo largo de tu original (unas 7 palabras seguidas). Dilo con otras palabras y vuelve a intentarlo.',
      );
    return translateMessage(e.message);
  }
  const msg = e instanceof Error ? e.message : String(e);
  const code = errorCode(e);
  const tail = code ? ` (Error ${code}.)` : '';
  // Gemini Nano, on this device: never "the cloud".
  if (e instanceof ModelTimeout && e.where === 'device')
    return tr(`${e.message} Try again; if it keeps happening, restart Chrome.`, `${translateMessage(e.message)} Vuelve a intentarlo; si sigue pasando, reinicia Chrome.`);
  if (isDeviceError(e)) {
    // Chrome's Prompt API says why in the error's name: each has its own thing to do (21-nov review).
    const why = deviceErrorName(e);
    if (why === 'QuotaExceededError')
      return tr(`This is too long for Gemini Nano on this device. Shorten it, then try again.${tail}`, `Es demasiado largo para Gemini Nano en este dispositivo. Acórtalo y vuelve a intentarlo.${tail}`);
    if (why === 'NotAllowedError')
      return tr(
        `Chrome did not let Gemini Nano start: it needs a click on this page and enough free disk space. Press the button again.${tail}`,
        `Chrome no ha dejado arrancar a Gemini Nano: necesita un clic en esta página y bastante espacio libre en el disco. Vuelve a pulsar el botón.${tail}`,
      );
    if (why === 'NotSupportedError')
      return tr(
        `Gemini Nano in this Chrome cannot read this input (its language, or an image). Update Chrome, or try a post in English.${tail}`,
        `Gemini Nano no puede leer esto en este Chrome (por el idioma, o porque es una imagen). Actualiza Chrome o prueba con un post en inglés.${tail}`,
      );
    if (why === 'InvalidStateError')
      return tr(
        `Gemini Nano is not ready yet; it may still be downloading. Wait a minute, then try again.${tail}`,
        `Gemini Nano aún no se puede usar; puede que todavía se esté descargando. Espera un minuto y vuelve a intentarlo.${tail}`,
      );
    if (why === 'NetworkError')
      return tr(`Gemini Nano’s download stopped. Check your connection, then try again.${tail}`, `La descarga de Gemini Nano se ha parado. Comprueba tu conexión y vuelve a intentarlo.${tail}`);
    // The SDK's word for "Chrome says this model cannot run here" (for a photo: it may read text but not images).
    if (code === 'api-not-enabled')
      return tr(
        `Gemini Nano cannot do this step in this Chrome. Turn on “Try it without Gemini Nano” in the menu to go on without it.${tail}`,
        `Gemini Nano no puede hacer este paso en este Chrome. Activa «Probar sin Gemini Nano» en el menú para seguir sin él.${tail}`,
      );
    return tr(
      `Gemini Nano could not finish this step on your device: ${short(msg)}. Try again; if it keeps happening, restart Chrome.${tail}`,
      `Gemini Nano no ha podido terminar este paso en tu dispositivo: ${short(translateMessage(msg))}. Vuelve a intentarlo; si sigue pasando, reinicia Chrome.${tail}`,
    );
  }
  if (isBlocked(e))
    return tr(
      `Google’s AI would not read this version: its safety filter stopped it, and the backup model’s too. Put the harshest words more mildly, then try again.${tail}`,
      `La IA de Google no ha querido leer esta versión: la ha parado su filtro de seguridad, y también el del modelo de reserva. Suaviza las palabras más duras y vuelve a intentarlo.${tail}`,
    );
  if (/app ?check|\b40[13]\b|permission_denied/i.test(msg))
    return tr(
      `This browser could not prove it is the real app (App Check). If you use an ad or tracker blocker, allow reCAPTCHA on this site, then reload the page.${tail}`,
      `Este navegador no ha podido demostrar que es la app de verdad (App Check). Si usas un bloqueador de anuncios o rastreadores, permite reCAPTCHA en este sitio y vuelve a cargar la página.${tail}`,
    );
  switch (cloudTrouble(e)) {
    case 'quota':
      return tr(
        `The free plan’s limit on requests to Google’s AI is reached for now, for the backup model too. Wait a minute and try again; if it keeps happening, today’s limit is spent.${tail}`,
        `Por ahora se ha llegado al límite de peticiones del plan gratuito a la IA de Google, también en el modelo de reserva. Espera un minuto y vuelve a intentarlo; si sigue pasando, se ha agotado el límite de hoy.${tail}`,
      );
    case 'network':
      return tr(
        `This browser could not reach Google’s AI servers. Check your connection, or allow this site in your ad or tracker blocker, then try again.${tail}`,
        `Este navegador no ha podido conectar con los servidores de la IA de Google. Comprueba tu conexión, o permite este sitio en tu bloqueador de anuncios o rastreadores, y vuelve a intentarlo.${tail}`,
      );
    case 'timeout':
      return tr(
        `Google’s AI took too long to answer, and so did the backup model. Nothing was lost: wait a minute and try again.${tail}`,
        `La IA de Google ha tardado demasiado en responder, y el modelo de reserva también. No se ha perdido nada: espera un minuto y vuelve a intentarlo.${tail}`,
      );
    case 'overloaded':
      // The main model and its backup were both busy for the whole time budget: Google's side, not the user's.
      return tr(
        `Google’s AI is overloaded right now, the backup model too. Nothing was lost: wait a minute and try again.${tail}`,
        `La IA de Google está saturada ahora mismo, y el modelo de reserva también. No se ha perdido nada: espera un minuto y vuelve a intentarlo.${tail}`,
      );
  }
  // Errors the core writes for people (an empty or too long post, nothing to mask) already say what to do.
  if (/^(Nothing to mask|There is nothing to rewrite|This post is too long)/.test(msg)) return translateMessage(msg).replace(/\.?$/, '.');
  const es = translateMessage(msg);
  return tr(`That didn't work: ${msg.replace(/\.$/, '')}. Try again.`, `No ha funcionado: ${(es === msg ? msg : afterColon(es)).replace(/\.$/, '')}. Vuelve a intentarlo.`);
}

/**
 * An error in plain words, with the paper ball in the bin: the attempt was thrown away, the page is fine. A message of the
 * engine's shown as it is (a photo Throwaway cannot open) is put in the reader's language here.
 */
export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="banner error span" role="alert">
      <img src="/illus/papelera-200.webp" width="56" height="56" alt="" />
      <p>{translateMessage(message)}</p>
    </div>
  );
}

/**
 * The risk before, measured on the device without sending anything, next to what the cloud test found in the version you
 * would post (22-nov: the original is no longer sent to show the risk).
 */
export function BeforeAfter({ before, now, good }: { before: ReactNode; now: ReactNode; good: boolean }) {
  return (
    <dl className="before-after">
      <div className="ba before">
        <dt>{tr('Before, on this device', 'Antes, en este dispositivo')}</dt>
        <dd>{before}</dd>
      </div>
      <div className={`ba now ${good ? 'good' : 'bad'}`}>
        <dt>{tr('Now, in the cloud', 'Ahora, en la nube')}</dt>
        <dd>{now}</dd>
      </div>
    </dl>
  );
}

export interface LabProps {
  kit: Kit;
  /** The local backend, to prepare Gemini Nano from a user gesture when live (for images too, if asked); reports download progress (0–1). */
  localBackend: { prepare?: (onProgress?: (p: number) => void, o?: { image?: boolean }) => Promise<void> };
  /** The dock fixed at the bottom of the screen, owned by the shell: each lab renders its actions there. */
  dock: HTMLElement | null;
  /** No local model: the lab must not run local inference and must not fall back to the cloud with private data. */
  degraded: boolean;
  /** The shell's "Try to leak" button calls the function the active lab registers here. */
  registerLeak: (fn: (() => Promise<string>) | null) => void;
  /** Recorded run (?demo): the model answers were recorded for the sample post and photo, so your own input is not offered there. */
  recorded: boolean;
  /** The user's own texts, kept by the shell across "Start over", the Gemini Nano switch and a change of tab: in memory only. */
  kept?: KeptTexts | null;
  keep?: (texts: KeptTexts) => void;
  /** Start over with the texts kept and the box for your own public writing open. */
  addWriting?: () => void;
  /** Told whether the lab is past its first step or working: the shell asks Chrome about Gemini Nano again only before. */
  onStarted?: (started: boolean) => void;
}

export interface KeptTexts {
  draft: string;
  ownPublic: string;
  /** Open the box for your own public writing when the lab mounts (set by addWriting). */
  openOwn?: boolean;
}


export const formatKm = (km: number) => (km < 1 ? `${Math.round(km * 1000)} m` : `${num(Math.round(km))} km`);
