const CACHE = "store-app-v3";
const ASSETS = [
  "./",
  "index.html",
  "css/style.css",
  "js/config.js",
  "js/app.js",
  "manifest.json",
  "data/public_reference.json",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

// 정적 자산: 네트워크 우선(온라인이면 항상 서버의 최신 파일을 받아옴) - 실패하면(오프라인) 캐시로 대체.
// 예전엔 캐시 우선이었는데, 그러면 이 service-worker.js 파일 자체의 내용이 안 바뀌는 한 브라우저가
// 새 install을 아예 트리거하지 않아서, app.js/style.css를 새로 배포해도 화면에 반영이 안 되는
// 문제가 있었다 (기능을 추가해도 안 보이던 원인). 네트워크 우선으로 바꿔서 이 문제를 근본적으로 해결.
// API 호출(/api/)은 그대로 네트워크로 통과.
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.includes("/api/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
