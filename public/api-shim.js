// DAA Pay — connects the app to the server. It exposes the same small interface the app was
// built against (db / assets / downloads / mail) so the screens stay unchanged, and keeps a local
// copy of everything this person may see, refreshed every few seconds.
(function () {
  'use strict';
  var cache = {}, listeners = [], since = 0, timer = null, running = false, onSignedOut = null;

  async function call(method, path, body, headers) {
    var r = await fetch(path, {
      method: method, credentials: 'same-origin',
      headers: Object.assign(body instanceof Blob || body instanceof ArrayBuffer ? {} : { 'content-type': 'application/json' }, headers || {}),
      body: body == null ? undefined : (body instanceof Blob || body instanceof ArrayBuffer ? body : JSON.stringify(body))
    });
    var data = null; try { data = await r.json(); } catch (e) {}
    if (r.status === 401 && path !== '/api/login' && path.indexOf('/api/login/') !== 0) { stop(); if (onSignedOut) onSignedOut(); }
    if (!r.ok) { var err = new Error((data && data.error) || 'The server answered ' + r.status + '.'); err.code = r.status === 403 ? 'forbidden' : r.status === 401 ? 'signed_out' : 'server'; err.status = r.status; throw err; }
    return data || {};
  }

  // ---------- local copy + live updates
  function snapshotOf(col, q) {
    var rows = Object.keys(cache[col] || {}).map(function (id) { var d = cache[col][id]; return { id: id, exists: true, data: function () { return d; }, metadata: {} }; });
    if (q && q.order) rows.sort(function (a, b) { var A = a.data()[q.order[0]] || 0, B = b.data()[q.order[0]] || 0; return (A < B ? -1 : A > B ? 1 : 0) * (q.order[1] === 'desc' ? -1 : 1); });
    if (q && q.lim) rows = rows.slice(0, q.lim);
    return { docs: rows, size: rows.length, empty: !rows.length, docChanges: function () { return []; }, metadata: { fromCache: false, hasPendingWrites: false } };
  }
  function emit(col) { listeners.forEach(function (l) { if (l.col === col && l.ready) l.fn(snapshotOf(col, l.q)); }); }
  async function pull() {
    var r = await call('GET', '/api/sync?since=' + since);
    since = r.now;
    var touched = {};
    Object.keys(r.changes || {}).forEach(function (col) {
      cache[col] = cache[col] || {};
      r.changes[col].forEach(function (c) { if (c.deleted) delete cache[col][c.id]; else cache[col][c.id] = c.data; touched[col] = true; });
    });
    listeners.forEach(function (l) { if (!l.ready || touched[l.col]) { l.ready = true; l.fn(snapshotOf(l.col, l.q)); } });
    if (r.me && window.daa.onMe) window.daa.onMe(r.me);
  }
  function loop() {
    if (!running) return;
    pull().catch(function (e) { if (e.code !== 'signed_out') console.warn('DAA Pay sync:', e.message); })
      .then(function () { if (running) timer = setTimeout(loop, document.hidden ? 20000 : 4000); });
  }
  function start() { if (running) return; running = true; since = 0; cache = {}; loop(); }
  function stop() { running = false; clearTimeout(timer); }
  document.addEventListener('visibilitychange', function () { if (running && !document.hidden) { clearTimeout(timer); loop(); } });

  function query(col, q) {
    q = q || {};
    var api = {
      where: function () { return api; },
      orderBy: function (f, dir) { return query(col, Object.assign({}, q, { order: [f, dir || 'asc'] })); },
      limit: function (n) { return query(col, Object.assign({}, q, { lim: n })); },
      onSnapshot: function (fn, onErr) {
        var l = { col: col, q: q, fn: fn, onErr: onErr, ready: since > 0 && !!cache[col] };
        listeners.push(l);
        if (l.ready) setTimeout(function () { fn(snapshotOf(col, q)); }, 0);
        return function () { listeners = listeners.filter(function (x) { return x !== l; }); };
      },
      get: async function () { if (!since) await pull(); return snapshotOf(col, q); },
      doc: function (id) {
        id = id || ('d' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
        var write = async function (op, data) {
          var r = await call('POST', '/api/doc', { col: col, id: id, op: op, data: data });
          cache[col] = cache[col] || {};
          if (op === 'delete') delete cache[col][id]; else if (r.data) cache[col][id] = r.data;
          emit(col);
        };
        return {
          id: id, path: col + '/' + id,
          set: function (d) { return write('set', d); },
          update: function (d) { return write('update', d); },
          delete: function () { return write('delete'); },
          get: async function () { var d = (cache[col] || {})[id]; return { id: id, exists: !!d, data: function () { return d; } }; }
        };
      },
      add: async function (d) { var ref = api.doc(); await ref.set(d); return ref; }
    };
    return api;
  }

  var db = { collection: function (c) { return query(c); }, doc: function (p) { var s = p.split('/'); return query(s[0]).doc(s[1]); } };
  var assets = {
    upload: async function (file) {
      var r = await call('POST', '/api/files', file, { 'content-type': file.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name || 'file') });
      return r;
    }
  };
  var downloads = {
    save: async function (req) {
      var blob = req.data instanceof Blob ? req.data : new Blob([req.data], { type: /\.pdf$/i.test(req.filename) ? 'application/pdf' : /\.json$/i.test(req.filename) ? 'application/json' : /\.csv$/i.test(req.filename) ? 'text/csv' : 'application/octet-stream' });
      var url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = req.filename; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
      return { status: 'saved' };
    }
  };
  // The screens call "Gmail send_message"; on DAA Pay the server sends the email itself.
  var mcp = {
    callTool: async function (server, tool, input) {
      try { await call('POST', '/api/mail', input); return { payload: { ok: true } }; }
      catch (e) { var err = new Error(e.message); err.code = 'server'; throw err; }
    }
  };

  window.claude = { use: async function (name) { return { db: db, assets: assets, downloads: downloads, mcp: mcp }[name] || null; } };
  window.daa = {
    get: function (p) { return call('GET', p); },
    post: function (p, b) { return call('POST', p, b || {}); },
    start: start, stop: stop,
    onSignedOut: function (fn) { onSignedOut = fn; },
    onMe: null
  };
})();
