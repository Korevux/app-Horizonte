// Service worker: además de existir para que el navegador considere la
// app "instalable" (criterio de Chrome/Edge), ahora también recibe las
// notificaciones push del servidor. Esto corre aunque la pestaña/app
// esté cerrada, porque lo entrega el sistema operativo directamente al
// navegador, no la página.
self.addEventListener("fetch", function () {});

self.addEventListener("push", function (event) {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {}

  const title = data.title || "Horizonte";
  const options = {
    body: data.body || "Tu pausa comenzó.",
    tag: "horizonte-break",
    renotify: true,
    requireInteraction: true,
    vibrate: [200, 100, 200]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (clientList) {
      for (const client of clientList) {
        if ("focus" in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow("./index.html");
      }
    })
  );
});
