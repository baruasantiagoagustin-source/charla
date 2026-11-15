// Service worker de Charla.
// Deja la interfaz (HTML, CSS, JS, íconos) disponible aunque no haya conexión.
// NO toca las llamadas a Firebase Auth/Firestore: esas siempre van directo a la red,
// así que los mensajes y las cuentas nunca se guardan en esta caché.

const CACHE = "charla-shell-v1";
const SHELL = [
  "./",
  "index.html",
  "styles.css",
  "app.js",
  "firebase-config.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Librerías de Firebase: la URL incluye la versión, así que nunca cambian. Caché primero.
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

// Archivos propios: red primero (un deploy nuevo se ve enseguida) y caché si no hay conexión.
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(request);
    if (response.ok && response.type === "basic") cache.put(request, response.clone());
    return response;
  } catch {
    const hit =
      (await cache.match(request, { ignoreSearch: true })) ||
      (request.mode === "navigate" ? await cache.match("index.html") : undefined);
    if (hit) return hit;
    return new Response("Sin conexión", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.origin === "https://www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) {
    event.respondWith(cacheFirst(request));
  } else if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(request));
  }
  // Todo lo demás (Auth, Firestore, etc.) pasa directo a la red.
});
