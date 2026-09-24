// Función programada (ver netlify.toml, corre cada minuto). Revisa el
// registro guardado por save-schedule.js; si ya se cumplió la hora
// guardada (nextFireAt), manda el push real a través del servicio de
// notificaciones del navegador (funciona aunque la pestaña/app esté
// cerrada, porque lo entrega el sistema operativo).
const webpush = require("web-push");
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "horizonte";
const BLOB_KEY = "schedule";

exports.handler = async function () {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:noel.duran.chile@gmail.com";

  if (!vapidPublicKey || !vapidPrivateKey) {
    console.error("Faltan las variables de entorno VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.");
    return { statusCode: 200, body: "sin claves VAPID configuradas" };
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);

  const store = getStore(STORE_NAME);
  const record = await store.get(BLOB_KEY, { type: "json" });

  if (!record || !record.nextFireAt || !record.subscriptions || !record.subscriptions.length) {
    return { statusCode: 200, body: "nada pendiente" };
  }

  if (Date.now() < record.nextFireAt) {
    return { statusCode: 200, body: "todavía no toca" };
  }

  const payload = JSON.stringify({
    title: "Horizonte",
    body: "Tu pausa comenzó. Toca para ver el ejercicio."
  });

  const stillValid = [];

  for (const sub of record.subscriptions) {
    try {
      await webpush.sendNotification(sub, payload);
      stillValid.push(sub);
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        // Suscripción vencida/eliminada por el navegador: se descarta.
        continue;
      }
      // Otros errores: se conserva la suscripción para reintentar luego.
      console.error("Error enviando push:", err && err.message);
      stillValid.push(sub);
    }
  }

  record.subscriptions = stillValid;
  record.nextFireAt = null;
  record.fireKind = null;

  await store.setJSON(BLOB_KEY, record);

  return { statusCode: 200, body: "push enviado" };
};
