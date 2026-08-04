// Nome fisso: NON serve più cambiarlo ad ogni release. La freschezza dei
// contenuti è garantita dal 'cache: no-store' nelle fetch di rete qui sotto
// (bypassano la cache HTTP del browser, non solo la Cache Storage del SW).
// Questa versione va aggiornata SOLO se un giorno modifichi la logica
// di questo file (nuove strategie di cache, nuovi asset precaricati, ecc.) —
// non per i normali aggiornamenti di index.html.
const CACHE_NAME = 'youtubette-cache';

// Cache separata per le immagini (thumbnail YouTube, artwork iTunes): a
// differenza della cache dell'app shell, questa non va mai svuotata negli
// aggiornamenti di versione, cresce nel tempo e viene autolimitata (vedi
// trimArtworkCache) invece che ricreata da zero.
const ARTWORK_CACHE_NAME = 'youtubette-artwork-cache';
const MAX_ARTWORK_ENTRIES = 400; // limite soft: qualche MB, cresce piano e si autolimita

const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './192x192.png',
  './512x512.png'
];

// Domini di API dinamiche: mai in cache, sempre rete diretta, per evitare
// risultati di ricerca "vecchi". NB: ytimg.com/ggpht.com NON sono qui: sono
// CDN di sole immagini (thumbnail/avatar), gestite dal ramo cache-first
// per le immagini qui sotto, non da questa blocklist.
const NEVER_CACHE_HOSTS = [
  'googleapis.com',
  'youtube.com'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // 'reload' forza il bypass della cache HTTP del browser durante il precache
      return Promise.all(
        ASSETS.map((url) => cache.add(new Request(url, { cache: 'reload' })))
      );
    }) // Rimosso skipWaiting automatico per permettere l'aggiornamento forzato manuale da pulsante
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== ARTWORK_CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

/** Tiene la cache artwork sotto MAX_ARTWORK_ENTRIES, eliminando le voci più
 * vecchie (cache.keys() rispetta l'ordine di inserimento). Girare questo ad
 * ogni scrittura è più semplice di una vera LRU e sufficiente per un uso
 * personale: la cache non cresce mai illimitata. */
async function trimArtworkCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MAX_ARTWORK_ENTRIES;
  if (excess <= 0) return;
  for (let i = 0; i < excess; i++) {
    await cache.delete(keys[i]);
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Solo richieste GET possono essere gestite dalla cache
  if (req.method !== 'GET') return;

  // Immagini (thumbnail YouTube, artwork iTunes, avatar canale...):
  // cache-first. Controllato per PRIMA di NEVER_CACHE_HOSTS così le
  // thumbnail su ytimg.com/ggpht.com finiscono qui e non nel bypass a rete
  // diretta pensato per le vere API dinamiche. Una volta vista una canzone
  // o un video, la sua immagine resta salvata sul device: niente più flash
  // grigio né richieste di rete ripetute per contenuti già incontrati.
  if (req.destination === 'image') {
    e.respondWith(
      caches.open(ARTWORK_CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          if (res.ok) {
            cache.put(req, res.clone());
            trimArtworkCache(cache);
          }
          return res;
        } catch (err) {
          return cached || Response.error();
        }
      })
    );
    return;
  }

  // Mai intercettare le chiamate verso YouTube/Google API: sempre rete diretta,
  // niente cache, per evitare risultati di ricerca "vecchi".
  if (NEVER_CACHE_HOSTS.some((host) => url.hostname.includes(host))) {
    e.respondWith(fetch(req));
    return;
  }

  // Navigazioni (apertura app / index.html): stale-while-revalidate.
  // Risponde SUBITO con la copia già in cache (se c'è), così l'app si apre
  // senza aspettare la rete e senza il flash grigio durante l'attesa; nel
  // frattempo scarica in background la versione più recente per la prossima
  // apertura. Chi vuole la versione nuova subito usa il pulsante di
  // aggiornamento manuale (che svuota la cache e forza il reload).
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match(req).then((cached) => {
        const networkFetch = fetch(req, { cache: 'no-store' })
          .then((res) => {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
            return res;
          })
          .catch(() => cached || caches.match('./index.html'));
        return cached || networkFetch;
      })
    );
    return;
  }

  // Altri asset statici propri (manifest, ecc.): stale-while-revalidate,
  // risponde subito dalla cache ma aggiorna in background con richiesta
  // di rete "vera" (no-store), non da cache HTTP del browser.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(req).then((cached) => {
        const networkFetch = fetch(req, { cache: 'no-store' })
          .then((res) => {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, resClone));
            return res;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Tutto il resto (risorse esterne generiche): passa dritto alla rete.
  e.respondWith(fetch(req).catch(() => caches.match(req)));
});

// Ascolto del messaggio manuale inviato al click del pulsante per forzare il rimpiazzo
self.addEventListener('message', (e) => {
  if (e.data === 'skipWaiting') {
    self.skipWaiting();
  }
});
