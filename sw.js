const CACHE = "actually-free-v4";
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
  const url = new URL(e.request.url);

  if (
    e.request.method === "GET" &&
    (url.pathname.endsWith(".js") ||
     url.pathname.endsWith(".html") ||
     url.pathname === "/")
  ) {
    e.respondWith(
      fetch(e.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(e.request, copy));
          return response;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(
      (cached) => cached || fetch(e.request)
    )
  );
});

/* ==== Firebase Cloud Messaging (background notifications) ====
   Fill in the same FIREBASE_CONFIG values used at the top of app.js —
   a service worker can't import app.js's module, so it's duplicated here. */
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyD9GasWarxCefArgzbq2vPgSuYmlkTvPs0",
  authDomain: "amifree-6e5e1.firebaseapp.com",
  projectId: "amifree-6e5e1",
  storageBucket: "amifree-6e5e1.firebasestorage.app",
  messagingSenderId: "592230919079",
  appId: "1:592230919079:web:b01ed6ee1804bf59656482"
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || "Actually Free";
  const body = (payload.notification && payload.notification.body) || "";
  self.registration.showNotification(title, { body, icon: "icon-192.png" });
});