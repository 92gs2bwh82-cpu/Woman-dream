const VERSION = 'womandream-v2';
const FICHIERS = ['/', '/index.html', '/manifest.webmanifest', '/icone-180.png', '/icone-192.png', '/icone-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(FICHIERS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(noms.filter((n) => n !== VERSION).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

/* La page : on prend la version en ligne si elle arrive en moins de 3 secondes,
   sinon (ou sans réseau) on ouvre la version gardée en mémoire. */
function pagePuisMemoire(r) {
  const memoire = caches.match('/index.html');
  const reseau = fetch(r).then((rep) => {
    if (rep && rep.ok) {
      const copie = rep.clone();
      caches.open(VERSION).then((c) => c.put('/index.html', copie));
    }
    return rep;
  });
  const secours = reseau.catch(() => memoire.then((m) => m || Response.error()));
  const delai = new Promise((ok) => setTimeout(ok, 3000))
    .then(() => memoire)
    .then((m) => m || reseau);
  return Promise.race([secours, delai]);
}

self.addEventListener('fetch', (e) => {
  const r = e.request;
  const u = new URL(r.url);
  // On ne touche ni aux envois de données ni aux autres sites.
  if (r.method !== 'GET' || u.origin !== self.location.origin || u.pathname.startsWith('/api/')) return;

  if (r.mode === 'navigate' || u.pathname === '/' || u.pathname === '/index.html') {
    e.respondWith(pagePuisMemoire(r));
    return;
  }

  e.respondWith(
    caches.match(r, { ignoreSearch: true }).then((enMemoire) => {
      const reseau = fetch(r)
        .then((rep) => {
          if (rep && rep.ok) {
            const copie = rep.clone();
            caches.open(VERSION).then((c) => c.put(r, copie));
          }
          return rep;
        })
        .catch(() => enMemoire);
      return enMemoire || reseau;
    })
  );
});
