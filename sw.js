/* 野電計畫 WildVolt — Service Worker（PWA 離線殼）
   策略：
   - App Shell（本機檔案）用 Cache First（快取優先、背景更新），離線也能開；
   - 地圖圖磚用 Stale-While-Revalidate（先回快取、背景更新），只快取圖磚來源，
     上限 300 張、超量刪最舊，離線可看已開過區域的圖磚；
   - 外部即時 API（OSRM、Nominatim、Overpass、Open-Meteo、TDX）與 CDN 一律走網路、
     不快取，避免離線時拿到過期的里程、天氣或搜尋結果。
   快取版本號一改就整包換新（activate 時清掉舊版）。 */
const CACHE = "wildvolt-v6";
const TILE_CACHE = "wildvolt-tiles-v5";
const TILE_MAX_ENTRIES = 300;

// 圖磚來源（js/app.js initMap 實際在用的兩個底圖；另含 OSM 官方 host 以備未來切換）
//  - https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png（街道圖，{s} 為 a/b/c 子網域）
//  - https://server.arcgisonline.com/.../MapServer/tile/{z}/{y}/{x}（地形圖，無副檔名）
const TILE_HOSTS = [
  "tile.openstreetmap.fr",
  "tile.openstreetmap.org",
  "server.arcgisonline.com",
];
// OSM 圖磚路徑：/hot/{z}/{x}/{y}.png；Esri 圖磚路徑：/.../tile/{z}/{y}/{x}（無副檔名）
const TILE_PATH_RE = /(?:\/hot\/\d+\/\d+\/\d+\.(?:png|jpg|jpeg|webp)|\/tile\/\d+\/\d+\/\d+)$/;

// 即時 API：只走網路、不快取。fetch handler 預設就是「非圖磚、非同源一律走網路」,
// 這張表是明示防呆（萬一將來某支 API 與圖磚共用 host，仍以此表優先排除）。
const LIVE_API_HOSTS = [
  "router.project-osrm.org",     // OSRM 道路里程
  "nominatim.openstreetmap.org", // Nominatim 地名搜尋
  "overpass-api.de",             // Overpass（js/app.js、js/planner.js）
  "z.overpass-api.de",           // Overpass 鏡站
  "maps.mail.ru",                // Overpass 鏡站
  "api.open-meteo.com",          // Open-Meteo 天氣（Phase 3 weather.js）
  "geocoding-api.open-meteo.com",
  "tdx.transportdata.tw",        // TDX（Phase 3，交通部運輸資料流通服務）
  "api.tdx.transportdata.tw",
];

const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/styles.css",
  "./js/data-core.js",
  "./js/data-camp.js",
  "./js/data-hike.js",
  "./js/data-peaks.js",
  "./js/data-food.js",
  "./js/data-partner.js",
  "./js/data-highway.js",
  "./js/data-chargers-lux.js",
  "./js/data-chargers.js",
  "./js/engine.js",
  "./js/app.js",
  "./js/planner.js",
  "./js/live-status.js",
  "./js/trails.js",
  "./js/weather.js",
  "./js/overnight.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
];
// 注意：js/data-sights.js（觀光署景點 6,205 筆）是延遲載入，不放預快取清單；
// 第一次載入時走下方 fetch 處理（同源 GET 一律快取），之後離線也能從快取讀到。
// 注意：Phase 3 新檔 js/live-status.js、js/trails.js、js/weather.js、js/overnight.js
// 已於 2026-11-08 整合時補進 SHELL，CACHE 同步升到 wildvolt-v6；
// 圖磚快取 wildvolt-tiles-v5 不跟著升版（與 App Shell 版本脫鉤）。

function isTileHost(hostname) {
  return TILE_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h));
}

function isTileRequest(url) {
  return isTileHost(url.hostname) && TILE_PATH_RE.test(url.pathname);
}

function isLiveApiHost(hostname) {
  return LIVE_API_HOSTS.some((h) => hostname === h || hostname.endsWith("." + h));
}

// 圖磚上限：刪最舊的。Cache keys 依放入順序排列，
// slice(0, 超量) 取到的就是最早放進去的那一批。
function trimTileCache(cache) {
  return cache.keys().then((keys) => {
    if (keys.length <= TILE_MAX_ENTRIES) return;
    const stale = keys.slice(0, keys.length - TILE_MAX_ENTRIES);
    return Promise.all(stale.map((key) => cache.delete(key)));
  });
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE && k !== TILE_CACHE).map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  // 1) 地圖圖磚：Stale-While-Revalidate（先回快取、背景更新），上限 300 張
  if (isTileRequest(url)) {
    event.respondWith(
      caches.open(TILE_CACHE).then((cache) =>
        cache.match(event.request, { ignoreSearch: true }).then((hit) => {
          const updating = fetch(event.request).then((res) => {
            if (res.ok) {
              cache.put(event.request, res.clone()).then(() => trimTileCache(cache)).catch(() => {});
            }
            return res;
          });
          if (hit) {
            updating.catch(() => {}); // 背景更新失敗不影響已回傳的快取圖磚
            return hit;
          }
          return updating; // 無快取：等網路；離線時此請求失敗，Leaflet 顯示空白圖磚（與改版前相同）
        })
      )
    );
    return;
  }

  // 2) 即時 API：只走網路、不快取（OSRM、Nominatim、Overpass、Open-Meteo、TDX）
  if (isLiveApiHost(url.hostname)) return;

  // 3) 同源檔案（App Shell 與延遲載入的 data-sights.js）：Cache First、背景更新
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then((hit) => {
        const net = fetch(event.request).then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
          return res;
        }).catch(() => hit);
        return hit || net;
      })
    );
    return;
  }

  // 4) 其他外部資源（Leaflet CDN 等）：只走網路，失敗就直接失敗，不吃快取
});
