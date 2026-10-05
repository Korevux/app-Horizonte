// Entrega a la app la clave pública VAPID con la que debe suscribirse a
// los avisos push (ver netlify/lib/vapid.mjs).
import { getVapidKeys } from "../lib/vapid.mjs";

export default async function () {
  const keys = await getVapidKeys();
  return Response.json(
    { publicKey: keys.publicKey },
    { headers: { "Cache-Control": "no-store" } }
  );
}
