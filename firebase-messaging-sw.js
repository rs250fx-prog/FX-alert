/* global importScripts, firebase */
importScripts("https://www.gstatic.com/firebasejs/10.13.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.1/firebase-messaging-compat.js");
importScripts("./firebase-config.js");

firebase.initializeApp(firebaseConfig);
const messaging = firebase.messaging();

// Shows a notification when a push arrives while the app is not in the foreground.
messaging.onBackgroundMessage((payload) => {
  const title = payload.notification?.title || "FX Board";
  const options = {
    body: payload.notification?.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: payload.data?.pair || "fx-alert"
  };
  self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow("./index.html");
    })
  );
});

// Minimal install/activate so the app can be added to the home screen.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
