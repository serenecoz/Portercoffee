// 카페 장부 서비스 워커: 앱 화면을 기기에 저장해 두어 빠르게 열리고, 인터넷이 끊겨도 열리게 함
const CACHE = 'jangbu-v4';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icons/icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Firebase 데이터 통신은 건드리지 않음
  if (url.hostname.endsWith('googleapis.com') && !url.hostname.startsWith('fonts')) return;
  if (url.origin === location.origin) {
    // 내 파일: 네트워크 우선(항상 최신), 실패 시 저장본
    e.respondWith(fetch(req).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return res; })
      .catch(() => caches.match(req).then(r => r || caches.match('index.html'))));
  } else if (/gstatic\.com|cdnjs\.cloudflare\.com|fonts\.googleapis\.com/.test(url.hostname)) {
    // 라이브러리·글꼴: 저장본 우선
    e.respondWith(caches.match(req).then(r => r || fetch(req).then(res => { const cp = res.clone(); caches.open(CACHE).then(c => c.put(req, cp)); return res; })));
  }
});
