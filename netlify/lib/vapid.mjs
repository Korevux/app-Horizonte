// Claves VAPID para Web Push. Si están en las variables de entorno de
// Netlify (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY) se usan esas. Si no, el
// servidor genera un par la primera vez y lo guarda en Netlify Blobs, así
// los avisos funcionan sin configurar nada a mano. La clave privada nunca
// sale del servidor; la app pide la pública a push-key.
import webpush from "web-push";
import { getStore } from "@netlify/blobs";

const KEYS_BLOB = "vapid/keys";

export async function getVapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
  }

  // Sin consistency "strong": exige uncachedEdgeURL en el entorno y, si
  // falta, cada lectura falla y los avisos nunca salen.
  const store = getStore("horizonte");
  const saved = await store.get(KEYS_BLOB, { type: "json" });
  if (saved && saved.publicKey && saved.privateKey) return saved;

  await store.setJSON(KEYS_BLOB, webpush.generateVAPIDKeys());
  // Se relee: si dos llamadas generaron a la vez, ambas usan la que quedó.
  return store.get(KEYS_BLOB, { type: "json" });
}
