/* =========================================================
   野電計畫 WildVolt — 登山步道路線（Overpass 即時查詢）
   Phase 3 功能 2：爬山步道 GPX 畫進地圖，估算步行時間與補水點

   依賴（全域，載入順序見 INTEGRATION.md）：engine.js 的
   haversine／fmtKm／fmtDuration／esc；Leaflet L（只在畫圖時用）；
   app.js 的 peakAccess（只在解登山口時用，有防禦檢查）。
   本檔不改任何既有計算、不碰 engine.js／planner.js／app.js 的狀態，
   只新增全域函式與一個 session 內快取。

   來源標示規則（硬性）：每個數字都標來源，絕不編造。
   - 路線幾何：OpenStreetMap Overpass route=hiking relation／way（out geom）
   - 路線長度：由 Overpass 幾何座標累加 haversine，為「路線長度估算」
   - 爬升：資料庫值（HIKE_POIS trail.gain）；小百岳無爬升欄位時為「未知」，
     不以山頂海拔減登山口海拔推算（登山口海拔未知，推算即編造）
   - 步行時間：Naismith 規則估算（見 estimateNaismith），與資料庫值並列對照
   - 補水點：OpenStreetMap amenity=drinking_water
   - 資料庫對照值：HIKE_POIS trail／PEAK_ACCESS tr（健行筆記）
   ========================================================= */

/* Overpass 三鏡像，與 app.js searchOverpassFood 相同清單、相同順序 */
const TRAIL_ENDPOINTS = [
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const TRAIL_TIMEOUT_MS = 15000; /* 每次請求 timeout，約 15 秒 */
const TRAIL_RADIUS_M = 3000; /* 登山口／山頂周邊約 3 km */
const TRAIL_MAX_ATTEMPTS = 2; /* 每個鏡像失敗重試一次（共嘗試 2 次） */

/* session 內快取：key 為 poi id（無 id 時用 "lat,lng"），值為 Promise；
   存 Promise 可避免同一 poi 連點兩下造成重複查詢。換頁即失效，不寫 localStorage。 */
const trailCache = new Map();

function trailEsc(s) {
  if (typeof esc === "function") return esc(s);
  return String(s ?? "");
}

function trailFmtKm(n, digits) {
  if (typeof fmtKm === "function") return fmtKm(n, digits);
  return (Number(n) || 0).toFixed(digits || 0);
}

function trailFmtDuration(hours) {
  if (typeof fmtDuration === "function") return fmtDuration(hours);
  const total = Math.max(0, Math.round((Number(hours) || 0) * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return m + " 分";
  if (m === 0) return h + " 小時";
  return h + " 小時 " + m + " 分";
}

/* ---------- 查詢起點：登山口優先，否則山頂／據點座標 ---------- */

/**
 * 查詢錨點：小百岳取 PEAK_ACCESS 第一處登山口（th[0]，健行筆記整理），
 * 無登山口資料時退回山頂座標；HIKE_POIS 的 lat／lng 本身就是登山口。
 * 回傳 { lat, lng, label, source }，座標無效回傳 null。
 */
function resolveTrailAnchor(poi) {
  if (!poi) return null;
  if (poi.isPeak && typeof peakAccess === "function") {
    const acc = peakAccess(poi.no);
    const th0 = acc && Array.isArray(acc.th) ? acc.th[0] : null;
    if (th0 && Number.isFinite(Number(th0.la)) && Number.isFinite(Number(th0.lo))) {
      return {
        lat: Number(th0.la),
        lng: Number(th0.lo),
        label: String(th0.n || "登山口"),
        source: "登山口（PEAK_ACCESS／健行筆記）",
      };
    }
  }
  if (Number.isFinite(Number(poi.lat)) && Number.isFinite(Number(poi.lng))) {
    return {
      lat: Number(poi.lat),
      lng: Number(poi.lng),
      label: String(poi.name || "登山口"),
      source: poi.isPeak
        ? "山頂座標（PEAKS；本座無登山口資料）"
        : "登山口座標（HIKE_POIS）",
    };
  }
  return null;
}

/* ---------- 資料庫對照值（不經 Overpass，永遠可顯示） ---------- */

function parseTrailLenText(text) {
  const m = String(text || "").match(/([\d.]+)\s*公里/);
  return m ? Number(m[1]) : null;
}

function parseTrailTimeText(text) {
  const s = String(text || "");
  const h = s.match(/([\d.]+)\s*小時/);
  const m = s.match(/([\d.]+)\s*分/);
  if (!h && !m) return null;
  return (h ? Number(h[1]) : 0) + (m ? Number(m[1]) / 60 : 0);
}

/**
 * 資料庫步道值：HIKE_POIS 用 trail{km,gain,hours}；
 * 小百岳用 PEAK_ACCESS 第一條步道 tr[0]{len,time}（健行筆記，字串需解析）。
 * 回傳 { km, hours, gain, timeText, trailName, url, source }，無資料回傳 null。
 * 注意：小百岳 gain 一律為 null（資料庫無爬升欄位），不要拿 elev 減 alt 硬湊。
 */
function trailDbInfo(poi) {
  if (!poi) return null;
  if (poi.trail && (Number.isFinite(Number(poi.trail.km)) || Number.isFinite(Number(poi.trail.hours)))) {
    return {
      km: Number.isFinite(Number(poi.trail.km)) ? Number(poi.trail.km) : null,
      hours: Number.isFinite(Number(poi.trail.hours)) ? Number(poi.trail.hours) : null,
      gain: Number.isFinite(Number(poi.trail.gain)) ? Number(poi.trail.gain) : null,
      timeText: Number.isFinite(Number(poi.trail.hours)) ? trailFmtDuration(poi.trail.hours) : "",
      trailName: "",
      url: "",
      source: "HIKE_POIS trail",
    };
  }
  if (poi.isPeak && typeof peakAccess === "function") {
    const acc = peakAccess(poi.no);
    const tr0 = acc && Array.isArray(acc.tr) ? acc.tr[0] : null;
    if (tr0) {
      const hours = parseTrailTimeText(tr0.time);
      return {
        km: parseTrailLenText(tr0.len),
        hours,
        gain: null,
        timeText: String(tr0.time || ""),
        trailName: String(tr0.n || ""),
        url: String(tr0.url || (tr0.bid ? "https://hiking.biji.co/index.php?q=trail&act=detail&id=" + tr0.bid : "")),
        source: "PEAK_ACCESS tr（健行筆記，第一條步道）",
      };
    }
  }
  return null;
}

/* ---------- Naismith 步行時間估算 ---------- */

/**
 * Naismith 規則：平路 4 km/h＋每爬升 600 m 加 1 小時；
 * 下坡每下降 300 m 減 10 分鐘，總時間下限為平路時間的 60%。
 * ascentM 為 null／非數字＝爬升未知：只計平路時間（下限），並在 formula 註明。
 * descentM 省略或 0＝不扣下坡（單程上山估算）。
 * 例：estimateNaismith(8, 600) → 平路 120 分＋爬升 60 分＝180 分＝3 小時。
 * 回傳 { hours, minutes, totalMinutes, flatMinutes, ascentMinutes,
 *         descentMinutes, floored, ascentKnown, formula }。
 */
function estimateNaismith(distanceKm, ascentM, descentM) {
  const dist = Math.max(0, Number(distanceKm) || 0);
  const ascentKnown = ascentM !== null && ascentM !== undefined && ascentM !== "" && Number.isFinite(Number(ascentM));
  const up = ascentKnown ? Math.max(0, Number(ascentM)) : 0;
  const down = Math.max(0, Number(descentM) || 0);
  const flatMinutes = (dist / 4) * 60;
  const ascentMinutes = (up / 600) * 60;
  const descentMinutes = (down / 300) * 10;
  const floorMinutes = flatMinutes * 0.6;
  let totalMinutes = flatMinutes + ascentMinutes - descentMinutes;
  const floored = totalMinutes < floorMinutes;
  if (floored) totalMinutes = floorMinutes;
  totalMinutes = Math.round(totalMinutes);
  const formula = "Naismith 估算：平路 " + dist.toFixed(1) + " km ÷ 4 km/h（" +
    Math.round(flatMinutes) + " 分）" +
    (ascentKnown
      ? "＋爬升 " + Math.round(up) + " m ÷ 600 m/h（" + Math.round(ascentMinutes) + " 分）"
      : "＋爬升未知（資料庫無爬升欄位，僅計平路時間，為下限）") +
    (down > 0 ? "－下坡 " + Math.round(down) + " m ÷ 300 m 減 " + Math.round(descentMinutes) + " 分" : "（未計下坡）") +
    (floored ? "，已觸及下限（不低於平路時間 60%）" : "");
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
    totalMinutes,
    flatMinutes: Math.round(flatMinutes),
    ascentMinutes: Math.round(ascentMinutes),
    descentMinutes: Math.round(descentMinutes),
    floored,
    ascentKnown,
    formula,
  };
}

/* ---------- Overpass 查詢 ---------- */

function trailOverpassQuery(anchor, radiusM) {
  const lat = Number(anchor.lat).toFixed(5);
  const lng = Number(anchor.lng).toFixed(5);
  const r = Math.max(500, Math.round(radiusM || TRAIL_RADIUS_M));
  return "[out:json][timeout:15];(\n" +
    '  relation["route"="hiking"](around:' + r + "," + lat + "," + lng + ");\n" +
    '  way["route"="hiking"](around:' + r + "," + lat + "," + lng + ");\n" +
    '  node["amenity"="drinking_water"](around:' + r + "," + lat + "," + lng + ");\n" +
    ");out geom;";
}

/**
 * 打三鏡像：每站失敗重試一次（TRAIL_MAX_ATTEMPTS 次），再換下一站。
 * 全部失敗時 throw 最後一個錯誤（由 loadTrailRoute 轉為 status:"error"）。
 */
async function fetchOverpassOnce(query) {
  let lastError = null;
  for (const endpoint of TRAIL_ENDPOINTS) {
    for (let attempt = 1; attempt <= TRAIL_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
            Accept: "application/json",
          },
          body: "data=" + encodeURIComponent(query),
          signal: AbortSignal.timeout(TRAIL_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (!data || !Array.isArray(data.elements)) throw new Error("Overpass 回傳格式不正確");
        return data;
      } catch (err) {
        lastError = err;
      }
    }
  }
  throw lastError || new Error("Overpass 查詢失敗（三鏡像皆無回應）");
}

function routePointsDistance(points) {
  if (typeof haversine !== "function" || !Array.isArray(points) || points.length < 2) return 0;
  let km = 0;
  for (let i = 1; i < points.length; i++) km += haversine(points[i - 1], points[i]);
  return km;
}

/* 把 relation／way 的 geometry 攤平成 points（相鄰重複點去重），並算長度 */
function geomToRoute(el) {
  const points = [];
  const pushPt = (lat, lng) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const last = points[points.length - 1];
    if (last && Math.abs(last.lat - lat) < 1e-9 && Math.abs(last.lng - lng) < 1e-9) return;
    points.push({ lat, lng });
  };
  if (el.type === "relation" && Array.isArray(el.members)) {
    el.members.forEach((m) => {
      if (m.type !== "way" || !Array.isArray(m.geometry)) return;
      m.geometry.forEach((g) => pushPt(Number(g.lat), Number(g.lon)));
    });
  } else if (el.type === "way" && Array.isArray(el.geometry)) {
    el.geometry.forEach((g) => pushPt(Number(g.lat), Number(g.lon)));
  }
  return { points, distanceKm: routePointsDistance(points) };
}

function parseTrailOverpass(data) {
  const relations = [];
  const ways = [];
  const drinkingWater = [];
  const seenWater = new Set();
  (data.elements || []).forEach((el) => {
    if (!el || !el.tags) return;
    if (el.tags.route === "hiking" && (el.type === "relation" || el.type === "way")) {
      const r = geomToRoute(el);
      if (r.points.length >= 2 && r.distanceKm > 0) {
        const rec = {
          id: el.type + "/" + el.id,
          name: String(el.tags["name:zh"] || el.tags.name || el.tags.ref || "登山路線（OSM）"),
          points: r.points,
          distanceKm: r.distanceKm,
        };
        if (el.type === "relation") relations.push(rec);
        else ways.push(rec);
      }
    }
    if (el.type === "node" && el.tags.amenity === "drinking_water") {
      const lat = Number(el.lat);
      const lng = Number(el.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      const key = lat.toFixed(5) + "," + lng.toFixed(5);
      if (seenWater.has(key)) return;
      seenWater.add(key);
      drinkingWater.push({
        lat,
        lng,
        name: String(el.tags["name:zh"] || el.tags.name || "飲水點（未命名）"),
      });
    }
  });
  /* 主路線取最長的一條 relation（山區常有多條 relation 交疊），無 relation 才取 way */
  const candidates = relations.length ? relations : ways;
  candidates.sort((a, b) => b.distanceKm - a.distanceKm);
  return {
    route: candidates[0] || null,
    relationCount: relations.length,
    wayCount: ways.length,
    drinkingWater,
  };
}

/* ---------- 海拔剖面簡表（不編造高程） ---------- */

/**
 * 最高點與起點海拔只用資料庫值：
 * - 小百岳：最高點＝PEAKS elev（山頂海拔）；起點海拔未知（登山口無海拔欄位）
 * - HIKE_POIS：起點＝alt（登山口海拔）；最高點＝alt＋trail.gain（有 gain 時）
 * Overpass 幾何無高程，絕不用它推算爬升或最高點。
 */
function trailProfile(poi, routeData) {
  const db = (routeData && routeData.db) || trailDbInfo(poi);
  let highestM = null;
  let highestSource = "";
  let startAltM = null;
  let startAltSource = "";
  if (poi && poi.isPeak && Number.isFinite(Number(poi.elev))) {
    highestM = Number(poi.elev);
    highestSource = "山頂海拔（PEAKS elev）";
  } else if (poi && Number.isFinite(Number(poi.alt))) {
    startAltM = Number(poi.alt);
    startAltSource = "登山口海拔（HIKE_POIS alt）";
    if (db && Number.isFinite(Number(db.gain))) {
      highestM = Number(poi.alt) + Number(db.gain);
      highestSource = "登山口海拔＋資料庫爬升（HIKE_POIS alt＋trail.gain）";
    }
  }
  return {
    distanceKm: routeData && routeData.route ? routeData.route.distanceKm : (db ? db.km : null),
    distanceSource: routeData && routeData.route ? "Overpass 路線幾何估算" : "資料庫值",
    ascentM: db ? db.gain : null,
    ascentSource: db && Number.isFinite(Number(db.gain)) ? db.source : "未知（資料庫無爬升欄位）",
    highestM,
    highestSource: highestSource || "未知（無資料庫值）",
    startAltM,
    startAltSource: startAltSource || "未知（登山口無海拔欄位）",
  };
}

/* ---------- 主流程 ---------- */

/**
 * 查一座山／登山口的步道路線。永遠 resolve、不 throw。
 * 回傳：
 * {
 *   status: "ok"｜"no-route"｜"error",
 *   poiId, poiName, anchor, db,
 *   route: { id, name, points:[{lat,lng}], distanceKm, distanceSource }｜null,
 *   ascentM, ascentSource, estimate｜null, profile,
 *   drinkingWater: [{lat,lng,name}], error: string｜null, fetchedAt
 * }
 * - ok：有路線幾何，estimate 以路線長度＋資料庫爬升估算。
 * - no-route：Overpass 有回應但周邊無 route=hiking（或只有飲水點），
 *   estimate 改以資料庫長度估算（若有），UI 顯示「路線圖暫無法取得」。
 * - error：三鏡像皆失敗，error 為最後一個錯誤訊息，UI 顯示失敗＋重試。
 */
async function fetchTrailRoute(poi, opts) {
  opts = opts || {};
  const key = (poi && poi.id) || (poi ? Number(poi.lat) + "," + Number(poi.lng) : "unknown");
  if (opts.force) trailCache.delete(key);
  if (trailCache.has(key)) return trailCache.get(key);
  const job = loadTrailRoute(poi);
  trailCache.set(key, job);
  job.catch(() => trailCache.delete(key));
  return job;
}

async function loadTrailRoute(poi) {
  const db = trailDbInfo(poi);
  const base = {
    poiId: (poi && poi.id) || "",
    poiName: (poi && poi.name) || "",
    db,
    drinkingWater: [],
    fetchedAt: new Date().toISOString(),
  };
  const anchor = resolveTrailAnchor(poi);
  if (!anchor) {
    return {
      ...base,
      status: "error",
      anchor: null,
      route: null,
      ascentM: db ? db.gain : null,
      ascentSource: "未知",
      estimate: null,
      profile: trailProfile(poi, { ...base, db }),
      error: "找不到登山口座標，無法查詢步道路線。",
    };
  }
  let data;
  try {
    data = await fetchOverpassOnce(trailOverpassQuery(anchor, TRAIL_RADIUS_M));
  } catch (err) {
    return {
      ...base,
      status: "error",
      anchor,
      route: null,
      ascentM: db ? db.gain : null,
      ascentSource: db && Number.isFinite(Number(db.gain)) ? db.source : "未知（資料庫無爬升欄位）",
      estimate: db && Number.isFinite(Number(db.km))
        ? estimateNaismith(db.km, db ? db.gain : null, 0)
        : null,
      profile: trailProfile(poi, { ...base, db }),
      error: "Overpass 查詢失敗（三鏡像皆無回應，請檢查網路後重試）：" + String((err && err.message) || err),
    };
  }
  const parsed = parseTrailOverpass(data);
  const ascentM = db ? db.gain : null;
  const ascentSource = db && Number.isFinite(Number(db.gain)) ? db.source : "未知（資料庫無爬升欄位）";
  if (!parsed.route) {
    return {
      ...base,
      status: "no-route",
      anchor,
      route: null,
      ascentM,
      ascentSource,
      estimate: db && Number.isFinite(Number(db.km))
        ? estimateNaismith(db.km, ascentM, 0)
        : null,
      profile: trailProfile(poi, { ...base, db }),
      drinkingWater: parsed.drinkingWater,
      error: "此區域在 OpenStreetMap 上尚無登山路線（route=hiking）資料，路線圖暫無法取得。",
    };
  }
  const route = {
    id: parsed.route.id,
    name: parsed.route.name,
    points: parsed.route.points,
    distanceKm: parsed.route.distanceKm,
    distanceSource: "Overpass 路線幾何累加 haversine（估算）",
    relationCount: parsed.relationCount,
    wayCount: parsed.wayCount,
  };
  const result = {
    ...base,
    status: "ok",
    anchor,
    route,
    ascentM,
    ascentSource,
    estimate: estimateNaismith(route.distanceKm, ascentM, 0),
    profile: null,
    drinkingWater: parsed.drinkingWater,
    error: null,
  };
  result.profile = trailProfile(poi, result);
  return result;
}

/** 清快取：不帶參數清全部，帶 poi 只清該座山（重試按鈕用 force 即可，一般不用呼叫）。 */
function clearTrailCache(poi) {
  if (poi) {
    const key = poi.id || (Number(poi.lat) + "," + Number(poi.lng));
    trailCache.delete(key);
  } else {
    trailCache.clear();
  }
}

/* ---------- 地圖圖層（風格對齊 renderNearbyLayer／renderRoute） ---------- */

/**
 * 畫步道路線：白色描邊＋橘色主線（與行程路線的綠色虛線區分），
 * 起點「起」／終點「終」標記（起訖 < 50 m 時只畫「起／終」），
 * 飲水點以 💧 標記＋popup。無路線時只畫飲水點。
 * mapLayers.trail 由總協調員在 app.js initMap 建立；若不存在則就地建立。
 * 回傳 true＝有畫出東西，false＝L 未載入或無資料可畫。
 */
function renderTrailLayer(map, routeData) {
  if (typeof L === "undefined" || !map || !routeData) return false;
  let layer = null;
  if (typeof mapLayers !== "undefined" && mapLayers) layer = mapLayers.trail || null;
  if (!layer) {
    layer = L.layerGroup().addTo(map);
    if (typeof mapLayers !== "undefined" && mapLayers) mapLayers.trail = layer;
  }
  layer.clearLayers();
  const pts = routeData.route ? routeData.route.points : [];
  let drawn = false;
  if (pts.length >= 2) {
    const latlngs = pts.map((p) => [p.lat, p.lng]);
    L.polyline(latlngs, { color: "#ffffff", weight: 7, opacity: 0.7, lineCap: "round" }).addTo(layer);
    L.polyline(latlngs, { color: "#ea580c", weight: 4, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(layer);
    const start = pts[0];
    const end = pts[pts.length - 1];
    const loop = typeof haversine === "function" && haversine(start, end) < 0.05;
    L.marker([start.lat, start.lng], {
      icon: L.divIcon({
        className: "stop-marker",
        html: '<span class="stop-marker-inner">' + (loop ? "起／終" : "起") + "</span>",
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
      interactive: false,
      zIndexOffset: 700,
    }).addTo(layer);
    if (!loop) {
      L.marker([end.lat, end.lng], {
        icon: L.divIcon({
          className: "stop-marker",
          html: '<span class="stop-marker-inner">終</span>',
          iconSize: [28, 28],
          iconAnchor: [14, 14],
        }),
        interactive: false,
        zIndexOffset: 700,
      }).addTo(layer);
    }
    drawn = true;
  }
  (routeData.drinkingWater || []).forEach((w) => {
    L.marker([w.lat, w.lng], {
      icon: L.divIcon({
        className: "trail-water-marker",
        html: "💧",
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      }),
      title: w.name,
      riseOnHover: true,
      zIndexOffset: 600,
    })
      .bindPopup("<strong>💧 " + trailEsc(w.name) + "</strong><br><span style=\"color:#68756b\">飲水點（OpenStreetMap）</span>")
      .addTo(layer);
    drawn = true;
  });
  return drawn;
}

function clearTrailLayer() {
  if (typeof mapLayers !== "undefined" && mapLayers && mapLayers.trail) {
    mapLayers.trail.clearLayers();
  }
}

/** 路線＋飲水點的 bounds（供 map.flyToBounds 用），無 L 或無點回傳 null。 */
function trailLayerBounds(routeData) {
  if (typeof L === "undefined" || !routeData) return null;
  const pts = [];
  if (routeData.route) routeData.route.points.forEach((p) => pts.push([p.lat, p.lng]));
  (routeData.drinkingWater || []).forEach((w) => pts.push([w.lat, w.lng]));
  if (!pts.length) return null;
  return L.latLngBounds(pts);
}

/* ---------- 詳情卡「步道路線」區塊（HTML 字串，沿用現有 pc-* 樣式） ---------- */

/** 詳情卡 placeholder：只對 cat=hike 顯示，查詢完成後由 bindTrailToDetail 填入。 */
function trailSectionPlaceholder(poi) {
  if (!poi || poi.cat !== "hike") return "";
  return '<div id="trailSection" class="pc-access" data-poi="' + trailEsc(poi.id || "") + '">' +
    '<div class="pc-access-title">🥾 步道路線</div>' +
    '<p class="pc-note">步道路線查詢中…（OpenStreetMap）</p>' +
    "</div>";
}

function trailDbLine(db) {
  if (!db) return "";
  const parts = [];
  if (Number.isFinite(Number(db.km))) parts.push("長度 " + trailFmtKm(db.km, 1) + " km");
  // F3 下雨情境：資料庫步道時間 ×1.25（weather.js adjustHikeTimeText；無情境時原字串不變）。
  if (db.timeText) parts.push("時間 " + trailEsc(typeof adjustHikeTimeText === "function" ? adjustHikeTimeText(db.timeText) : db.timeText));
  if (Number.isFinite(Number(db.gain))) parts.push("爬升 " + trailFmtKm(db.gain) + " m");
  if (!parts.length) return "";
  return "<p>資料庫對照（" + trailEsc(db.source) + "）：" + parts.join(" · ") + "</p>";
}

/** 依 fetchTrailRoute 的 status 產生區塊內文；失敗／無路線時一定有重試按鈕，絕不空白。 */
function trailSectionHTML(result) {
  if (!result) return "";
  const head = '<div class="pc-access-title">🥾 步道路線</div>';
  const retry = '<p><button type="button" class="mini-btn" data-act="trail-retry" data-id="' +
    trailEsc(result.poiId) + '">重試查詢</button></p>';
  const waterLine = (result.drinkingWater && result.drinkingWater.length)
    ? "<p>💧 補水點 " + result.drinkingWater.length + " 處（OpenStreetMap amenity=drinking_water，周邊約 3 km，地圖上有 💧 標記）</p>"
    : "<p>💧 周邊約 3 km 內在 OpenStreetMap 上查無飲水點，請自行備水。</p>";
  const estimateLine = (est, distKm, distSource) => {
    if (!est) return "";
    // F3 下雨情境：Naismith 估算時間 ×1.25（weather.js scenarioHikeFactor；無情境時因子為 1）。
    const hikeF = typeof scenarioHikeFactor === "function" ? scenarioHikeFactor() : 1;
    const adjHours = (est.hours + est.minutes / 60) * hikeF;
    return "<p>步行時間（Naismith 估算）：" + trailFmtDuration(adjHours) +
      "（" + trailEsc(est.formula) + (hikeF !== 1 ? "；已套用下雨情境 ×1.25" : "") + "）</p>" +
      "<p>路線長度：" + trailFmtKm(distKm, 1) + " km（" + trailEsc(distSource) + "）</p>";
  };
  const profileLine = (profile) => {
    if (!profile) return "";
    const parts = [];
    if (Number.isFinite(Number(profile.ascentM))) parts.push("爬升 " + trailFmtKm(profile.ascentM) + " m（" + trailEsc(profile.ascentSource) + "）");
    else parts.push("爬升未知（" + trailEsc(profile.ascentSource) + "）");
    if (Number.isFinite(Number(profile.highestM))) parts.push("最高點 " + trailFmtKm(profile.highestM) + " m（" + trailEsc(profile.highestSource) + "）");
    return parts.length ? "<p>" + parts.join(" · ") + "</p>" : "";
  };
  if (result.status === "ok") {
    return head +
      "<p>路線：" + trailEsc(result.route.name) + "（OpenStreetMap route=hiking）</p>" +
      estimateLine(result.estimate, result.route.distanceKm, result.route.distanceSource) +
      profileLine(result.profile) +
      trailDbLine(result.db) +
      waterLine +
      '<p class="pc-note">路線來自 OpenStreetMap 社群資料，登山前請再確認最新路況；步行時間為 Naismith 估算，實際依體能與天候調整。</p>';
  }
  if (result.status === "no-route") {
    return head +
      "<p>路線圖暫無法取得（" + trailEsc(result.error || "") + "）</p>" +
      (result.estimate
        ? estimateLine(result.estimate, result.db ? result.db.km : 0, "資料庫長度（" + (result.db ? result.db.source : "") + "）")
        : "") +
      trailDbLine(result.db) +
      waterLine +
      retry;
  }
  return head +
    "<p>路線查詢失敗（" + trailEsc(result.error || "Overpass 無回應") + "）</p>" +
    trailDbLine(result.db) +
    retry;
}

/**
 * 詳情卡接線入口（由 app.js selectPOI／重試按鈕呼叫）：
 * 非登山點 → 清掉步道圖層並離開；登山點 → 查路線、填區塊、畫圖層。
 * 用 section 的 data-poi 比對，避免使用者快速切換 POI 時舊查詢蓋掉新卡片。
 */
async function bindTrailToDetail(poi, opts) {
  opts = opts || {};
  if (typeof document === "undefined") return null;
  if (!poi || poi.cat !== "hike") {
    clearTrailLayer();
    return null;
  }
  const section = document.querySelector("#trailSection");
  if (!section) {
    clearTrailLayer();
    return null;
  }
  section.setAttribute("data-poi", poi.id || "");
  section.innerHTML = '<div class="pc-access-title">🥾 步道路線</div>' +
    '<p class="pc-note">步道路線查詢中…（OpenStreetMap）</p>';
  const result = await fetchTrailRoute(poi, opts);
  const current = document.querySelector("#trailSection");
  if (!current || current.getAttribute("data-poi") !== (poi.id || "")) return result;
  current.innerHTML = trailSectionHTML(result);
  const mapObj = (typeof map !== "undefined") ? map : null;
  if (mapObj && (result.status === "ok" || (result.drinkingWater && result.drinkingWater.length))) {
    renderTrailLayer(mapObj, result);
  } else {
    clearTrailLayer();
  }
  return result;
}
