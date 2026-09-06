// const CACHE = "actually-free-v7";

// const ASSETS = [
//   "./",
//   "./index.html",
//   "./styles.css",
//   "./app.js",
//   "./manifest.json",
//   "./icon-192.png",
//   "./icon-512.png"
// ];

// self.addEventListener("install", event => {
//   event.waitUntil(
//     caches.open(CACHE).then(cache => cache.addAll(ASSETS))
//   );
//   self.skipWaiting();
// });

// self.addEventListener("activate", event => {
//   event.waitUntil(
//     caches.keys().then(keys =>
//       Promise.all(
//         keys
//           .filter(key => key !== CACHE)
//           .map(key => caches.delete(key))
//       )
//     )
//   );
//   self.clients.claim();
// });

// self.addEventListener("fetch", event => {
//   const request = event.request;
//   const url = new URL(request.url);

//   if (request.method !== "GET") return;

//   // HTML and JavaScript must always prefer the network after a deployment.
//   // The cache remains a fallback if the network is unavailable.
//   if (
//     url.pathname.endsWith(".js") ||
//     url.pathname.endsWith(".html") ||
//     url.pathname === "/"
//   ) {
//     event.respondWith(
//       fetch(request)
//         .then(response => {
//           const copy = response.clone();
//           caches.open(CACHE).then(cache => cache.put(request, copy));
//           return response;
//         })
//         .catch(() => caches.match(request))
//     );
//     return;
//   }

//   event.respondWith(
//     caches.match(request).then(cached => cached || fetch(request))
//   );
// });

// /* ============================================================
//    FIREBASE CLOUD MESSAGING
//    ============================================================ */

// importScripts(
//   "https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js"
// );

// importScripts(
//   "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js"
// );

// firebase.initializeApp({
//   apiKey: "AIzaSyD9GasWarxCefArgzbq2vPgSuYmlkTvPs0",
//   authDomain: "amifree-6e5e1.firebaseapp.com",
//   projectId: "amifree-6e5e1",
//   storageBucket: "amifree-6e5e1.firebasestorage.app",
//   messagingSenderId: "592230919079",
//   appId: "1:592230919079:web:b01ed6ee1804bf59656482"
// });

// const messaging = firebase.messaging();

// messaging.onBackgroundMessage(payload => {
//   const title = payload.data?.title || payload.notification?.title || "Actually Free";
//   const body = payload.data?.body || payload.notification?.body || "";

//   self.registration.showNotification(title, {
//     body,
//     icon: "/icon-192.png",
//     badge: "/icon-192.png"
//   });
// });

// self.addEventListener("notificationclick", event => {
//   event.notification.close();
//   event.waitUntil(
//     clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
//       if (clientList.length > 0) return clientList[0].focus();
//       return clients.openWindow("/");
//     })
//   );
// });


const CACHE = "actually-free-v9";

const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

  self.addEventListener("fetch", (e) => {
    const url = new URL(e.request.url);

    if (
      e.request.method === "GET" &&
      (
        url.pathname.endsWith(".js") ||
        url.pathname.endsWith(".html") ||
        url.pathname.endsWith(".css") ||
        url.pathname === "/"
      )
    ) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});

/* ============================================================
   FIREBASE CLOUD MESSAGING
   ============================================================ */

importScripts(
  "https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js"
);

importScripts(
  "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js"
);

firebase.initializeApp({
  apiKey: "AIzaSyD9GasWarxCefArgzbq2vPgSuYmlkTvPs0",
  authDomain: "amifree-6e5e1.firebaseapp.com",
  projectId: "amifree-6e5e1",
  storageBucket: "amifree-6e5e1.firebasestorage.app",
  messagingSenderId: "592230919079",
  appId: "1:592230919079:web:b01ed6ee1804bf59656482"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  // If the payload has a 'notification' key, the FCM SDK / OS already displayed a banner automatically.
  // Exit here to prevent creating a duplicate notification banner.
  if (payload.notification) return;

  const title = payload.data?.title || "Actually Free";
  const body = payload.data?.body || "";

  self.registration.showNotification(title, {
    body,
    icon: "/icon-192.png",
    badge: "/icon-192.png"
  });
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then(clientList => {
      if (clientList.length > 0) return clientList[0].focus();
      return clients.openWindow("/");
    })
  );
});