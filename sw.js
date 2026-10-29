/* 野電計畫 WildVolt — Service Worker（PWA 離線殼）
   策略：App Shell（本機檔案）用 Cache First，離線也能開；
   圖磚／OSRM／Nominatim 等外部即時資料一律走網路（不快取），
   避免離線時拿到過期的地圖或里程。快取版本號一改就整包換新。 */
const CACHE = "wildvolt-v3";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/data-core.js",
  "./js/data-camp.js",
  "./js/data-hike.js",
  "./js/data-food.js",
  "./js/data-partner.js",
  "./js/data-highway.js",
  "./js/data-chargers-lux.js",
  "./js/data-chargers.js",
  "./js/engine.js",
  "./js/app.js",
  "./js/planner.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isShell = url.origin === self.location.origin;
  if (event.request.method !== "GET") return;
  if (isShell) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then((hit) => {
        const net = fetch(event.request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
  }
  // 外部資源（圖磚、CDN、OSRM、Nominatim、Overpass）：只走網路，失敗就直接失敗，不吃快取
});
