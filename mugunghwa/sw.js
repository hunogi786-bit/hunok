// 홈 화면 앱용 서비스 워커: 이 폴더의 파일만 저장해 두고, 인터넷이 없어도 열리게 합니다.
// 다른 사이트로 가는 요청은 다루지 않습니다 (앱은 다른 사이트에 요청하지 않음).
const VERSION = 'mugunghwa-v1';
const APP = ['./', './index.html', './app.js', './style.css', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png', './icons/apple-touch-icon.png'];
const BIG = ['./vendor/mediapipe/vision_bundle.mjs', './vendor/mediapipe/wasm/vision_wasm_internal.js',
  './vendor/mediapipe/wasm/vision_wasm_internal.wasm', './vendor/mediapipe/models/pose_landmarker_lite.task'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll([...APP, ...BIG])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.includes('/vendor/')) {
    // 큰 파일: 저장해 둔 것을 먼저 씀
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); return res;
    })));
    return;
  }
  // 앱 파일: 인터넷이 되면 새 버전, 안 되면 저장해 둔 것
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || caches.match('./index.html'))));
});
