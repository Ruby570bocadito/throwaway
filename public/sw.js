// Throwaway's service worker: makes the app installable and lets the shell (and the recorded run) open offline.
// It only ever stores this site's own static files. Calls to Firebase AI Logic, App Check and reCAPTCHA go to another origin
// and are never touched, and nothing you type or upload becomes a request, so it can never be cached.
const CACHE = 'throwaway-shell-v2';
const SHELL = ['/', '/es/', '/app/', '/manifest.webmanifest', '/brand/bola-128.webp', '/brand/icon-192.png'];
// Hashed build files never change; the brand images and illustrations are versioned by name.
const STATIC = /^\/(assets|brand|illus)\//;
const MAX_ENTRIES = 80;

/** The shell, plus the hashed scripts, styles and fonts the two pages name in their HTML (the build's own file list). */
async function precache() {
  const cache = await caches.open(CACHE);
  await cache.addAll(SHELL);
  const assets = new Set();
  for (const page of ['/', '/es/', '/app/']) {
    const html = await (await cache.match(page))?.text();
    for (const m of html?.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g) ?? []) assets.add(m[1]);
  }
  // One missing file must not cost the whole install: the page still works online.
  await Promise.allSettled([...assets].map((a) => cache.add(a)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('throwaway-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Keeps the cache small: the oldest files go first (hashed files from earlier deploys), never the shell itself. */
async function trim(cache) {
  const files = (await cache.keys()).filter((req) => !SHELL.includes(new URL(req.url).pathname));
  for (const req of files.slice(0, Math.max(0, files.length - MAX_ENTRIES))) await cache.delete(req);
}

async function put(req, res) {
  const cache = await caches.open(CACHE);
  await cache.put(req, res);
  await trim(cache);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    // Pages: the network first, so a new deploy shows at once; the stored shell only when offline.
    const page = url.pathname.startsWith('/app')
      ? '/app/'
      : url.pathname.startsWith('/es')
        ? '/es/'
        : url.pathname === '/' || url.pathname === '/index.html'
          ? '/'
          : null;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (page && res.ok) event.waitUntil(put(page, res.clone()));
          return res;
        })
        .catch(async () => (page && (await caches.match(page))) || Response.error()),
    );
    return;
  }

  if (STATIC.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) event.waitUntil(put(req, res.clone()));
            return res;
          }),
      ),
    );
  }
});
