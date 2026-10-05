// Servidor de Horizonte en Cloudflare Workers.
//
// - Los archivos de la app (public/) los sirve Cloudflare directamente.
// - /api/push-key entrega la clave pública VAPID con la que la app se
//   suscribe a los avisos.
// - /api/save-schedule guarda la suscripción de UN dispositivo y la hora en
//   que debe avisarle.
//
// Cada dispositivo es un Durable Object ("Subscription") que guarda su
// registro y programa una alarma exacta para la hora del aviso: no hace
// falta revisar a todos cada minuto. Las claves VAPID se generan solas la
// primera vez y quedan guardadas en otro Durable Object ("Config").
import { DurableObject } from "cloudflare:workers";
import { generateVapidKeys, sendPush } from "./webpush.js";

const VAPID_SUBJECT = "mailto:noel.duran.chile@gmail.com";
const MAX_BODY_BYTES = 8 * 1024;
const TEST_DELAY_MS = 60 * 1000;
const RETRY_MS = 60 * 1000;
const GIVE_UP_MS = 10 * 60 * 1000; // un aviso de pausa más atrasado ya no sirve
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

function getVapidKeys(env) {
  return env.CONFIG.get(env.CONFIG.idFromName("vapid")).getVapidKeys();
}

export class Config extends DurableObject {
  async getVapidKeys() {
    let keys = await this.ctx.storage.get("vapid");
    if (!keys) {
      keys = await generateVapidKeys();
      await this.ctx.storage.put("vapid", keys);
    }
    return keys;
  }
}

export class Subscription extends DurableObject {
  async save(subscription, nextFireAt, fireKind, test) {
    const now = Date.now();
    const previous = (await this.ctx.storage.get("record")) || {};

    const record = {
      subscription: subscription,
      nextFireAt: nextFireAt,
      fireKind: nextFireAt ? (fireKind || "break") : null,
      // La prueba va aparte para no pisar el aviso de la pausa.
      testAt: test ? now + TEST_DELAY_MS : (previous.testAt || null),
      updatedAt: now
    };

    await this.ctx.storage.put("record", record);
    await this.schedule(record);
  }

  async schedule(record) {
    const due = [record.nextFireAt, record.testAt].filter(Boolean);
    // Sin avisos pendientes, la alarma queda para limpiar el registro si
    // la app deja de usarse.
    const at = due.length ? Math.min.apply(null, due) : record.updatedAt + STALE_MS;
    await this.ctx.storage.setAlarm(Math.max(at, Date.now()));
  }

  async alarm() {
    const record = await this.ctx.storage.get("record");
    if (!record) return;

    const now = Date.now();
    const keys = await getVapidKeys(this.env);

    if (!record.nextFireAt && !record.testAt && now - record.updatedAt >= STALE_MS) {
      await this.ctx.storage.deleteAll();
      return;
    }

    let retry = false;

    for (const kind of ["test", "break"]) {
      const field = kind === "test" ? "testAt" : "nextFireAt";
      const at = record[field];
      if (!at || at > now) continue;

      const message = kind === "test" ? MESSAGES.test : (MESSAGES[record.fireKind] || MESSAGES.break);
      let status = 0;
      try {
        status = await sendPush(record.subscription, message, keys, VAPID_SUBJECT);
      } catch (err) {
        console.error("Error enviando push:", err);
      }

      if (status === 403 || status === 404 || status === 410) {
        // Suscripción vencida, eliminada o creada con otras claves: ya no
        // sirve. La app se vuelve a suscribir sola al abrirse.
        console.error("Suscripción descartada, código", status);
        await this.ctx.storage.deleteAll();
        return;
      }

      if ((status >= 200 && status < 300) || now - at > GIVE_UP_MS) {
        if (status < 200 || status >= 300) console.error("Aviso abandonado, código", status);
        record[field] = null;
        if (kind === "break") record.fireKind = null;
      } else {
        console.error("Push falló, se reintenta. Código", status);
        retry = true;
      }
    }

    await this.ctx.storage.put("record", record);

    if (retry) {
      await this.ctx.storage.setAlarm(now + RETRY_MS);
    } else {
      await this.schedule(record);
    }
  }
}

function isValidSubscription(sub) {
  return Boolean(
    sub &&
    typeof sub.endpoint === "string" &&
    /^https:\/\//.test(sub.endpoint) &&
    sub.keys &&
    typeof sub.keys.p256dh === "string" &&
    typeof sub.keys.auth === "string"
  );
}

async function subscriptionId(env, endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return env.SUBS.idFromName(hex.slice(0, 40));
}

async function handlePushKey(env) {
  const keys = await getVapidKeys(env);
  return Response.json({ publicKey: keys.publicKey }, { headers: { "Cache-Control": "no-store" } });
}

async function handleSaveSchedule(request, env) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_BYTES) {
    return new Response("Demasiado grande", { status: 413 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody || "{}");
  } catch (e) {
    return new Response("JSON inválido", { status: 400 });
  }

  if (!isValidSubscription(payload.subscription)) {
    return new Response("Falta una suscripción válida", { status: 400 });
  }

  const nextFireAt =
    typeof payload.nextFireAt === "number" && isFinite(payload.nextFireAt)
      ? payload.nextFireAt
      : null;

  const subscription = {
    endpoint: payload.subscription.endpoint,
    keys: {
      p256dh: payload.subscription.keys.p256dh,
      auth: payload.subscription.keys.auth
    }
  };

  const stub = env.SUBS.get(await subscriptionId(env, subscription.endpoint));
  await stub.save(subscription, nextFireAt, payload.fireKind, payload.test === true);

  // Diagnóstico para «Probar aviso fuera de la app». No revela claves.
  const result = { ok: true, pushReady: false };
  try {
    const keys = await getVapidKeys(env);
    result.pushReady = Boolean(keys && keys.publicKey);
    if (typeof payload.applicationServerKey === "string") {
      result.vapidMatch = payload.applicationServerKey === keys.publicKey;
    }
  } catch (e) {
    result.keysError = (e && e.name) || "Error";
  }

  return Response.json(result);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/push-key") return handlePushKey(env);
    if (url.pathname === "/api/save-schedule") return handleSaveSchedule(request, env);

    return env.ASSETS.fetch(request);
  }
};
