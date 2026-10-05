// Función programada (corre cada minuto, ver config más abajo). Recorre los
// registros por dispositivo que guarda save-schedule.mjs ("sub/<hash>") y
// avisa SOLO a los dispositivos cuya hora (nextFireAt) ya se cumplió. El
// push lo entrega el sistema operativo, así que llega aunque la app esté
// cerrada.
//
// Formato moderno de Netlify Functions (ver save-schedule.mjs): con el
// formato antiguo Netlify Blobs no quedaba conectado y esta función
// fallaba en cada ejecución sin enviar nada.
import webpush from "web-push";
import { getStore } from "@netlify/blobs";

export const config = { schedule: "* * * * *" };

const STORE_NAME = "horizonte";
const SUB_PREFIX = "sub/";
const LEGACY_KEY = "schedule"; // registro único de la versión anterior
const STALE_MS = 60 * 24 * 60 * 60 * 1000; // 60 días sin usar la app

const MESSAGES = {
  break: {
    title: "Horizonte",
    body: "Tu pausa comenzó. Toca para ver el ejercicio."
  },
  test: {
    title: "Horizonte · Prueba",
    body: "¡Funciona! Así te avisaré cuando llegue tu pausa.",
    tag: "horizonte-test"
  }
};

// "high": sin esto, Android puede guardar el aviso hasta que el celular
// salga del reposo (Doze) y llegar con varios minutos de atraso. TTL:
// un aviso de pausa que llega 10 minutos tarde ya no sirve.
const PUSH_OPTIONS = { urgency: "high", TTL: 10 * 60 };

async function send(subscription, message) {
  await webpush.sendNotification(subscription, JSON.stringify(message), PUSH_OPTIONS);
}

export default async function () {
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  const vapidSubject = process.env.VAPID_SUBJECT || "mailto:noel.duran.chile@gmail.com";

  if (!vapidPublicKey || !vapidPrivateKey) {
    console.error("Faltan las variables de entorno VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.");
    return new Response("sin claves VAPID configuradas");
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

    if (record.testAt && now >= record.testAt) {
      try {
        await send(record.subscription, MESSAGES.test);
        sent += 1;
      } catch (err) {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) {
          await store.delete(key);
          continue;
        }
        console.error("Error enviando push de prueba:", code, err && err.body);
      }
      record.testAt = null;
      await store.setJSON(key, record);
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
      await send(record.subscription, message);
      sent += 1;
    } catch (err) {
      const code = err && err.statusCode;
      if (code === 404 || code === 410) {
        // Suscripción vencida o eliminada por el navegador: se descarta.
        await store.delete(key);
        continue;
      }
      // Otro error (red, servicio caído): se reintenta el próximo minuto.
      console.error("Error enviando push:", code, err && err.body);
      continue;
    }

    record.nextFireAt = null;
    record.fireKind = null;
    await store.setJSON(key, record);
  }

  console.log("avisos enviados: " + sent);
  return new Response("avisos enviados: " + sent);
}
