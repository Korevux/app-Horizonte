// Web Push sin dependencias, solo con WebCrypto (lo que tiene un Worker de
// Cloudflare): firma VAPID (RFC 8292) y cifrado del mensaje "aes128gcm"
// (RFC 8291 / RFC 8188). La librería web-push de npm usa APIs de Node que
// no existen en Workers.

const encoder = new TextEncoder();

export function b64urlEncode(bytes) {
  let binary = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// HKDF de un solo bloque: todas las longitudes que pide Web Push son <= 32.
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

// Par de claves VAPID nuevo: la pública en formato "raw" (base64url, la que
// usa el navegador) y la privada como JWK.
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: b64urlEncode(publicRaw), privateJwk: privateJwk };
}

async function vapidAuthorization(endpoint, keys, subject) {
  const audience = new URL(endpoint).origin;
  const header = b64urlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(encoder.encode(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject
  })));
  const unsigned = header + "." + claims;

  const key = await crypto.subtle.importKey(
    "jwk",
    keys.privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  // WebCrypto entrega la firma como r||s (64 bytes), que es justo el
  // formato que pide JWT para ES256.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(unsigned));

  return "vapid t=" + unsigned + "." + b64urlEncode(signature) + ", k=" + keys.publicKey;
}

export async function encryptPayload(subscription, payloadText) {
  const receiverPublic = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);

  const receiverKey = await crypto.subtle.importKey(
    "raw",
    receiverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );
  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const localPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, local.privateKey, 256)
  );

  const keyInfo = concat(encoder.encode("WebPush: info\0"), receiverPublic, localPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  // Un solo registro: el mensaje seguido del delimitador 0x02 ("último").
  const plaintext = concat(encoder.encode(payloadText), new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, plaintext));

  const recordSize = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, recordSize, new Uint8Array([localPublic.length]), localPublic, ciphertext);
}

// Envía un aviso. Devuelve el código HTTP del servicio push (201 = enviado).
export async function sendPush(subscription, payload, keys, subject) {
  const body = await encryptPayload(subscription, JSON.stringify(payload));
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, keys, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      // "high": sin esto, Android puede retener el aviso mientras el
      // celular está en reposo (Doze). Un aviso de pausa que llega 10
      // minutos tarde ya no sirve.
      Urgency: "high",
      TTL: "600"
    },
    body: body
  });
  return response.status;
}
