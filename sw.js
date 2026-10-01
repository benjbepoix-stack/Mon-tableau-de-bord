/* Service worker : chaque ouverture de l'app vérifie auprès du serveur si les fichiers
   ont changé (requête conditionnelle, très légère) ; la dernière version reçue sert
   de secours hors ligne. Les mises à jour publiées sont ainsi visibles dès la
   réouverture, sans mélange d'anciens et de nouveaux fichiers. */
const CACHE = 'dashboard-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Firebase, météo, polices… : non concernés.
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || (e.request.mode === 'navigate' ? caches.match('./') : Response.error())))
  );
});
