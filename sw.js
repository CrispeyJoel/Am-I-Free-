const CACHE = "actually-free-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request))
  );
});

// Placeholder for future push notifications — needs a backend to
// send pushes (see README "Adding push notifications later").
self.addEventListener("push", (e) => {
  const data = e.data ? e.data.json() : { title: "Actually Free", body: "You have an update." };
  e.waitUntil(self.registration.showNotification(data.title, { body: data.body }));
});