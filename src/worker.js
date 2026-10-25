// DAA Pay — Cloudflare Worker: API, sign-in, role rules, files, email, weekly report, backups.
// Static files (the app itself) are served from ./public by the ASSETS binding.

const COLS = ['users', 'regs', 'items', 'clients', 'projects', 'bens', 'notifs', 'log'];
const STATUS = ['To review', 'Approved', 'Approved for payment', 'Sent to payment', 'Paid', 'Denied'];
const KIND = { invoice: 'Invoice', refund: 'Refund', contract: 'Contract payment' };
const ROLE = { sa: 'Super-admin', ceo: 'CEO', am: 'Account manager', aa: 'Account assistant', om: 'Office manager' };
const SESSION_DAYS = 7;
const PBKDF2_ITER = 100000;               // Workers' Web Crypto limit for PBKDF2
const MAX_FILE = 20 * 1024 * 1024;
const FILE_TYPES = /^(application\/pdf|image\/(png|jpe?g|webp|gif|heic|heif)|text\/(plain|csv)|application\/(vnd\.openxmlformats-officedocument\.[a-z.]+|msword|vnd\.ms-excel|vnd\.oasis\.opendocument\.[a-z.]+|zip))$/;
const WEEKLY_CRON = '37 6 * * 1';         // Monday 07:37 Podgorica (winter time)

// ---------------------------------------------------------------- entry points
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return withHeaders(await api(req, env, url, ctx));
      if (url.pathname.startsWith('/_blob/')) return withHeaders(await getFile(req, env, url));
      return env.ASSETS.fetch(req);
    } catch (e) {
      if (e instanceof HttpError) return withHeaders(json({ error: e.message }, e.status));
      console.error(e && e.stack || e);
      return withHeaders(json({ error: 'Something went wrong on the server. Try again.' }, 500));
    }
  },
  async scheduled(event, env, ctx) {
    if (event.cron === WEEKLY_CRON) ctx.waitUntil(weeklyReport(env));
    else ctx.waitUntil(dailyJobs(env));
  }
};

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const json = (o, status = 200, headers = {}) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
function withHeaders(res) {
  const r = new Response(res.body, res);
  r.headers.set('x-content-type-options', 'nosniff');
  r.headers.set('referrer-policy', 'same-origin');
  r.headers.set('x-frame-options', 'DENY');
  return r;
}

// ---------------------------------------------------------------- helpers
const now = () => Date.now();
const pad = (n, w) => String(n).padStart(w, '0');
const pq = (n) => 'PQ-' + pad(n || 0, 4);
const isTop = (r) => r === 'sa' || r === 'ceo';
const needs2fa = (u) => !!u && isTop(u.role);
const nameOf = (u) => (u ? ((u.first || '') + ' ' + (u.last || '')).trim() || u.email : '—');
const fmt = (n) => { if (n == null || isNaN(n)) return '—'; const p = Number(n).toFixed(2).split('.'); return p[0].replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ',' + p[1]; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const rid = (p) => p + now().toString(36) + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
function podgoricaStamp(ms) {
  const d = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Podgorica', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ms || now()));
  const g = (t) => (d.find((x) => x.type === t) || {}).value;
  return { date: g('day') + '.' + g('month') + '.' + g('year'), time: g('hour') + ':' + g('minute'), short: g('day') + '.' + g('month') + '. ' + g('hour') + ':' + g('minute') };
}
function merge(a, b) {
  const o = Object.assign({}, a);
  for (const k of Object.keys(b)) {
    const v = b[k];
    o[k] = v && typeof v === 'object' && !Array.isArray(v) && o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) ? merge(o[k], v) : v;
  }
  return o;
}
async function body(req) { try { return await req.json(); } catch (e) { fail(400, 'The request could not be read.'); } }

// ---------------------------------------------------------------- storage
async function getDoc(env, col, id) {
  const r = await env.DB.prepare('SELECT data FROM docs WHERE col = ? AND id = ? AND deleted = 0').bind(col, id).first();
  return r ? JSON.parse(r.data) : null;
}
async function allDocs(env, col) {
  const { results } = await env.DB.prepare('SELECT id, data FROM docs WHERE col = ? AND deleted = 0').bind(col).all();
  return results.map((r) => Object.assign({ id: r.id }, JSON.parse(r.data)));
}
function putStmt(env, col, id, data, ts) {
  return env.DB.prepare('INSERT INTO docs (col, id, data, ts, deleted) VALUES (?, ?, ?, ?, 0) ON CONFLICT (col, id) DO UPDATE SET data = excluded.data, ts = excluded.ts, deleted = 0').bind(col, id, JSON.stringify(data), ts || now());
}
async function putDoc(env, col, id, data) { await putStmt(env, col, id, data).run(); }
async function delDoc(env, col, id) { await env.DB.prepare("UPDATE docs SET deleted = 1, data = '{}', ts = ? WHERE col = ? AND id = ?").bind(now(), col, id).run(); }
async function logEvent(env, by, type, text, itemId) {
  const t = now();
  await putDoc(env, 'log', rid('l'), { ts: t, time: podgoricaStamp(t).short, by, type, text, itemId: itemId || '' });
}

// ---------------------------------------------------------------- passwords (PBKDF2-SHA256) and 2-step codes (TOTP)
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
async function pbkdf2(pw, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: iter }, key, 256));
}
// Accounts carried over from the alpha were hashed with 120 000 rounds, above the Workers limit;
// those are checked with a plain HMAC loop once and re-hashed at 100 000 on success.
async function pbkdf2Slow(pw, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const salt = unhex(saltHex), block = new Uint8Array(salt.length + 4);
  block.set(salt); block.set([0, 0, 0, 1], salt.length);
  let u = new Uint8Array(await crypto.subtle.sign('HMAC', key, block)); const t = u.slice();
  for (let i = 1; i < iter; i++) { u = new Uint8Array(await crypto.subtle.sign('HMAC', key, u)); for (let j = 0; j < t.length; j++) t[j] ^= u[j]; }
  return hex(t);
}
async function hashPw(pw) { const salt = hex(crypto.getRandomValues(new Uint8Array(16))); return { salt, iter: PBKDF2_ITER, hash: await pbkdf2(pw, salt, PBKDF2_ITER) }; }
async function checkPw(user, pw) {
  if (!user || !user.pw || !pw) return false;
  const { salt, iter, hash } = user.pw;
  const got = iter <= PBKDF2_ITER ? await pbkdf2(pw, salt, iter) : await pbkdf2Slow(pw, salt, iter);
  return got === hash;
}
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(bytes) { let bits = 0, val = 0, out = ''; for (const b of bytes) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits > 0) out += B32[(val << (5 - bits)) & 31]; return out; }
function b32dec(s) { s = String(s).toUpperCase().replace(/[\s=]/g, ''); let bits = 0, val = 0; const out = []; for (const ch of s) { const k = B32.indexOf(ch); if (k < 0) continue; val = ((val << 5) | k) & 0xffff; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return new Uint8Array(out); }
async function totpAt(secret, counter) {
  const key = await crypto.subtle.importKey('raw', b32dec(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const msg = new Uint8Array(8); for (let i = 7; i >= 0; i--) { msg[i] = counter & 255; counter = Math.floor(counter / 256); }
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)), o = h[h.length - 1] & 15;
  return pad((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1000000, 6);
}
async function totpOk(secret, code) {
  code = String(code || '').replace(/\s/g, '');
  if (!secret || !/^\d{6}$/.test(code)) return false;
  const t = Math.floor(now() / 30000);
  for (let d = -1; d <= 1; d++) if ((await totpAt(secret, t + d)) === code) return true;
  return false;
}
const newSecret = () => b32enc(crypto.getRandomValues(new Uint8Array(20)));
const totpUri = (u, s) => 'otpauth://totp/' + encodeURIComponent('DAA Pay:' + u.email) + '?secret=' + s + '&issuer=' + encodeURIComponent('DAA Pay') + '&algorithm=SHA1&digits=6&period=30';

// ---------------------------------------------------------------- sessions and attempt limits
function cookie(req, name) { const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')); return m ? m[1] : null; }
const sessionCookie = (token, maxAge) => `daa_s=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
async function newSession(env, userId, stage, pending) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const exp = now() + (stage === 'full' ? SESSION_DAYS * 864e5 : 15 * 60e3);
  await env.DB.prepare('INSERT INTO sessions (token, user_id, stage, pending, created, expires) VALUES (?, ?, ?, ?, ?, ?)').bind(token, userId, stage, pending || null, now(), exp).run();
  return { token, maxAge: Math.round((exp - now()) / 1000) };
}
async function readSession(req, env) {
  const t = cookie(req, 'daa_s'); if (!t || !/^[0-9a-f]{64}$/.test(t)) return null;
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(t).first();
  if (!s || s.expires < now()) return null;
  const user = await getDoc(env, 'users', s.user_id);
  if (!user || user.active === false) return null;
  return { ...s, user: Object.assign({ id: s.user_id }, user) };
}
async function requireUser(req, env) {
  const s = await readSession(req, env);
  if (!s || s.stage !== 'full') fail(401, 'Please sign in again.');
  return s;
}
async function limit(env, key, max, windowMs) {
  const r = await env.DB.prepare('SELECT n, reset FROM attempts WHERE k = ?').bind(key).first();
  if (r && r.reset > now() && r.n >= max) fail(429, 'Too many attempts. Wait 15 minutes and try again.');
  if (!r || r.reset <= now()) await env.DB.prepare('INSERT INTO attempts (k, n, reset) VALUES (?, 1, ?) ON CONFLICT (k) DO UPDATE SET n = 1, reset = excluded.reset').bind(key, now() + windowMs).run();
  else await env.DB.prepare('UPDATE attempts SET n = n + 1 WHERE k = ?').bind(key).run();
}

// ---------------------------------------------------------------- what each person may see
function publicUser(u) {
  const o = Object.assign({}, u); delete o.pw;
  o.totp = u.totp && u.totp.on ? { on: true, at: u.totp.at || '' } : { on: false };
  return o;
}
function itemVisible(me, x, usersById) {
  if (isTop(me.role) || me.role === 'om') return true;
  if (x.by === me.id) return true;
  if (me.role === 'am') { const a = usersById[x.by]; return !!a && a.role === 'aa' && (!a.managerId || a.managerId === me.id); }
  return false;
}
function notifVisible(me, n) {
  if (n.to === me.id || n.to === 'role:' + me.role) return true;
  if (n.to === 'role:review') return isTop(me.role) && n.from !== me.id;
  return false;
}

// ---------------------------------------------------------------- API router
async function api(req, env, url, ctx) {
  const p = url.pathname, m = req.method;
  if (m !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) fail(403, 'Requests from other sites are not allowed.');
  }
  if (p === '/api/login' && m === 'POST') return login(req, env);
  if (p === '/api/login/code' && m === 'POST') return loginCode(req, env);
  if (p === '/api/login/setup' && m === 'POST') return loginSetup(req, env);
  if (p === '/api/register' && m === 'POST') return register(req, env);
  if (p === '/api/logout' && m === 'POST') {
    const cur = await readSession(req, env);
    if (cur) { if (cur.stage === 'full') await logEvent(env, cur.user_id, 'signin', nameOf(cur.user) + ' signed out'); await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(cur.token).run(); }
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }
  if (p === '/api/me' && m === 'GET') {
    const s = await readSession(req, env);
    if (s && s.stage === 'full') return json({ user: publicUser(s.user) });
    return json({ user: null, setup: await noUsersYet(env) });
  }
  if (p === '/api/setup' && m === 'POST') return firstAdmin(req, env);
  if (p === '/api/setup/import' && m === 'POST') return firstImport(req, env);

  const s = await requireUser(req, env), me = s.user;
  if (p === '/api/sync' && m === 'GET') return sync(env, me, Number(url.searchParams.get('since') || 0));
  if (p === '/api/doc' && m === 'POST') return writeDoc(env, me, await body(req));
  if (p === '/api/files' && m === 'POST') return upload(req, env, me);
  if (p === '/api/mail' && m === 'POST') return sendMailApi(env, me, await body(req));
  if (p === '/api/password' && m === 'POST') return changePassword(env, me, await body(req));
  if (p === '/api/totp/start' && m === 'POST') return totpStart(env, s);
  if (p === '/api/totp/enable' && m === 'POST') return totpEnable(env, s, await body(req));
  if (p === '/api/totp/disable' && m === 'POST') return totpDisable(env, me);
  if (p === '/api/users/create' && m === 'POST') return createUser(env, me, await body(req));
  if (p === '/api/regs/approve' && m === 'POST') return approveReg(env, me, await body(req));
  if (p === '/api/backup' && m === 'GET') return backupApi(env, me);
  if (p === '/api/import' && m === 'POST') return importApi(env, me, await body(req));
  fail(404, 'Unknown address.');
}

// ---------------------------------------------------------------- first run: only while the database has no users
async function noUsersYet(env) { const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM docs WHERE col = 'users' AND deleted = 0").first(); return !r || r.n === 0; }
async function firstAdmin(req, env) {
  if (!(await noUsersYet(env))) fail(403, 'DAA Pay is already set up. Sign in instead.');
  const b = await body(req), t = (k) => String(b[k] || '').trim(), email = t('email').toLowerCase();
  if (!t('first') || !t('last')) fail(400, 'Add your first and last name.');
  if (!/@daa\.co\.me$/.test(email)) fail(400, 'Use your @daa.co.me email address.');
  if (String(b.pass || '').length < 10) fail(400, 'Choose a password of at least 10 characters.');
  const id = rid('u');
  await putDoc(env, 'users', id, { first: t('first'), last: t('last'), position: 'Super-admin', email, role: 'sa', pw: await hashPw(String(b.pass)), active: true, createdAt: podgoricaStamp().short, createdBy: 'setup' });
  await logEvent(env, id, 'users', 'Created the first Super-admin account (' + email + ')');
  return json({ ok: true });
}
async function firstImport(req, env) {
  if (!(await noUsersYet(env))) fail(403, 'DAA Pay is already set up. Sign in instead.');
  const b = await body(req);
  if (!b || b.app !== 'DAA Payment Queue' || !b.collections || !Object.keys(b.collections.users || {}).length) fail(400, 'This is not a DAA Pay backup file with user accounts.');
  if (!Object.values(b.collections.users).some((u) => u && isTop(u.role) && u.pw)) fail(400, 'The backup has no CEO or Super-admin account to sign in with.');
  let n = 0; const stmts = [];
  for (const c of COLS) for (const [id, d] of Object.entries(b.collections[c] || {})) {
    if (!/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id) || !d || typeof d !== 'object') continue;
    stmts.push(putStmt(env, c, id, d)); n++;
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return json({ ok: true, restored: n });
}

// ---------------------------------------------------------------- sign-in
async function login(req, env) {
  const b = await body(req), email = String(b.email || '').trim().toLowerCase();
  const ip = req.headers.get('cf-connecting-ip') || 'x';
  await limit(env, 'login:' + ip + ':' + email, 8, 15 * 60e3);
  const users = await allDocs(env, 'users');
  const u = users.find((x) => (x.email || '').toLowerCase() === email && x.active !== false);
  if (!u || !(await checkPw(u, String(b.pass || '')))) fail(401, 'Email or password is wrong. Check both and try again.');
  if (u.pw.iter > PBKDF2_ITER) { const nu = Object.assign({}, u); delete nu.id; nu.pw = await hashPw(String(b.pass)); await putDoc(env, 'users', u.id, nu); }
  if (u.totp && u.totp.on && u.totp.secret) {
    const x = await newSession(env, u.id, 'code');
    return json({ next: 'code', email: u.email }, 200, { 'set-cookie': sessionCookie(x.token, x.maxAge) });
  }
  if (needs2fa(u)) {
    const secret = newSecret(), x = await newSession(env, u.id, 'setup', secret);
    return json({ next: 'setup', email: u.email, role: u.role, secret, uri: totpUri(u, secret) }, 200, { 'set-cookie': sessionCookie(x.token, x.maxAge) });
  }
  return finishLogin(env, u);
}
async function finishLogin(env, u, oldToken) {
  if (oldToken) await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(oldToken).run();
  const x = await newSession(env, u.id, 'full');
  await logEvent(env, u.id, 'signin', nameOf(u) + ' signed in');
  return json({ next: 'done', user: publicUser(u) }, 200, { 'set-cookie': sessionCookie(x.token, x.maxAge) });
}
async function loginCode(req, env) {
  const s = await readSession(req, env); if (!s || s.stage !== 'code') fail(401, 'Your sign-in expired. Start again.');
  await limit(env, 'code:' + s.user_id, 8, 15 * 60e3);
  const b = await body(req);
  if (!(await totpOk(s.user.totp && s.user.totp.secret, b.code))) fail(401, 'That code did not match. Use the newest code from your authenticator app.');
  return finishLogin(env, s.user, s.token);
}
async function loginSetup(req, env) {
  const s = await readSession(req, env); if (!s || s.stage !== 'setup' || !s.pending) fail(401, 'Your sign-in expired. Start again.');
  const b = await body(req);
  if (!(await totpOk(s.pending, b.code))) fail(400, 'That code did not match. Wait for the next code in the app and type it again.');
  const u = Object.assign({}, s.user); delete u.id;
  u.totp = { secret: s.pending, on: true, at: podgoricaStamp().short };
  await putDoc(env, 'users', s.user_id, u);
  await logEvent(env, s.user_id, 'security', nameOf(u) + ' turned on two-step sign-in');
  return finishLogin(env, Object.assign({ id: s.user_id }, u), s.token);
}
async function register(req, env) {
  const b = await body(req);
  const ip = req.headers.get('cf-connecting-ip') || 'x';
  await limit(env, 'reg:' + ip, 5, 60 * 60e3);
  const t = (k) => String(b[k] || '').trim();
  const miss = [];
  if (!t('first')) miss.push('first name'); if (!t('last')) miss.push('last name'); if (!t('position')) miss.push('position');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t('email'))) miss.push('a valid email');
  if (String(b.pass || '').length < 8) miss.push('a password of at least 8 characters');
  if (miss.length) fail(400, 'Please add ' + miss.join(', ') + '.');
  const email = t('email').toLowerCase(), ap = t('approver').toLowerCase();
  const users = await allDocs(env, 'users');
  if (users.some((u) => (u.email || '').toLowerCase() === email)) fail(400, 'An account with this email already exists. Sign in instead.');
  if (!/@daa\.co\.me$/.test(ap)) fail(400, 'The confirming email must end with @daa.co.me.');
  const apU = users.find((u) => (u.email || '').toLowerCase() === ap && ['sa', 'ceo', 'am'].includes(u.role) && u.active !== false);
  if (!apU) fail(400, 'That address is not a CEO or account manager here. Ask them for the right one.');
  const ts = now(), nm = t('first') + ' ' + t('last');
  await putDoc(env, 'regs', rid('r'), { first: t('first'), last: t('last'), position: t('position'), email, approver: ap, approverId: apU.id, role: 'aa', pw: await hashPw(String(b.pass)), time: podgoricaStamp(ts).short, ts });
  await putDoc(env, 'notifs', rid('n'), { to: apU.id, reg: true, text: nm + ' (' + t('position') + ') requested access.', ts, time: podgoricaStamp(ts).short, readBy: {} });
  if (apU.role !== 'ceo') await putDoc(env, 'notifs', rid('n'), { to: 'role:ceo', reg: true, text: nm + ' requested access (confirm: ' + ap + ').', ts, time: podgoricaStamp(ts).short, readBy: {} });
  return json({ ok: true, approver: ap });
}

// ---------------------------------------------------------------- sync: everything this person may see, changed since a moment
async function sync(env, me, since) {
  const t0 = now();
  const { results } = await env.DB.prepare('SELECT col, id, data, deleted FROM docs WHERE ts >= ?').bind(Math.max(0, since - 2000)).all();
  const usersById = {};
  for (const u of await allDocs(env, 'users')) usersById[u.id] = u;
  const items = {};
  if (results.some((r) => r.col === 'log')) for (const x of await allDocs(env, 'items')) items[x.id] = x;
  const out = {};
  for (const c of COLS) out[c] = [];
  for (const r of results) {
    if (!out[r.col]) continue;
    if (r.deleted) { out[r.col].push({ id: r.id, deleted: true }); continue; }
    let d = JSON.parse(r.data);
    if (r.col === 'users') d = publicUser(d);
    else if (r.col === 'regs') { if (!(isTop(me.role) || me.role === 'am')) continue; d = Object.assign({}, d); delete d.pw; }
    else if (r.col === 'items') { if (!itemVisible(me, Object.assign({ id: r.id }, d), usersById)) continue; }
    else if (r.col === 'notifs') { if (!notifVisible(me, d)) continue; }
    else if (r.col === 'log') { if (!isTop(me.role) && d.by !== me.id && !(d.itemId && items[d.itemId] && itemVisible(me, Object.assign({ id: d.itemId }, items[d.itemId]), usersById))) continue; }
    out[r.col].push({ id: r.id, data: d });
  }
  return json({ now: t0, changes: out, me: publicUser(usersById[me.id] || me) });
}

// ---------------------------------------------------------------- writes, with the role rules applied on the server
const ACTION_FOR = { 1: 'approve', 2: 'approvePay', 3: 'send', 4: 'paid', 5: 'deny' };
function can(role, action, st) {
  const top = isTop(role);
  if (action === 'approve') return (top || role === 'am') && st === 0;
  if (action === 'approvePay') return top && st === 1;
  if (action === 'send') return top && st === 2;
  if (action === 'paid') return (top || role === 'om') && st === 3;
  if (action === 'deny') return (top && st <= 2) || (role === 'am' && st === 0);
  return false;
}
const acctOk = (s) => /^\d{3}-\d{13}-\d{2}$/.test(String(s || ''));

async function writeDoc(env, me, b) {
  const col = b.col, id = String(b.id || ''), op = b.op, data = b.data || {};
  if (!COLS.includes(col) || !/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id) || !['set', 'update', 'delete'].includes(op)) fail(400, 'That change is not valid.');
  if (op !== 'delete' && (typeof data !== 'object' || Array.isArray(data))) fail(400, 'That change is not valid.');
  if (JSON.stringify(data).length > 250000) fail(413, 'That record is too large.');
  const cur = await getDoc(env, col, id);
  const role = me.role, top = isTop(role);
  const deny = (msg) => fail(403, msg || 'Your role cannot make this change.');
  let next = op === 'set' ? data : op === 'update' ? (cur ? merge(cur, data) : null) : null;
  if (op === 'update' && !cur) fail(404, 'That record no longer exists.');

  if (col === 'users') {
    if (op === 'delete') deny();
    if (!cur) deny('Create accounts from Users & roles.');
    const keys = Object.keys(data);
    const selfKeys = ['first', 'last', 'position'];
    const topKeys = ['role', 'active', 'managerId', 'totp'];
    if (me.id === id && keys.every((k) => selfKeys.includes(k))) { /* own profile */ }
    else if (top && me.id !== id && keys.every((k) => topKeys.concat(selfKeys).includes(k))) {
      if (data.totp && (data.totp.on || data.totp.secret)) deny('Two-step sign-in can only be turned on by the person themselves.');
      if (data.role && !ROLE[data.role]) fail(400, 'Unknown role.');
    } else deny();
    next = merge(cur, data);
    if (data.totp) next.totp = { on: false };
  } else if (col === 'regs') {
    if (op !== 'delete' || !(top || role === 'am')) deny();
  } else if (col === 'items') {
    const usersById = {}; for (const u of await allDocs(env, 'users')) usersById[u.id] = u;
    if (op === 'delete') {
      if (!cur || !itemVisible(me, Object.assign({ id }, cur), usersById)) fail(404, 'That item no longer exists.');
      if (!(top || ((role === 'am' || cur.by === me.id) && (cur.status || 0) === 0))) deny('Only items still To review can be removed, except by the CEO.');
      await logEvent(env, me.id, 'payment', 'Removed ' + pq(cur.pqn) + ' · ' + cur.title, id);
    } else if (!cur) {
      next = Object.assign({}, data, { by: me.id, status: 0, createdBy: me.id });
      const all = await allDocs(env, 'items');
      if (!next.pqn || all.some((x) => x.pqn === next.pqn)) next.pqn = all.reduce((m, x) => Math.max(m, x.pqn || 0), 0) + 1;
    } else {
      if (!itemVisible(me, Object.assign({ id }, cur), usersById)) fail(404, 'That item no longer exists.');
      const st = cur.status || 0;
      if ('status' in data && data.status !== st) {
        const action = ACTION_FOR[data.status];
        if (!action || !can(role, action, st)) deny('Your role cannot move this item to ' + (STATUS[data.status] || 'that status') + '.');
        if (action === 'send' && cur.kind === 'invoice' && !acctOk(next.account)) deny("Add the supplier's bank account before sending to payment.");
        next['s' + data.status + 'By'] = me.id; next['s' + data.status + 'Ts'] = now();
        if (data.status === 5) next.deniedBy = me.id;
      }
      if ('by' in data && data.by !== cur.by && !top) deny('Only the CEO or Super-admin can change who added an item.');
      if ('pqn' in data && data.pqn !== cur.pqn) deny();
    }
  } else if (col === 'notifs') {
    if (op === 'delete') deny();
    if (!cur) next = Object.assign({}, data, { from: me.id, ts: now() });
    else { const ks = Object.keys(data); if (!(ks.length === 1 && ks[0] === 'readBy')) deny(); next = merge(cur, { readBy: { [me.id]: true } }); }
  } else if (col === 'log') {
    if (op !== 'set' || cur) deny();
    next = Object.assign({}, data, { by: me.id, ts: now(), time: podgoricaStamp().short });
  } else if (col === 'bens') {
    if (op === 'delete' && !top) deny('Only the CEO or Super-admin can delete beneficiaries.');
  } else if (col === 'clients' || col === 'projects') {
    if (op === 'delete' && !top) deny();
  }

  if (op === 'delete') await delDoc(env, col, id);
  else await putDoc(env, col, id, next);
  return json({ ok: true, data: next });
}

// ---------------------------------------------------------------- accounts
async function createUser(env, me, b) {
  const allowed = isTop(me.role) ? ['sa', 'ceo', 'am', 'aa', 'om'] : me.role === 'am' ? ['aa'] : [];
  if (!allowed.length) fail(403, 'Your role cannot create accounts.');
  const t = (k) => String(b[k] || '').trim();
  const email = t('email').toLowerCase(), role = allowed.includes(b.role) ? b.role : 'aa';
  if (!t('first') || !t('last') || !t('position')) fail(400, 'Add first name, last name and position.');
  if (!/@daa\.co\.me$/.test(email)) fail(400, 'Use a @daa.co.me email address.');
  if (String(b.pass || '').length < 8) fail(400, 'Set a starting password of at least 8 characters.');
  const users = await allDocs(env, 'users');
  if (users.some((u) => (u.email || '').toLowerCase() === email)) fail(400, 'An account with this email already exists.');
  const managerId = role === 'aa' ? (me.role === 'am' ? me.id : t('managerId')) : '';
  const id = rid('u');
  await putDoc(env, 'users', id, { first: t('first'), last: t('last'), position: t('position'), email, role, managerId, pw: await hashPw(String(b.pass)), active: true, createdAt: podgoricaStamp().short, createdBy: me.id });
  await logEvent(env, me.id, 'users', 'Created account ' + email + ' as ' + ROLE[role]);
  return json({ ok: true, id });
}
async function approveReg(env, me, b) {
  const allowed = isTop(me.role) ? ['sa', 'ceo', 'am', 'aa', 'om'] : me.role === 'am' ? ['aa'] : [];
  if (!allowed.length) fail(403, 'Your role cannot approve access requests.');
  const r = await getDoc(env, 'regs', String(b.id || '')); if (!r) fail(404, 'That request is gone.');
  const role = allowed.includes(b.role) ? b.role : 'aa';
  const users = await allDocs(env, 'users');
  if (users.some((u) => (u.email || '').toLowerCase() === r.email)) fail(400, 'An account with ' + r.email + ' already exists.');
  await putDoc(env, 'users', rid('u'), { first: r.first, last: r.last, position: r.position, email: r.email, role, managerId: role === 'aa' && me.role === 'am' ? me.id : '', pw: r.pw, active: true, createdAt: podgoricaStamp().short, createdBy: me.id });
  await delDoc(env, 'regs', String(b.id));
  await logEvent(env, me.id, 'users', 'Approved access for ' + r.first + ' ' + r.last + ' (' + r.email + ') as ' + ROLE[role]);
  if (env.RESEND_API_KEY) await sendMail(env, { to: [r.email], subject: 'Your DAA Pay access is approved', text: 'Hello ' + r.first + ',\n\nYour access to DAA Pay is approved. Sign in with the email and password you chose:\n' + appUrl(env) + '\n', html: '<p>Hello ' + esc(r.first) + ',</p><p>Your access to DAA Pay is approved. Sign in with the email and password you chose.</p><p><a href="' + appUrl(env) + '">Open DAA Pay</a></p>' }).catch(() => {});
  return json({ ok: true });
}
async function changePassword(env, me, b) {
  await limit(env, 'pw:' + me.id, 8, 15 * 60e3);
  if (String(b.next || '').length < 8) fail(400, 'The new password needs at least 8 characters.');
  if (!(await checkPw(me, String(b.cur || '')))) fail(400, 'Your current password is wrong.');
  const u = Object.assign({}, me); delete u.id; u.pw = await hashPw(String(b.next));
  await putDoc(env, 'users', me.id, u);
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND stage != 'full'").bind(me.id).run();
  await logEvent(env, me.id, 'security', nameOf(me) + ' changed their password');
  return json({ ok: true });
}
async function totpStart(env, s) {
  const secret = newSecret();
  await env.DB.prepare('UPDATE sessions SET pending = ? WHERE token = ?').bind(secret, s.token).run();
  return json({ secret, uri: totpUri(s.user, secret) });
}
async function totpEnable(env, s, b) {
  const row = await env.DB.prepare('SELECT pending FROM sessions WHERE token = ?').bind(s.token).first();
  if (!row || !row.pending) fail(400, 'Start the setup again.');
  if (!(await totpOk(row.pending, b.code))) fail(400, 'That code did not match. Wait for the next code in the app and type it again.');
  const u = Object.assign({}, s.user); delete u.id; u.totp = { secret: row.pending, on: true, at: podgoricaStamp().short };
  await putDoc(env, 'users', s.user_id, u);
  await env.DB.prepare('UPDATE sessions SET pending = NULL WHERE token = ?').bind(s.token).run();
  await logEvent(env, s.user_id, 'security', nameOf(u) + ' turned on two-step sign-in');
  return json({ ok: true, totp: { on: true, at: u.totp.at } });
}
async function totpDisable(env, me) {
  if (needs2fa(me)) fail(403, 'Two-step sign-in is required for your role.');
  const u = Object.assign({}, me); delete u.id; u.totp = { on: false };
  await putDoc(env, 'users', me.id, u);
  await logEvent(env, me.id, 'security', nameOf(me) + ' turned off two-step sign-in');
  return json({ ok: true });
}

// ---------------------------------------------------------------- files (R2)
async function upload(req, env, me) {
  const type = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const name = decodeURIComponent(req.headers.get('x-file-name') || 'file').slice(0, 200);
  if (!FILE_TYPES.test(type)) fail(415, name + ': this file type cannot be stored (use PDF, images, Word, Excel or text).');
  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_FILE) fail(413, name + ': file is larger than 20 MB.');
  const buf = await req.arrayBuffer();
  if (buf.byteLength > MAX_FILE) fail(413, name + ': file is larger than 20 MB.');
  const id = hex(crypto.getRandomValues(new Uint8Array(16)));
  await env.FILES.put('files/' + id, buf, { httpMetadata: { contentType: type } });
  await env.DB.prepare('INSERT INTO files (id, name, type, size, created, by) VALUES (?, ?, ?, ?, ?, ?)').bind(id, name, type, buf.byteLength, now(), me.id).run();
  return json({ id, url: '/_blob/' + id, sizeBytes: buf.byteLength, contentType: type });
}
async function getFile(req, env, url) {
  const s = await readSession(req, env); if (!s || s.stage !== 'full') return new Response('Please sign in.', { status: 401 });
  const id = url.pathname.slice('/_blob/'.length);
  if (!/^[0-9a-f]{32}$/.test(id)) return new Response('Not found', { status: 404 });
  const meta = await env.DB.prepare('SELECT name, type FROM files WHERE id = ?').bind(id).first();
  const obj = await env.FILES.get('files/' + id);
  if (!obj || !meta) return new Response('Not found', { status: 404 });
  return new Response(obj.body, { headers: { 'content-type': meta.type, 'content-disposition': 'inline; filename*=UTF-8\'\'' + encodeURIComponent(meta.name), 'cache-control': 'private, max-age=3600' } });
}

// ---------------------------------------------------------------- email (Resend)
const appUrl = (env) => env.APP_URL || 'https://daa-pay.workers.dev';
async function sendMail(env, m) {
  if (!env.RESEND_API_KEY) fail(503, 'Email is not set up yet. Add RESEND_API_KEY to the Cloudflare Worker.');
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM || 'DAA Pay <pay@daa.co.me>', to: m.to, subject: m.subject, text: m.text, html: m.html, attachments: m.attachments })
  });
  if (!r.ok) { const t = await r.text(); fail(502, 'The email service refused the message (' + r.status + '): ' + t.slice(0, 200)); }
}
async function sendMailApi(env, me, b) {
  if (!(isTop(me.role) || me.role === 'om')) fail(403, 'Your role cannot send these emails.');
  const users = await allDocs(env, 'users');
  const ok = new Set(users.filter((u) => u.active !== false).map((u) => (u.email || '').toLowerCase()));
  const to = (b.to || []).map((x) => String(x).toLowerCase());
  if (!to.length || to.some((x) => !ok.has(x))) fail(400, 'Emails can only go to people with an active DAA Pay account.');
  const attachments = (b.attachments || []).slice(0, 3).map((a) => ({ filename: String(a.filename || 'file.pdf').slice(0, 120), content: String(a.content || '') }));
  if (attachments.reduce((n, a) => n + a.content.length, 0) > 25e6) fail(413, 'The attachment is too large to email.');
  await sendMail(env, { to, subject: String(b.subject || '').slice(0, 300), text: String(b.body || ''), html: String(b.htmlBody || ''), attachments });
  return json({ ok: true });
}

// ---------------------------------------------------------------- backups
async function exportAll(env) {
  const out = { app: 'DAA Payment Queue', version: 1, exportedAt: new Date().toISOString(), collections: {} };
  for (const c of COLS) { out.collections[c] = {}; for (const d of await allDocs(env, c)) { const id = d.id; delete d.id; out.collections[c][id] = d; } }
  return out;
}
async function backupApi(env, me) {
  if (!isTop(me.role)) fail(403, 'Only the CEO or Super-admin can download backups.');
  const out = await exportAll(env); out.exportedBy = me.email;
  await logEvent(env, me.id, 'data', 'Downloaded a full backup');
  return json(out);
}
async function importApi(env, me, b) {
  if (!isTop(me.role)) fail(403, 'Only the CEO or Super-admin can restore backups.');
  if (!b || b.app !== 'DAA Payment Queue' || !b.collections) fail(400, 'This is not a DAA Pay backup file.');
  let n = 0; const stmts = [];
  for (const c of COLS) for (const [id, d] of Object.entries(b.collections[c] || {})) {
    if (!/^[A-Za-z0-9_\-.~:@+]{1,200}$/.test(id) || !d || typeof d !== 'object') continue;
    stmts.push(putStmt(env, c, id, d)); n++;
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await logEvent(env, me.id, 'data', 'Restored ' + n + ' records from a backup');
  return json({ ok: true, restored: n });
}

// ---------------------------------------------------------------- scheduled jobs
async function dailyJobs(env) {
  const day = new Date().toISOString().slice(0, 10);
  await env.FILES.put('backups/' + day + '.json', JSON.stringify(await exportAll(env)), { httpMetadata: { contentType: 'application/json' } });
  const list = await env.FILES.list({ prefix: 'backups/' });
  const old = list.objects.map((o) => o.key).sort().slice(0, -30);
  for (const k of old) await env.FILES.delete(k);
  await env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now()).run();
  await env.DB.prepare('DELETE FROM attempts WHERE reset < ?').bind(now()).run();
  const cutoff = now() - 90 * 864e5;
  const { results } = await env.DB.prepare("SELECT id, data FROM docs WHERE col = 'notifs' AND deleted = 0").all();
  for (const r of results) { const d = JSON.parse(r.data); if ((d.ts || 0) < cutoff) await delDoc(env, 'notifs', r.id); }
}
async function weeklyReport(env) {
  if (!env.RESEND_API_KEY) return;
  const users = await allDocs(env, 'users'), items = await allDocs(env, 'items'), clients = await allDocs(env, 'clients'), projects = await allDocs(env, 'projects');
  const byId = (l, id) => l.find((x) => x.id === id);
  const t = now(), week = t - 7 * 864e5, today = podgoricaStamp(t).date;
  const st = (x) => x.status || 0;
  const rowsByStatus = STATUS.map((s, i) => { const l = items.filter((x) => st(x) === i); return [s, l.length, l.reduce((a, x) => a + (x.amount || 0), 0)]; });
  const open = items.filter((x) => st(x) <= 3), toPay = open.reduce((a, x) => a + (x.amount || 0), 0);
  const moved = (i) => items.filter((x) => (i === 0 ? x.ts : x['s' + i + 'Ts']) >= week);
  const parseDue = (d) => { const m = String(d || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/); return m ? Date.UTC(+m[3], +m[2] - 1, +m[1]) : null; };
  const attention = [
    ['To review for more than 7 days', items.filter((x) => st(x) === 0 && (x.ts || t) < week)],
    ['Sent to payment, not paid yet', items.filter((x) => st(x) === 3)],
    ['Past due date, not paid', items.filter((x) => st(x) <= 3 && parseDue(x.due) && parseDue(x.due) < t)],
    ['Invoices that need details', items.filter((x) => x.kind === 'invoice' && x.amount == null && st(x) !== 5)],
    ['Payment emails that failed', items.filter((x) => x.mail && x.mail.ok === false)]
  ];
  const byClient = {};
  for (const x of open) { const k = (byId(clients, x.clientId) || {}).name || 'No client'; const p = (byId(projects, x.projectId) || {}).name || '—'; const key = k + ' · ' + p; byClient[key] = (byClient[key] || 0) + (x.amount || 0); }
  const line = (x) => pq(x.pqn) + ' · ' + x.title + ' · ' + fmt(x.amount) + ' EUR';
  const table = (head, rows) => '<table cellpadding="6" cellspacing="0" style="border-collapse:collapse;border:1px solid #111;margin:0 0 16px">' + '<tr style="background:#111;color:#fff">' + head.map((h) => '<th align="left">' + esc(h) + '</th>').join('') + '</tr>' + rows.map((r) => '<tr>' + r.map((c) => '<td style="border-top:1px solid #ddd">' + esc(c) + '</td>').join('') + '</tr>').join('') + '</table>';
  const thisWeek = [['Added', moved(0)], ['Approved', moved(1)], ['Approved for payment', moved(2)], ['Sent to payment', moved(3)], ['Paid', moved(4)], ['Denied', moved(5)]];
  const html = '<div style="font-family:Arial,Helvetica,sans-serif;color:#111;font-size:14px;line-height:1.45">' +
    '<h2 style="margin:0 0 4px">DAA Pay · weekly report</h2><p style="margin:0 0 16px;color:#555">' + today + '</p>' +
    '<p><b>Still to pay: ' + fmt(toPay) + ' EUR</b> across ' + open.length + ' items.</p>' +
    table(['Status', 'Items', 'EUR'], rowsByStatus.map((r) => [r[0], String(r[1]), fmt(r[2])])) +
    '<h3>This week</h3>' + table(['What', 'Items'], thisWeek.map((r) => [r[0], r[1].length ? r[1].map(line).join('; ') : '—'])) +
    '<h3>Needs attention</h3>' + table(['What', 'Items'], attention.map((r) => [r[0], r[1].length ? r[1].map(line).join('; ') : '—'])) +
    '<h3>Not yet paid, by client and project</h3>' + table(['Client · project', 'EUR'], Object.entries(byClient).map(([k, v]) => [k, fmt(v)])) +
    '<p><a href="' + appUrl(env) + '">Open DAA Pay</a></p></div>';
  const text = 'DAA Pay · weekly report · ' + today + '\n\nStill to pay: ' + fmt(toPay) + ' EUR across ' + open.length + ' items.\n\n' +
    rowsByStatus.map((r) => r[0] + ': ' + r[1] + ' (' + fmt(r[2]) + ' EUR)').join('\n') + '\n\nNeeds attention:\n' +
    attention.map((r) => '- ' + r[0] + ': ' + (r[1].length ? r[1].map(line).join('; ') : 'none')).join('\n') + '\n\n' + appUrl(env) + '\n';
  const to = users.filter((u) => u.active !== false && u.email).map((u) => u.email);
  if (to.length) await sendMail(env, { to, subject: 'DAA Pay · weekly report · ' + today, text, html });
}
