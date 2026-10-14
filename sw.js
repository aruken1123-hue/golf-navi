// Service Worker: 圏外でも動くように画面とコース・地図を端末に保存する
// VERSION は js/version.js の APP_VERSION と必ず同じにする（tests/version.test.mjs で検査）
const VERSION = '0.18.0';
const APP_CACHE = `golf-navi-app-${VERSION}`;
const TILE_CACHE = 'gsi-tiles-v1'; // 地図・標高タイル。版を上げても消さない（js/mapbase.js と同じ名前）

const APP_FILES = [
  './',
  'index.html',
  'editor.html',
  'manifest.webmanifest',
  'css/style.css',
  'js/version.js',
  'js/geo.js',
  'js/elev.js',
  'js/store.js',
  'js/mapbase.js',
  'js/pwa.js',
  'js/play.js',
  'js/autohole.js',
  'js/score.js',
  'js/shots.js',
  'js/editor.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet-rotate/leaflet-rotate.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'courses/index.json',
  'courses/ota-futaba.json',
];

self.addEventListener('install', (event) => {
  // cache: 'reload' でブラウザのHTTPキャッシュを通さずに取る（GitHub Pages は10分キャッシュするため、
  // そのままだと新しい版の保存先に古いJSが入ることがある）
  event.waitUntil(caches.open(APP_CACHE)
    .then((c) => c.addAll(APP_FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('golf-navi-app-') && key !== APP_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'version' && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
});

const NETWORK_TIMEOUT_MS = 3000; // 電波が弱いとき、これ以上は待たずに保存済みを使う

// 地図・標高タイル: 保存済みを優先（タイルはほぼ変わらない）
async function tileFirst(event) {
  const req = event.request;
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type !== 'opaque') event.waitUntil(cache.put(req.url, res.clone()));
  return res;
}

// コースデータ: 最新を優先。圏外や電波が弱い（3秒以上かかる）ときは保存済みを返し、裏で取り続ける
async function networkFirst(event) {
  const req = event.request;
  const cache = await caches.open(APP_CACHE);
  const network = fetch(req).then((res) => {
    if (res.ok) return cache.put(req, res.clone()).then(() => res);
    return res;
  });
  event.waitUntil(network.catch(() => {}));
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_TIMEOUT_MS, 'timeout'));
  try {
    const first = await Promise.race([network, timeout]);
    if (first !== 'timeout') return first;
  } catch { /* 圏外 */ }
  const hit = await cache.match(req, { ignoreSearch: true });
  return hit || network; // 保存が無ければ待ち続けるしかない
}

// 画面のファイル: 版ごとに保存したものを使う
async function cacheFirst(event) {
  const req = event.request;
  const cache = await caches.open(APP_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) event.waitUntil(cache.put(req, res.clone()));
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'cyberjapandata.gsi.go.jp' && url.pathname.startsWith('/xyz/')) {
    event.respondWith(tileFirst(event));
    return;
  }
  if (url.origin !== self.location.origin) return; // 標高APIなどは素通し
  if (url.pathname.includes('/courses/')) event.respondWith(networkFirst(event));
  else event.respondWith(cacheFirst(event));
});
