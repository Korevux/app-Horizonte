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
    silent: false,
    vibrate: [400, 150, 400, 150, 400]
  };

  // Si la página alcanzó a mostrar el aviso de esta pausa, el push de
  // respaldo lo reemplaza sin volver a sonar (no avisa dos veces).
  event.waitUntil(
    self.registration.getNotifications({ tag: "horizonte-break" }).then(function (existing) {
      if (existing.length) {
        options.renotify = false;
        options.silent = true;
        options.body = existing[0].body || options.body;
        return self.registration.showNotification(existing[0].title || title, options);
      }
      return self.registration.showNotification(title, options);
    }).catch(function () {
      return self.registration.showNotification(title, options);
    })
  );
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
