/* Foldrule service worker — offline support for the installed app.
 *
 *  • Pages (navigations): network first, cached copy when offline.
 *  • Build assets (/_next/static, icons, the PDF worker): cache first —
 *    their URLs change whenever their content does.
 *  • /api/* is never cached (Excel export needs the server).
 *
 * VERSION comes from the build id in the registration URL (/sw.js?v=…), so
 * each build gets its own caches and the old ones are deleted on activate.
 */
const VERSION = `foldrule-${new URL(self.location.href).searchParams.get('v') || 'v1'}`;
const PAGES   = `${VERSION}-pages`;
const ASSETS  = `${VERSION}-assets`;
const SHELL   = ['/', '/dashboard', '/workspace', '/takeoff-full', '/presets', '/open', '/pdf.worker.min.js', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(PAGES);
    // Individually, so one failure doesn't abort the install.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

const isAsset = (url) =>
  url.pathname.startsWith('/_next/static/') ||
  url.pathname.startsWith('/icons/') ||
  url.pathname.startsWith('/brand/') ||
  url.pathname === '/pdf.worker.min.js' ||
  /\.(?:png|svg|ico|woff2?)$/.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(PAGES)).put(url.pathname, res.clone());
        return res;
      } catch {
        const cache = await caches.open(PAGES);
        return (await cache.match(url.pathname)) || (await cache.match('/dashboard')) || Response.error();
      }
    })());
    return;
  }

  if (isAsset(url)) {
    // Worker scripts need special care. The bundler passes each worker its
    // start-up config in the URL fragment (…worker.js#params=…). A Response
    // that comes from fetch() or the cache carries its own URL — WITHOUT the
    // fragment — and the browser uses that as the worker's location, so the
    // worker starts with no config, never installs its message handler, and
    // snapping / geometry / fill silently hang. Handing back a copy with no
    // URL makes the browser keep the requested URL, fragment included.
    const isWorkerScript = req.destination === 'worker' || req.destination === 'sharedworker';
    event.respondWith((async () => {
      const cache = await caches.open(ASSETS);
      let res = await cache.match(req, { ignoreSearch: false });
      if (!res) {
        res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
      }
      if (!isWorkerScript || !res.ok) return res;
      return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
    })());
  }
});
