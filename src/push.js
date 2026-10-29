// Web Push (RFC 8030/8291/8292) for the installed DAA Pay app: VAPID keys made on first use and
// kept in the database (never synced to browsers), messages encrypted with aes128gcm.
const enc = new TextEncoder();
export const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64u = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4)), (c) => c.charCodeAt(0));
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
async function hmac(key, data) { const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)); }

export async function vapidKeys(env) {
  const row = await env.DB.prepare("SELECT data FROM docs WHERE col = 'secret' AND id = 'vapid' AND deleted = 0").first();
  if (row) return JSON.parse(row.data);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const keys = { publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
  await env.DB.prepare("INSERT OR IGNORE INTO docs (col, id, data, ts, deleted) VALUES ('secret', 'vapid', ?, ?, 0)").bind(JSON.stringify(keys), Date.now()).run();
  const again = await env.DB.prepare("SELECT data FROM docs WHERE col = 'secret' AND id = 'vapid' AND deleted = 0").first();
  return JSON.parse(again.data);
}
async function vapidAuth(keys, endpoint, subject) {
  const aud = new URL(endpoint).origin, exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const unsigned = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))) + '.' + b64u(enc.encode(JSON.stringify({ aud, exp, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', keys.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return 'vapid t=' + unsigned + '.' + b64u(sig) + ', k=' + keys.publicKey;
}
// aes128gcm content encoding (RFC 8188 + 8291), one record.
export async function encryptPayload(p256dh, authSecret, plaintext) {
  const uaPublic = unb64u(p256dh), auth = unb64u(authSecret);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, ecdh);
  const ikm = await hmac(prkKey, cat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(plaintext), new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt, 0); new DataView(head.buffer).setUint32(16, 4096); head[20] = asPublic.length;
  return cat(head, asPublic, ct);
}
// Sends one message; returns the push service status (404/410 = the device unsubscribed).
export async function sendPush(env, sub, message, subject) {
  const keys = await vapidKeys(env);
  const body = await encryptPayload(sub.p256dh, sub.auth, JSON.stringify(message));
  const r = await fetch(sub.endpoint, { method: 'POST', body, headers: { authorization: await vapidAuth(keys, sub.endpoint, subject), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', ttl: '86400', urgency: message.urgent ? 'high' : 'normal' } });
  return r.status;
}
