/* Keeps the app usable offline, and adds the headers browsers require before they let the speech model use every
   CPU core (GitHub Pages can't set them). Fresh files when online, the saved copy otherwise. */
const CACHE = 'caption-studio-v2';
const isolate = res => {
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
};
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/model/part-')) return; // the worker keeps the model in its own cache
  e.respondWith(fetch(e.request).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
    return isolate(res);
  }).catch(() => caches.match(e.request).then(hit => (hit ? isolate(hit) : Response.error()))));
});
