"""One-time port of the alpha page (claude.ai artifact) to public/index.html for DAA Pay.
Kept in the repo as a record of what changed; from now on public/index.html is edited directly."""
import sys, re
src_path, out_path = sys.argv[1], sys.argv[2]
s = open(src_path, encoding='utf-8').read()
def rep(old, new, c=1):
    global s
    n = s.count(old); assert n == c, (n, old[:100]); s = s.replace(old, new)
def cut(start, end, new):
    """replace s[start:end) located by unique markers (end marker kept)"""
    global s
    a = s.index(start); b = s.index(end, a); s = s[:a] + new + s[b:]

# ---- libraries served from our own domain
rep('<script src="https://unpkg.com/htm@3.1.1/preact/standalone.umd.js"></script>', '<script src="/vendor/htm-preact-3.1.1.umd.js"></script>')
rep('<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js"></script>', '<script src="/vendor/pdf-lib-1.17.1.min.js"></script>')
rep('<script src="https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js"></script>', '<script src="/vendor/fontkit-1.1.1.umd.min.js"></script>')
rep('<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>', '<script src="/vendor/pdf-3.11.174.min.js"></script>')
rep('<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"></script>\n', '')
rep('<script src="https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"></script>', '<script src="/vendor/jsqr-1.4.0.js"></script>')
rep('<script src="https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js"></script>', '<script src="/vendor/qrcode-generator-1.4.4.js"></script>\n<script src="/api-shim.js"></script>')
rep("lib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';", "lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker-3.11.174.min.js';")
rep("var ASSET = { logo: '/_blob/58fffbe0597a1c4fd1abdb2dfc4b67ef', fontR: '/_blob/1e47299b759b24007d71fd409c71408c', fontB: '/_blob/e0f3d35f4364579f6c7f341ec21db45e' };",
    "var ASSET = { logo: '/static/daa-logo.png', fontR: '/static/IBMPlexSans-Regular.woff', fontB: '/static/IBMPlexSans-SemiBold.woff' };")
rep("var APP_URL = 'https://claude.ai/artifact/TJwzAYVWt9ksPABKHKtwaz';", "var APP_URL = location.origin;")

# ---- names
rep('<title>DAA Payment Queue</title>', '<title>DAA Pay</title>')
rep('Payment queue <span class="alpha">Alpha</span>', 'DAA Pay <span class="alpha">Beta</span>')
rep('Sign in <span class="alpha">Alpha</span>', 'Sign in <span class="alpha">Beta</span>')
s = s.replace('<div class="muted" style="font-size: 13px">DAA Payment Queue</div>', '<div class="muted" style="font-size: 13px">DAA Pay</div>')
s = s.replace("'DAA Payment Queue:' + u.email", "'DAA Pay:' + u.email").replace("encodeURIComponent('DAA Payment Queue')", "encodeURIComponent('DAA Pay')")

# ---- session: the server decides who is signed in
rep("function has2fa(u) { return !!(u && u.totp && u.totp.on && u.totp.secret); }", "function has2fa(u) { return !!(u && u.totp && u.totp.on); }")
rep("function sessionGet() { try { return sessionStorage.getItem('daa-pq-uid'); } catch (e) { return null; } }", "function sessionGet() { return null; }")
cut("function restoreSession() {", "async function init() {", """function restoreSession() {
  if (G.me) { var u = byId(G.data.users, G.me.id); if (u) G.me = u; if (G.me && G.me.active === false) G.me = null; }
}
function onSignedIn(u) {
  G.me = u; G.memId = u.id; G.dataReady = false; G.loaded = {};
  COLS.forEach(function (c) { G.data[c] = []; });
  if (!G.subscribed) {
    G.subscribed = true;
    COLS.forEach(function (c) {
      var q = c === 'notifs' ? col(c).orderBy('ts', 'desc').limit(300) : c === 'log' ? col(c).orderBy('ts', 'desc').limit(1000) : col(c);
      q.onSnapshot(function (snap) {
        G.data[c] = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
        G.loaded[c] = true;
        if (COLS.every(function (x) { return G.loaded[x]; })) G.dataReady = true;
        restoreSession(); redraw();
      });
    });
  }
  window.daa.start();
  setUi({ tab: 'queue', open: null });
}

""")
cut("async function init() {", "// ---------- files", """async function init() {
  var r = await Promise.all([window.claude.use('db'), window.claude.use('assets'), window.claude.use('downloads'), window.claude.use('mcp')]);
  G.db = r[0]; G.assets = r[1]; G.downloads = r[2]; G.mcp = r[3];
  window.daa.onSignedOut(function () { if (G.me) { G.me = null; G.memId = null; setUi({ open: null, modal: null, profile: false, nav: false }); toast('You were signed out. Please sign in again.', true); } });
  try { var m = await window.daa.get('/api/me'); if (m.user) onSignedIn(m.user); } catch (e) { G.err = 'DAA Pay could not reach its server. Check your connection and reload the page.'; }
  G.ready = true; redraw();
}

""")
rep("  else body = html`<${Header} />", "  else if (!G.dataReady) body = html`<main class=\"auth gut\"><div class=\"muted\">Loading your payment queue…</div></main>`;\n  else body = html`<${Header} />")
rep("function signOut() { if (G.me) logEv('signin', nameOf(G.me) + ' signed out'); G.me = null;",
    "function signOut() { window.daa.post('/api/logout').catch(function () {}); window.daa.stop(); COLS.forEach(function (c) { G.data[c] = []; }); G.me = null;")

# ---- sign-in, with the 2-step code or forced setup checked on the server
cut("function Login(p) {", "function Register(p) {", r'''function Login(p) {
  var s = useState({ email: '', pass: '', err: '', busy: false, step: 'pw', setup: null, code: '' }), f = s[0], set = s[1];
  async function submit(e) {
    e.preventDefault();
    var em = f.email.trim().toLowerCase();
    if (!em || !f.pass) { set(Object.assign({}, f, { err: 'Enter your email and password.' })); return; }
    set(Object.assign({}, f, { busy: true, err: '' }));
    try {
      var r = await window.daa.post('/api/login', { email: em, pass: f.pass });
      if (r.next === 'done') onSignedIn(r.user);
      else set(Object.assign({}, f, { busy: false, err: '', pass: '', step: r.next, setup: r, code: '' }));
    } catch (ex) { set(Object.assign({}, f, { busy: false, err: ex.message })); }
  }
  async function submitCode(e) {
    e.preventDefault();
    set(Object.assign({}, f, { busy: true, err: '' }));
    try { var r = await window.daa.post(f.step === 'code' ? '/api/login/code' : '/api/login/setup', { code: f.code }); onSignedIn(r.user); }
    catch (ex) { set(Object.assign({}, f, { busy: false, err: ex.message })); }
  }
  if (f.step !== 'pw') {
    var img = f.step === 'setup' ? qrDataUrl(f.setup.uri) : '';
    return html`<main class="auth gut"><div class="card box">
      <div class="row" style="gap: 14px"><${Logo} w=${46} /><div><h1 style="font-size: 22px">Two-step sign-in</h1><div class="muted" style="font-size: 13px; word-break: break-all">${f.setup.email}</div></div></div>
      ${f.step === 'setup' && html`<div class="alert i" style="font-size: 13px">As ${ROLE[f.setup.role] || 'CEO or Super-admin'} you need two-step sign-in. Set it up once; after that you enter a code from your phone when you sign in.</div>
        <ol style="margin: 0; padding-left: 20px; font-size: 13px; display: flex; flex-direction: column; gap: 4px">
          <li>Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password or similar).</li>
          <li>Scan this code, or type the setup key by hand.</li>
          <li>Enter the 6-digit number the app shows.</li>
        </ol>
        <div class="row" style="gap: 16px; align-items: center">
          ${img && html`<img src=${img} alt="QR code for your authenticator app" width="168" height="168" style="background: #FFFFFF; padding: 6px; border-radius: 8px; border: 1px solid var(--line)" />`}
          <div style="min-width: 0; flex: 1 1 180px"><div class="muted" style="font-size: 12px">Setup key</div><div class="mono" style="font-weight: 600; word-break: break-all; user-select: all">${f.setup.secret.match(/.{1,4}/g).join(' ')}</div></div>
        </div>`}
      <form class="stack" onSubmit=${submitCode}>
        <${Field} label="6-digit code from your authenticator app"><input id="login-code" class="inp mono" inputmode="numeric" autocomplete="one-time-code" maxlength="7" value=${f.code} onInput=${inputOn(f, set, 'code')} style="letter-spacing: 0.2em; font-size: 18px" /><//>
        ${f.err && html`<div class="alert e" role="alert">${f.err}</div>`}
        <button class="btn" type="submit" disabled=${f.busy}>${f.busy ? 'Checking…' : f.step === 'setup' ? 'Turn on and sign in' : 'Continue'}</button>
        ${f.step === 'code' && html`<div class="muted" style="font-size: 12px">Lost your phone? Ask the Super-admin to reset your two-step sign-in.</div>`}
      </form>
      <button class="link" type="button" style="align-self: center" onClick=${function () { set({ email: f.email, pass: '', err: '', busy: false, step: 'pw', setup: null, code: '' }); }}>Back</button>
    </div></main>`;
  }
  return html`<main class="auth gut"><div class="card box">
    <div class="row" style="gap: 14px"><${Logo} w=${46} /><div><h1 style="font-size: 22px">Sign in <span class="alpha">Beta</span></h1><div class="muted" style="font-size: 13px">DAA Pay</div></div></div>
    <form class="stack" onSubmit=${submit}>
      <${Field} label="Email"><input id="login-email" class="inp" type="email" autocomplete="username" placeholder="name@daa.co.me" value=${f.email} onInput=${inputOn(f, set, 'email')} /><//>
      <${Field} label="Password"><input id="login-pass" class="inp" type="password" autocomplete="current-password" value=${f.pass} onInput=${inputOn(f, set, 'pass')} /><//>
      ${f.err && html`<div class="alert e" role="alert">${f.err}</div>`}
      <button class="btn" type="submit" disabled=${f.busy}>${f.busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
    <div class="row" style="justify-content: center; border-top: 1px solid var(--line-2); padding-top: 12px; font-size: 13px"><span class="muted">No account yet?</span><button class="link" type="button" onClick=${p.onRegister}>Request access</button></div>
    <button class="link" type="button" style="align-self: center; font-weight: 500; font-size: 13px" onClick=${function () { setUi({ privacy: true }); }}>Privacy & data</button>
  </div></main>`;
}
''')

# ---- request access: checked and stored by the server
cut("    var em = f.email.trim().toLowerCase(), ap = f.approver.trim().toLowerCase();", "  return html`<main class=\"auth gut\"><div class=\"card box\" style=\"max-width: 500px\">", """    set(Object.assign({}, f, { busy: true, err: '' }));
    try {
      var r = await window.daa.post('/api/register', { first: f.first, last: f.last, position: f.position, email: f.email, approver: f.approver, pass: f.pass });
      set(Object.assign({}, f, { busy: false, sent: 'Your request went to ' + r.approver + '. You get an email when it is approved.' }));
    } catch (ex) { set(Object.assign({}, f, { busy: false, err: ex.message })); }
  }
""")

# ---- turning on two-step sign-in from Profile: the server makes and checks the secret
cut("function TotpSetup(p) {", "// ================= AUTH =================", r'''function TotpSetup(p) {
  var ss = useState(null), setup = ss[0], setSetup = ss[1];
  var cs = useState(''), code = cs[0], setCode = cs[1];
  var es = useState(''), err = es[0], setErr = es[1];
  var bs = useState(false), busy = bs[0], setBusy = bs[1];
  useEffect(function () { window.daa.post('/api/totp/start').then(setSetup, function (e) { setErr(e.message); }); }, []);
  async function verify(e) {
    if (e) e.preventDefault();
    setBusy(true); setErr('');
    try { var r = await window.daa.post('/api/totp/enable', { code: code }); p.onDone(r.totp); }
    catch (ex) { setErr(ex.message); setBusy(false); }
  }
  if (!setup) return html`<div class="muted" style="font-size: 13px">${err || 'Preparing…'}</div>`;
  var img = qrDataUrl(setup.uri);
  return html`<form class="stack" style="gap: 12px" onSubmit=${verify}>
    <ol style="margin: 0; padding-left: 20px; font-size: 13px; display: flex; flex-direction: column; gap: 4px">
      <li>Open an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password or similar).</li>
      <li>Scan this code, or type the setup key by hand.</li>
      <li>Enter the 6-digit number the app shows.</li>
    </ol>
    <div class="row" style="gap: 16px; align-items: center">
      ${img && html`<img src=${img} alt="QR code for your authenticator app" width="168" height="168" style="background: #FFFFFF; padding: 6px; border-radius: 8px; border: 1px solid var(--line)" />`}
      <div style="min-width: 0; flex: 1 1 180px"><div class="muted" style="font-size: 12px">Setup key</div><div class="mono" style="font-weight: 600; word-break: break-all; user-select: all">${setup.secret.match(/.{1,4}/g).join(' ')}</div></div>
    </div>
    <${Field} label="6-digit code" req><input id="totp-setup-code" class="inp mono" inputmode="numeric" autocomplete="one-time-code" maxlength="7" value=${code} onInput=${function (e) { setCode(e.target.value); }} style="max-width: 200px; letter-spacing: 0.2em; font-size: 18px" /><//>
    ${err && html`<div class="alert e" role="alert">${err}</div>`}
    <div class="row"><button class="btn" type="submit" disabled=${busy}>${busy ? 'Checking…' : 'Turn on two-step sign-in'}</button>${p.onCancel && html`<button class="btn q" type="button" onClick=${p.onCancel}>Cancel</button>`}</div>
  </form>`;
}

''')
rep("onDone=${function () { setSetup(false); logEv('security', nameOf(me) + ' turned on two-step sign-in'); toast('Two-step sign-in is on.'); }}",
    "onDone=${function () { setSetup(false); toast('Two-step sign-in is on.'); }}")
rep("onClick=${function () { patch('users', me.id, { totp: { on: false, secret: '' } }).then(function (r) { if (r) { logEv('security', nameOf(me) + ' turned off two-step sign-in'); toast('Two-step sign-in is off.'); } }); }}",
    "onClick=${function () { window.daa.post('/api/totp/disable').then(function () { toast('Two-step sign-in is off.'); }, function (e) { toast(e.message, true); }); }}")

# ---- password change on the server
rep("""      if (!(await checkPw(me, f.cur))) { set(Object.assign({}, f, { msg: 'Your current password is wrong.', ok: false })); return; }
      p.pw = await newPw(f.p1);
    }""", """      try { await window.daa.post('/api/password', { cur: f.cur, next: f.p1 }); p.pw = true; }
      catch (ex) { set(Object.assign({}, f, { msg: ex.message, ok: false })); return; }
    }
    var pwChanged = !!p.pw; delete p.pw;""")
rep("if (await patch('users', me.id, p)) set(Object.assign({}, f, { cur: '', p1: '', p2: '', msg: p.pw ? 'Saved. Your new password works from the next sign-in.' : 'Saved.', ok: true }));",
    "if (await patch('users', me.id, p)) set(Object.assign({}, f, { cur: '', p1: '', p2: '', msg: pwChanged ? 'Saved. Your new password works from the next sign-in.' : 'Saved.', ok: true }));")

# ---- accounts and access requests on the server
cut("    if (G.data.users.some(function (u) { return (u.email || '').toLowerCase() === r.email; })) { toast('An account with ' + r.email + ' already exists.', true); return; }", "  async function create(e) {",
    """    try { await window.daa.post('/api/regs/approve', { id: r.id, role: rl }); toast(r.first + ' ' + r.last + ' can now sign in as ' + ROLE[rl] + '.'); }
    catch (ex) { toast(ex.message, true); }
  }
""")
cut("    var rl = roles.indexOf(nu.role) >= 0 ? nu.role : roles[0];\n    if (await put('users', uid('u'),", "  var matrix = [",
    """    var rl = roles.indexOf(nu.role) >= 0 ? nu.role : roles[0];
    try {
      await window.daa.post('/api/users/create', { first: nu.first, last: nu.last, position: nu.position, email: em, role: rl, managerId: nu.managerId || '', pass: nu.pass });
      toast('Account created for ' + em + '.'); setNu({ first: '', last: '', position: '', email: '', role: rl, pass: '', err: '' });
    } catch (ex) { setNu(Object.assign({}, nu, { err: ex.message })); }
  }
""")

# ---- backups through the server (they include password hashes, which normal reads never return)
rep("""      var out = { app: 'DAA Payment Queue', version: 1, exportedAt: new Date().toISOString(), exportedBy: G.me.email, collections: {} };
      for (var i = 0; i < COLS.length; i++) { var snap = await col(COLS[i]).get(); out.collections[COLS[i]] = {}; snap.docs.forEach(function (d) { out.collections[COLS[i]][d.id] = d.data(); }); }
      await saveFile('DAA-payment-queue-backup-' + todayIso() + '.json', JSON.stringify(out, null, 1));
      logEv('data', 'Downloaded a full backup');""", """      var out = await window.daa.get('/api/backup');
      await saveFile('DAA-Pay-backup-' + todayIso() + '.json', JSON.stringify(out, null, 1));""")
cut("    setBusy('rs'); var n = 0;", "  return html`<section class=\"card pad stack\" aria-label=\"Data and backups\">", """    setBusy('rs');
    try { var r = await window.daa.post('/api/import', pending.data); toast('Restored ' + r.restored + ' records.'); setPending(null); }
    catch (ex) { toast(ex.message, true); }
    setBusy('');
  }
""")
rep("Tip: download a backup every Friday until the app moves to the external server, where backups run automatically.", "The server also keeps a daily backup for 30 days.")
s = s.replace('if (!j || j.app !== \'DAA Payment Queue\' || !j.collections) throw new Error(\'This is not a DAA Payment Queue backup file.\');', 'if (!j || j.app !== \'DAA Payment Queue\' || !j.collections) throw new Error(\'This is not a DAA Pay backup file.\');')

# ---- privacy text for the hosted version
rep("""<section><b>Where it is kept during the alpha</b><p style="margin: 4px 0 0">In the claude.ai workspace of DAA's organization, available to members who have the link. The role limits are applied on screen, not by separate storage, so during the alpha please enter test or low-risk data only. On the external server the data moves to a database in the EU with access enforced on the server.</p></section>""",
    """<section><b>Where it is kept</b><p style="margin: 4px 0 0">On DAA's Cloudflare account, in a database and file storage located in Western Europe. Who can see what is checked on the server for every request. Passwords are stored only as salted hashes; sign-in sessions end after 7 days.</p></section>""")

# ---- full page shell (the artifact skeleton is gone)
head = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111111">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="DAA Pay">
<link rel="icon" type="image/png" href="/static/icon-192.png">
<link rel="apple-touch-icon" href="/static/icon-192.png">
<link rel="manifest" href="/manifest.webmanifest">
'''
s = s.replace('<meta name="claude:viewport-fit-sides" content="cover">\n', '')
title_end = s.index('</title>') + len('</title>\n')
body_start = s.index('<div id="app">')
s = head + s[:title_end] + s[title_end:body_start].replace('<style>', '<style>\n:root { padding-top: env(safe-area-inset-top, 0px); padding-bottom: env(safe-area-inset-bottom, 0px); }\nhtml, body { margin: 0; }\nimg { max-width: 100%; }\n[hidden] { display: none !important; }', 1) + '</head>\n<body>\n' + s[body_start:] + '\n</body>\n</html>\n'
open(out_path, 'w', encoding='utf-8').write(s)
print('ok', len(s))
