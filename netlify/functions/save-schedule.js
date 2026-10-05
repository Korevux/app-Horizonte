// Recibe desde index.html la suscripción push de UN dispositivo y la hora
// en que debería avisarle (nextFireAt). Cada dispositivo tiene su propio
// registro en Netlify Blobs (clave "sub/<hash del endpoint>"), así varias
// personas pueden usar la app sin pisarse los horarios entre sí.
const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "horizonte";
const SUB_PREFIX = "sub/";
const MAX_BODY_BYTES = 8 * 1024;

function keyFor(endpoint) {
  const hash = crypto.createHash("sha256").update(endpoint).digest("hex").slice(0, 40);
  return SUB_PREFIX + hash;
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

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  if ((event.body || "").length > MAX_BODY_BYTES) {
    return { statusCode: 413, body: "Demasiado grande" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: "JSON inválido" };
  }

  // Sin una suscripción válida no hay a quién avisar: cada registro
  // pertenece a un dispositivo concreto.
  if (!isValidSubscription(payload.subscription)) {
    return { statusCode: 400, body: "Falta una suscripción válida" };
  }

  const nextFireAt =
    typeof payload.nextFireAt === "number" && isFinite(payload.nextFireAt)
      ? payload.nextFireAt
      : null;

  const store = getStore(STORE_NAME);
  const key = keyFor(payload.subscription.endpoint);

  // El aviso de prueba ("Probar aviso fuera de la app") va aparte del de
  // la pausa, para no pisarlo. Se conserva si llega otra actualización
  // antes de que salga.
  let testAt = null;
  if (payload.test === true) {
    testAt = Date.now() + 60 * 1000;
  } else {
    try {
      const existing = await store.get(key, { type: "json" });
      if (existing && typeof existing.testAt === "number") testAt = existing.testAt;
    } catch (e) {}
  }

  await store.setJSON(key, {
    subscription: {
      endpoint: payload.subscription.endpoint,
      keys: {
        p256dh: payload.subscription.keys.p256dh,
        auth: payload.subscription.keys.auth
      }
    },
    nextFireAt: nextFireAt,
    fireKind: nextFireAt ? (payload.fireKind || "break") : null,
    testAt: testAt,
    updatedAt: Date.now()
  });

  // Diagnóstico para la prueba: si faltan las claves VAPID o no coinciden
  // con la de la app, los avisos nunca van a llegar. No revela claves.
  const serverPublicKey = process.env.VAPID_PUBLIC_KEY || "";
  const result = {
    ok: true,
    pushReady: Boolean(serverPublicKey && process.env.VAPID_PRIVATE_KEY)
  };
  if (typeof payload.applicationServerKey === "string" && serverPublicKey) {
    result.vapidMatch = payload.applicationServerKey === serverPublicKey;
  }

  return { statusCode: 200, body: JSON.stringify(result) };
};
