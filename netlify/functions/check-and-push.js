// Función programada (ver netlify.toml, corre cada minuto). Recorre los
// registros por dispositivo que guarda save-schedule.js ("sub/<hash>") y
// avisa SOLO a los dispositivos cuya hora (nextFireAt) ya se cumplió. El
// push lo entrega el sistema operativo, así que llega aunque la app esté
// cerrada.
const webpush = require("web-push");
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "horizonte";
const SUB_PREFIX = "sub/";
const LEGACY_KEY = "schedule"; // registro único de la versión anterior
const STALE_MS = 60 * 24 * 60 * 60 * 1000; // 60 días sin usar la app

const MESSAGES = {
  break: {
    title: "Horizonte",
    body: "Tu pausa comenzó. Toca para ver el ejercicio."
  }
};

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
  const now = Date.now();

  // El registro único de la versión anterior mezclaba a todos los
  // dispositivos. Se borra: cada uno se vuelve a registrar solo al
  // abrir la app (subscribeToPush en index.html).
  try {
    await store.delete(LEGACY_KEY);
  } catch (e) {}

  const { blobs } = await store.list({ prefix: SUB_PREFIX });
  let sent = 0;

  for (const { key } of blobs) {
    let record;
    try {
      record = await store.get(key, { type: "json" });
    } catch (e) {
      continue;
    }

    if (!record || !record.subscription) {
      await store.delete(key);
      continue;
    }

    if (!record.nextFireAt) {
      if (record.updatedAt && now - record.updatedAt > STALE_MS) {
        await store.delete(key);
      }
      continue;
    }

    if (now < record.nextFireAt) continue;

    const message = MESSAGES[record.fireKind] || MESSAGES.break;

    try {
      await webpush.sendNotification(record.subscription, JSON.stringify(message));
      sent += 1;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        // Suscripción vencida o eliminada por el navegador: se descarta.
        await store.delete(key);
        continue;
      }
      // Otro error (red, servicio caído): se reintenta el próximo minuto.
      console.error("Error enviando push:", err && err.message);
      continue;
    }

    record.nextFireAt = null;
    record.fireKind = null;
    await store.setJSON(key, record);
  }

  return { statusCode: 200, body: "avisos enviados: " + sent };
};
