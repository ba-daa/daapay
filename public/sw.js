// DAA Pay service worker: lets the app open fast and show a clear message when offline.
// Data (/api) and stored files (/_blob) always come from the server and are never cached here.
var VERSION = 'daa-pay-v2';
var SHELL = ['/', '/api-shim.js', '/manifest.webmanifest', '/static/daa-logo.png', '/static/icon-192.png', '/static/IBMPlexSans-Regular.woff', '/static/IBMPlexSans-SemiBold.woff'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) { return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); })); }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/_blob/') === 0) return;
  // The page itself: always try the network first so updates arrive at once; fall back to the saved copy.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(function (r) { var c = r.clone(); caches.open(VERSION).then(function (ca) { ca.put('/', c); }); return r; })
      .catch(function () { return caches.match('/'); }));
    return;
  }
  // Libraries, icons and fonts: saved copy first (they are versioned), then the network.
  if (url.pathname.indexOf('/vendor/') === 0 || url.pathname.indexOf('/static/') === 0 || url.pathname === '/api-shim.js') {
    e.respondWith(caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (r) { if (r.ok) { var c = r.clone(); caches.open(VERSION).then(function (ca) { ca.put(req, c); }); } return r; });
      return hit || net;
    }));
  }
});
