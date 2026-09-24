// Recibe desde index.html la suscripción push del dispositivo y la hora
// en que debería avisar (nextFireAt), y las guarda en un único registro
// de Netlify Blobs. Es una app de una sola usuaria: no hay base de
// datos, solo un objeto JSON que se sobreescribe.
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "horizonte";
const BLOB_KEY = "schedule";

exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: "JSON inválido" };
  }

  const store = getStore(STORE_NAME);
  let record = (await store.get(BLOB_KEY, { type: "json" })) || {
    subscriptions: [],
    nextFireAt: null,
    fireKind: null
  };

  if (payload.clear) {
    record.nextFireAt = null;
    record.fireKind = null;
    await store.setJSON(BLOB_KEY, record);
    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  if (payload.subscription && payload.subscription.endpoint) {
    const exists = record.subscriptions.some(
      (s) => s.endpoint === payload.subscription.endpoint
    );
    if (!exists) {
      record.subscriptions.push(payload.subscription);
    }
  }

  if (typeof payload.nextFireAt !== "undefined") {
    record.nextFireAt = payload.nextFireAt;
  }
  if (typeof payload.fireKind !== "undefined") {
    record.fireKind = payload.fireKind;
  }

  await store.setJSON(BLOB_KEY, record);

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
