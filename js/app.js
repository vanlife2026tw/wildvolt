/* =========================================================
   野電計畫 WildVolt — 介面、地圖與互動
   ========================================================= */

"use strict";

const WV_KEY = "wildvolt.v1";
const SAVED_KEY = "wildvolt.saved.v1";

const state = {
  view: "explore",
  // 用 defaultEv() 才能帶著車庫清單（vehicles），舊的 {...EV_DEFAULTS} 沒有車庫
  ev: (typeof defaultEv === "function" ? defaultEv() : { ...EV_DEFAULTS }),
  startId: "taipei",
  startCustom: null,
  itinerary: [],
  stopDays: {},
  filters: { q: "", cats: ["camp", "car", "hike", "spot"], region: "all", sort: "rating", partner: true, partnerKind: "all" },
  anchorId: "camp-cingjing",
  radius: 15,
  foodKinds: [],
  liveFood: [],
  liveSpots: [],
  foodResults: [],
  custom: [],
  livePoi: { q: "", status: "idle", items: [], error: "" },
  exploreLimit: 40,
  exploreSig: "",
  selectedId: null,
  terrain: false,
  showChargers: false,
  osrm: {},
};

let map = null;
let baseStreet = null;
let baseTerrain = null;
const mapLayers = {};
let radiusCircle = null;
let rangeCircle = null;
let lastFocusedEl = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ---------------- 狀態 ---------------- */
function loadState() {
  try {
    const raw = localStorage.getItem(WV_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (saved.ev) {
      const base = typeof defaultEv === "function" ? defaultEv() : { ...EV_DEFAULTS };
      state.ev = { ...base, ...saved.ev };
      // 舊存檔沒有車庫、或車庫是空陣列時，用預設車庫補上，避免 activeVehicle 掉回舊寫法
      if (!Array.isArray(state.ev.vehicles) || !state.ev.vehicles.length) {
        state.ev.vehicles = base.vehicles;
      } else {
        // 若舊存檔中的預設車款 veh-n7s 仍為舊版參數（road 4.9 / capacity 57.3 / range 280），自動升級為最新預設（100%=57度電，平路6.7、高速3.1、爬坡2.9）
        state.ev.vehicles = state.ev.vehicles.map((v) => {
          if (v && v.id === "veh-n7s" && (Number(v.road) === 4.9 || Number(v.capacity) === 57.3 || Number(v.range) === 280)) {
            return {
              ...v,
              capacity: 57,
              range: 382,
              road: 6.7,
              highway: 3.1,
              climb: 2.9,
            };
          }
          return v;
        });
      }
      if (!state.ev.baseChargeMode) state.ev.baseChargeMode = "auto";
      if (!state.ev.routeMode) state.ev.routeMode = "auto";
    if (!state.ev.overnightMode) state.ev.overnightMode = "camp-ac";
      if (typeof state.ev.highwayChargeId !== "string") state.ev.highwayChargeId = "";
    }
    if (typeof saved.startId === "string") state.startId = saved.startId;
    if (saved.startCustom) state.startCustom = saved.startCustom;
    if (Array.isArray(saved.custom)) {
      state.custom = saved.custom.filter(
        (p) => p && typeof p.id === "string" && typeof p.name === "string"
          && Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng))
      );
    }
    if (Array.isArray(saved.itinerary)) {
      state.itinerary = saved.itinerary.filter((id) => allPOIs().some((p) => p.id === id));
    }
    if (saved.stopDays && typeof saved.stopDays === "object") state.stopDays = saved.stopDays;
    if (typeof saved.anchorId === "string" && allPOIs().some((p) => p.id === saved.anchorId)) {
      state.anchorId = saved.anchorId;
    }
    if (saved.radius) state.radius = Number(saved.radius) || 15;
    if (saved.osrm && typeof saved.osrm === "object") state.osrm = saved.osrm;
  } catch (err) {
    console.warn("無法讀取儲存狀態", err);
  }
}

function persist() {
  try {
    localStorage.setItem(WV_KEY, JSON.stringify({
      ev: state.ev,
      startId: state.startId,
      startCustom: state.startCustom,
      itinerary: state.itinerary,
      stopDays: state.stopDays,
      anchorId: state.anchorId,
      radius: state.radius,
      custom: state.custom,
      osrm: state.osrm,
    }));
  } catch (err) { /* 忽略儲存失敗 */ }
}

function allPOIs() {
  return state.custom.length ? POIS.concat(state.custom) : POIS;
}

function partnerPOIs() {
  return typeof PARTNER_POIS === "undefined" ? [] : PARTNER_POIS;
}

function getPOI(id) {
  return allPOIs().find((p) => p.id === id) || partnerPOIs().find((p) => p.id === id) || null;
}

function startPoint() {
  if (state.startCustom) return state.startCustom;
  const s = STARTS.find((x) => x.id === state.startId) || STARTS[0];
  return { id: s.id, name: s.name, lat: s.lat, lng: s.lng, alt: s.alt, cat: "start" };
}

function legKey(a, b) {
  return `${a.lat.toFixed(3)},${a.lng.toFixed(3)}>${b.lat.toFixed(3)},${b.lng.toFixed(3)}`;
}

function stops() {
  return state.itinerary.map((id) => {
    const poi = getPOI(id);
    if (!poi) return null;
    const route = state.osrm[legKey(startPoint(), poi)] || null;
    return route ? { ...poi, route } : poi;
  }).filter(Boolean);
}

function anchorPoint() {
  return getPOI(state.anchorId) || stops()[0] || getPOI("camp-cingjing");
}

function plan() {
  const ev = state.ev;
  const list = stops();
  return buildTripPlan({
    start: startPoint(),
    stops: list,
    ev,
    chargers: CHARGERS,
    stopDays: state.stopDays,
  });
}

function currentFoodResults() {
  if (!state.anchorId) return [];
  return nearbyFood(anchorPoint(), state.radius, state.foodKinds, state.liveFood);
}

/* ---------------- 小工具 ---------------- */
let toastTimer = null;
function toast(message) {
  const wrap = $("#toastWrap");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  wrap.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.opacity = "0";
    el.style.transform = "translateY(6px)";
    el.style.transition = "opacity .2s, transform .2s";
    setTimeout(() => el.remove(), 220);
  }, 2600);
}

function debounce(fn, wait = 140) {
  let t = 0;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

function catVar(cat) { return CATEGORIES[cat]?.color || "var(--forest)"; }
function catLabel(cat) { return CATEGORIES[cat]?.label || ""; }

function areaOf(region) {
  const key = String(region || "").slice(0, 2);
  if (["北部", "中部", "南部", "東部", "離島"].includes(key)) return key;
  if (["台北", "新北", "桃園", "新竹", "基隆"].includes(key)) return "北部";
  if (["苗栗", "台中", "彰化", "南投", "雲林"].includes(key)) return "中部";
  if (["嘉義", "台南", "高雄", "屏東", "澎湖"].includes(key)) return "南部";
  if (["宜蘭", "花蓮", "台東"].includes(key)) return "東部";
  return "其他";
}

function ratingStar(r) {
  if (!r) return "";
  return `<span class="rating">${Number(r).toFixed(1)}</span>`;
}

function poiIconHTML(p, extra = "") {
  const c = catVar(p.cat);
  return `<span class="poi-icon ${extra}" style="--c:${c}">${svgIcon(CATEGORIES[p.cat]?.icon || "pin")}</span>`;
}

function matchesQuery(p, q) {
  if (!q) return true;
  const hay = [
    p.name, p.region, p.desc, p.note, p.kind, p.level, p.address, p.partnerKind,
    ...(p.tags || []), ...(p.facts || []),
  ].join(" ").toLowerCase();
  return hay.includes(q.toLowerCase());
}

/* ---------------- 探索 ---------------- */
function renderCatChips() {
  const wrap = $("#catChips");
  const defs = [
    ["camp", "露營"], ["car", "車露"], ["hike", "登山"], ["spot", "景點"], ["food", "美食"],
  ];
  const f = state.filters;
  const partnerCount = partnerPOIs().length;
  wrap.innerHTML = defs.map(([cat, label]) => {
    const on = f.cats.includes(cat);
    const count = allPOIs().filter((p) => p.cat === cat).length + (cat === "car" ? partnerCount : 0);
    return `<button type="button" class="chip ${on ? "is-on" : ""}" style="--chip:${catVar(cat)}" data-cat="${cat}" aria-pressed="${on}">
      <i class="chip-i"></i>${label}<em>${count}</em>
    </button>`;
  }).join("") + (partnerCount ? `
    <button type="button" class="chip partner-chip ${f.partner ? "is-on" : ""}" data-partner="1" aria-pressed="${f.partner}" title="車床天地特約點：車泊、澡點、住宿、補給、餐飲">
      <i class="chip-i"></i>車床天地<em>${partnerCount}</em>
    </button>` : "");

  const kinds = $("#partnerKinds");
  if (!kinds) return;
  if (!partnerCount) { kinds.hidden = true; return; }
  kinds.hidden = !f.partner;
  kinds.innerHTML = PARTNER_KINDS.map(([k, label]) =>
    `<button type="button" class="chip chip-sm ${f.partnerKind === k ? "is-on" : ""}" data-pkind="${k}" aria-pressed="${f.partnerKind === k}">${label}</button>`
  ).join("");
}

function poiKey(p) {
  return `${String(p.name || "").replace(/[（(].*$/, "").replace(/\s+/g, "").trim()}@${Number(p.lat).toFixed(3)},${Number(p.lng).toFixed(3)}`;
}

function filteredPOIs() {
  const f = state.filters;
  const q = f.q.trim();
  let list = allPOIs().filter((p) => f.cats.includes(p.cat));

  // 車床天地特約點：開啟時顯示，或搜尋時自動納入
  const showPartner = partnerPOIs().length && f.cats.includes("car") && (f.partner || q.length >= 2);
  if (showPartner) {
    let extra = partnerPOIs();
    if (!q && f.partnerKind !== "all") extra = extra.filter((p) => p.partnerKind === f.partnerKind);
    const seen = new Set(list.map(poiKey));
    list = list.concat(extra.filter((p) => !seen.has(poiKey(p))));
  }

  if (f.region !== "all") list = list.filter((p) => areaOf(p.region) === f.region);
  if (q) list = list.filter((p) => matchesQuery(p, q));
  if (f.sort === "rating") {
    list.sort((a, b) =>
      (b.rating || 0) - (a.rating || 0)
      || Number(!!a.partner) - Number(!!b.partner)
      || a.name.localeCompare(b.name, "zh-Hant"));
  } else if (f.sort === "alt") {
    list.sort((a, b) => (b.alt || 0) - (a.alt || 0));
  } else {
    list.sort((a, b) => a.name.localeCompare(b.name, "zh-Hant"));
  }
  return list;
}

function poiRowHTML(p) {
  const added = state.itinerary.includes(p.id);
  const c = catVar(p.cat);
  const meta = [
    p.region,
    p.level || p.kind || "",
    p.alt ? `海拔 ${fmtKm(p.alt)} m` : "",
    p.price || (p.trail ? `步道 ${p.trail.km} km` : ""),
    p.address || "",
  ].filter(Boolean);
  const tags = (p.tags || []).slice(0, 3);
  return `<div class="poi-row ${state.selectedId === p.id ? "is-selected" : ""}" style="--c:${c}" data-id="${p.id}" tabindex="0" role="button" aria-label="${esc(p.name)}，${catLabel(p.cat)}">
    ${poiIconHTML(p)}
    <div class="poi-main">
      <div class="poi-title">
        <strong>${esc(p.name)}</strong>
        <span class="badge">${catLabel(p.cat)}</span>
        ${added ? '<span class="badge" style="color:var(--forest);border-color:rgba(47,125,79,.35);background:var(--lime-soft)">已加入</span>' : ""}
      </div>
      <div class="poi-meta">
        ${ratingStar(p.rating)}
        ${meta.map((m) => `<span>${esc(m)}</span>`).join("")}
      </div>
      ${tags.length ? `<div class="poi-tags">${tags.map((t) => `<span>${esc(t)}</span>`).join("")}</div>` : ""}
    </div>
    <div class="poi-actions">
      ${p.cat === "food"
        ? ""
        : `<button type="button" class="mini-btn" data-act="nearby" data-id="${p.id}" title="搜尋附近美食">附近美食</button>`}
      <button type="button" class="mini-btn ${added ? "" : "solid"}" data-act="add" data-id="${p.id}" ${added ? "disabled" : ""}>${added ? "已加入" : "＋ 加入"}</button>
    </div>
  </div>`;
}

/**
 * 當使用者搜尋山頭（如「棚集山」、「大凍山」）或點選某個登山口時，
 * 自動在探索面板上方顯示「該山頭附近可車露／車宿的地點（特約車泊、營區）」以及「附近順遊景點（運動公園、森林園區、熱門景點）」。
 * 因為不是每個山頭都能直接車宿，讓使用者搜山名就能直接看到山下／登山口旁的車露點並一鍵加入！
 */
function renderMountainHelper(filteredList) {
  const wrap = $("#mountainHelperWrap");
  if (!wrap) return;
  const q = state.filters.q.trim();
  const list = Array.isArray(filteredList) ? filteredList : filteredPOIs();

  // 找出目前聚焦或搜尋命中的山頭／登山口：
  // 1. 若有搜尋字，優先取搜尋結果中的登山口（或 OSM 搜尋到的山頭／登山口）
  // 2. 若未輸入搜尋字，但剛點選了某個登山口（selectedId 為 hike），也顯示該山頭周邊車露點
  let mountain = null;
  if (q.length >= 1) {
    mountain = list.find((p) => p.cat === "hike") || null;
    if (!mountain && state.livePoi.q === q && state.livePoi.items.length) {
      mountain = state.livePoi.items.find((p) => p.cat === "hike" || /山|嶺|峰|步道|登山口/.test(p.name)) || null;
    }
    // 若使用者在未勾選「登山」分類時搜尋「棚集山」，仍從全庫找登山口作為圓心
    if (!mountain) {
      mountain = allPOIs().find((p) => p.cat === "hike" && matchesQuery(p, q)) || null;
    }
  } else if (state.selectedId) {
    const sel = getPOI(state.selectedId);
    if (sel && sel.cat === "hike") mountain = sel;
  }

  if (!mountain) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    return;
  }

  const carSpots = typeof nearbyCarSpots === "function"
    ? nearbyCarSpots(mountain, 12, partnerPOIs()).slice(0, 5)
    : [];
  const spots = typeof nearbySpots === "function"
    ? nearbySpots(mountain, 15, state.liveSpots || []).slice(0, 5)
    : [];

  if (!carSpots.length && !spots.length) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    return;
  }

  const mountainAdded = state.itinerary.includes(mountain.id);

  const carHTML = carSpots.length
    ? `<div class="mh-section">
        <div class="mh-subhead">
          <span>🚐 登山口周邊可車露／車宿點（12 km 內共 ${carSpots.length} 處）</span>
          <small>不是每個山頭都能直接車宿，建議搭配以下合法／特約車泊營地</small>
        </div>
        <div class="mh-list">
          ${carSpots.map((c) => {
            const added = state.itinerary.includes(c.id);
            const bothAdded = added && mountainAdded;
            const distTxt = c.dist < 1 ? `${Math.round(c.dist * 1000)} m` : `${c.dist.toFixed(1)} km`;
            const kindBadge = c.partner ? (c.kind || "車床特約") : catLabel(c.cat);
            return `<div class="mh-item" data-mh-focus="${c.id}">
              <div class="mh-item-main">
                <div class="mh-item-title">
                  <strong>${esc(c.name)}</strong>
                  <span class="mh-dist">距登山口 ${distTxt}</span>
                  <span class="badge">${esc(kindBadge)}</span>
                </div>
                <div class="mh-item-meta">${esc(c.address || c.region || "")}${c.price ? ` · ${esc(c.price)}` : ""}${c.desc ? ` · ${esc(c.desc)}` : ""}</div>
              </div>
              <div class="mh-item-acts">
                <button type="button" class="mini-btn ${added ? "" : "solid"}" data-mh-add="${c.id}" ${added ? "disabled" : ""}>${added ? "已在行程" : "＋ 車露"}</button>
                ${mountain.live ? "" : `<button type="button" class="mini-btn mh-combo-btn" data-mh-combo="${mountain.id}|${c.id}" ${bothAdded ? "disabled" : ""} title="同時把「${esc(mountain.name)}」與「${esc(c.name)}」加入行程">${bothAdded ? "已全加入" : "＋ 山頭＋車露"}</button>`}
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>`
    : `<div class="mh-empty">此山頭周邊 12 km 內暫無登錄車露點，建議下山至鄰近鄉鎮住宿或營地。</div>`;

  const spotHTML = spots.length
    ? `<div class="mh-section">
        <div class="mh-subhead">
          <span>🎡 順遊附近景點・運動公園（15 km 內）</span>
          <small>下山泡腳、散步或親子放電好去處</small>
        </div>
        <div class="mh-spot-chips">
          ${spots.map((s) => {
            const added = state.itinerary.includes(s.id);
            const distTxt = s.dist < 1 ? `${Math.round(s.dist * 1000)} m` : `${s.dist.toFixed(1)} km`;
            return `<div class="mh-spot-card">
              <div class="mh-spot-info" data-mh-focus="${s.id}">
                <strong>${esc(s.name)}</strong>
                <span>${esc(s.kind || "景點")} · ${distTxt}</span>
              </div>
              <button type="button" class="mini-btn ${added ? "" : "solid"}" data-mh-add="${s.id}" ${added ? "disabled" : ""}>${added ? "已加入" : "＋ 順遊"}</button>
            </div>`;
          }).join("")}
        </div>
      </div>`
    : "";

  wrap.hidden = false;
  wrap.innerHTML = `
    <div class="mh-card">
      <div class="mh-head">
        <div>
          <span class="mh-kicker">⛰️ 山頭車宿 ＆ 順遊助手</span>
          <strong>${esc(mountain.name)}</strong>
          <span class="mh-region">${esc(mountain.region || "")}${mountain.alt ? ` · 海拔 ${fmtKm(mountain.alt)} m` : ""}</span>
        </div>
        ${mountain.live
          ? `<button type="button" class="mini-btn solid" data-live-add="${mountain.id}">＋ 加入山頭</button>`
          : `<button type="button" class="mini-btn ${mountainAdded ? "" : "solid"}" data-mh-add="${mountain.id}" ${mountainAdded ? "disabled" : ""}>${mountainAdded ? "山頭已加入" : "＋ 加入山頭"}</button>`}
      </div>
      ${carHTML}
      ${spotHTML}
    </div>
  `;
}

function renderExplore() {
  renderCatChips();
  const list = filteredPOIs();
  const f = state.filters;

  const sig = JSON.stringify([f.q, f.cats, f.region, f.sort, f.partner, f.partnerKind]);
  if (sig !== state.exploreSig) {
    state.exploreSig = sig;
    state.exploreLimit = 40;
  }

  renderMountainHelper(list);
  renderLivePoiSection();

  const wrap = $("#poiList");
  const q = f.q.trim();
  const hasLive = q.length >= 2 && state.livePoi.q === q && state.livePoi.items.length > 0;
  const partnerShown = list.filter((p) => p.partner).length;
  $("#poiCount").textContent = list.length
    ? `找到 ${list.length} 個據點${partnerShown ? `（含特約 ${partnerShown}）` : ""}`
    : hasLive
      ? `線上找到 ${state.livePoi.items.length} 筆`
      : "沒有符合條件的據點";

  if (!list.length) {
    if (hasLive) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = `<div class="empty-state"><strong>換個關鍵字試試</strong>${
      q ? `在地圖資沒有「${esc(q)}」，上方會同步搜尋 OpenStreetMap。` : "試試「車泊」、「海鮮」或清除區域篩選。"
    }</div>`;
    return;
  }

  const shown = list.slice(0, state.exploreLimit);
  wrap.innerHTML = shown.map(poiRowHTML).join("") + (list.length > shown.length
    ? `<div class="list-more"><button type="button" class="ghost-btn" data-act="more">顯示更多（還有 ${list.length - shown.length} 筆）</button></div>`
    : "");
}

/* ---------------- 探索：OpenStreetMap 即時搜尋 ---------------- */
const OSM_TYPE_LABEL = {
  peak: "山頭", camp_site: "營地", caravan_site: "露營車營地", parking: "停車場",
  attraction: "景點", viewpoint: "觀景點", water: "水域", lake: "湖泊",
  alpine_hut: "山屋", wilderness_hut: "山屋", trailhead: "登山口", hot_spring: "溫泉",
  restaurant: "餐廳", cafe: "咖啡", fast_food: "速食", bakery: "烘焙", food_court: "美食街",
  museum: "博物館", theme_park: "樂園", picnic_site: "野餐區",
};

const OSM_SKIP = new Set([
  "postcode", "administrative", "boundary", "road", "highway", "bus_stop", "station",
  "fuel", "atm", "bank", "pharmacy", "school", "university", "hospital", "clinic",
  "police", "townhall", "supermarket", "convenience", "parking_entrance", "yes",
]);

const livePoiCache = new Map();
let livePoiTimer = 0;
let livePoiAbort = null;
let lastNominatimAt = 0;

function regionFromLatLng(lat, lng) {
  if (lng > 121.3 && lat < 24.8) return "東部";
  if (lat >= 24.0) return "北部";
  if (lat >= 23.4) return "中部";
  return "南部";
}

function osmCatOf(row) {
  const t = row.type || "";
  if (t === "camp_site") return { cat: "camp", label: OSM_TYPE_LABEL[t] };
  if (t === "caravan_site" || t === "parking") return { cat: "car", label: OSM_TYPE_LABEL[t] };
  if (["peak", "trailhead", "alpine_hut", "wilderness_hut", "viewpoint", "water", "lake", "hot_spring"].includes(t)) {
    return { cat: "hike", label: OSM_TYPE_LABEL[t] || "景點" };
  }
  if (["restaurant", "cafe", "fast_food", "bakery", "food_court"].includes(t)) {
    return { cat: "food", label: OSM_TYPE_LABEL[t] || "餐飲" };
  }
  const alt = Number.parseFloat(row.extratags?.ele);
  if (["attraction", "museum", "theme_park", "picnic_site"].includes(t)) {
    return { cat: alt > 800 ? "hike" : "car", label: OSM_TYPE_LABEL[t] || "景點" };
  }
  return { cat: Number.isFinite(alt) && alt > 800 ? "hike" : "car", label: OSM_TYPE_LABEL[t] || "地標" };
}

function osmToPoi(row) {
  if (!row || OSM_SKIP.has(row.type)) return null;
  const name = String(row.name || String(row.display_name || "").split(",")[0] || "").trim();
  const lat = Number(row.lat);
  const lng = Number(row.lon);
  if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  // 已經有同名、相近的在地資料就不重複顯示
  const near = allPOIs().find((p) =>
    Math.abs(p.lat - lat) < 0.0015 && Math.abs(p.lng - lng) < 0.0015
    && (p.name.includes(name) || name.includes(p.name)));
  if (near) return null;

  const a = row.address || {};
  const town = a.town || a.village || a.suburb || a.city_district || a.hamlet || "";
  const county = a.county || a.city || a.state_district || "";
  const region = county
    ? `${county.replace(/[縣市]$/, "")}${town.replace(/[鄉鎮市區]$/, "")}`
    : regionFromLatLng(lat, lng);
  const address = [town, county].filter(Boolean).join("・");

  const { cat, label } = osmCatOf(row);
  const ele = Number.parseFloat(row.extratags?.ele);
  const alt = Number.isFinite(ele) ? Math.round(ele) : 0;

  return {
    id: `osm-${row.osm_type || "node"}-${row.osm_id}`,
    name: name.slice(0, 60),
    cat,
    kind: label,
    lat,
    lng,
    alt,
    region,
    address,
    desc: `OpenStreetMap・${label}`,
    note: (row.display_name || "").slice(0, 100),
    tags: ["OSM", label],
    source: "OSM",
    live: true,
  };
}

async function searchPlacesOnline(query, { force = false } = {}) {
  const q = String(query || "").trim();
  if (q.length < 2) return;
  const key = q.toLowerCase();

  if (!force && livePoiCache.has(key)) {
    state.livePoi = { q, status: "ok", items: livePoiCache.get(key), error: "" };
    renderLivePoiSection();
    renderMarkers();
    return;
  }

  if (livePoiAbort) livePoiAbort.abort();
  livePoiAbort = new AbortController();
  state.livePoi = {
    q,
    status: "loading",
    items: state.livePoi.q === q ? state.livePoi.items : [],
    error: "",
  };
  renderLivePoiSection();

  const wait = Math.max(0, 1100 - (Date.now() - lastNominatimAt));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastNominatimAt = Date.now();

  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("q", q);
    url.searchParams.set("countrycodes", "tw");
    url.searchParams.set("limit", "12");
    url.searchParams.set("dedupe", "1");
    url.searchParams.set("extratags", "1");
    url.searchParams.set("addressdetails", "1");
    url.searchParams.set("accept-language", "zh-TW");
    const res = await fetch(url, { signal: livePoiAbort.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = await res.json();
    const items = rows.map(osmToPoi).filter(Boolean);
    livePoiCache.set(key, items);
    if (state.livePoi.q !== q) return;
    state.livePoi = { q, status: "ok", items, error: "" };
    if (items.length && state.view === "explore") {
      const b = L.latLngBounds(items.map((p) => [p.lat, p.lng]));
      if (b.isValid()) map?.flyToBounds(b, { padding: [70, 70], maxZoom: 13, duration: 0.8 });
    }
  } catch (err) {
    if (err.name === "AbortError") return;
    if (state.livePoi.q !== q) return;
    state.livePoi = {
      q,
      status: "error",
      items: [],
      error: "線上搜尋暫時沒有回應，可稍後重試；在地資料仍可使用。",
    };
  }
  renderLivePoiSection();
  renderMarkers();
}

function scheduleLivePoiSearch(query) {
  const q = String(query || "").trim();
  clearTimeout(livePoiTimer);
  if (q.length < 2) {
    if (livePoiAbort) livePoiAbort.abort();
    state.livePoi = { q, status: "idle", items: [], error: "" };
    renderLivePoiSection();
    return;
  }
  livePoiTimer = setTimeout(() => searchPlacesOnline(q), 650);
}

function renderLivePoiSection() {
  const wrap = $("#livePoiWrap");
  if (!wrap) return;
  const q = state.filters.q.trim();
  if (q.length < 2) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    return;
  }
  wrap.hidden = false;

  const mine = state.livePoi.q === q;
  const loading = mine && state.livePoi.status === "loading";
  const items = mine ? state.livePoi.items : [];
  const errored = mine && state.livePoi.status === "error";
  const tone = errored ? "error" : items.length ? "ok" : "";

  const head = `<div class="live-head">
    <div class="live-title">上網找「${esc(q)}」<span>OpenStreetMap</span></div>
    <button type="button" class="mini-btn" data-live-retry="1">${loading ? "搜尋中…" : "重新搜尋"}</button>
  </div>`;

  let status = "";
  if (loading) status = `<div class="live-status" data-tone="">正在向 OpenStreetMap 查詢「${esc(q)}」…</div>`;
  else if (errored) status = `<div class="live-status" data-tone="error">${esc(state.livePoi.error)}</div>`;
  else if (mine && !items.length) status = `<div class="live-status" data-tone="">線上圖資沒有找到「${esc(q)}」，換個名稱或加上鄉鎮試試。</div>`;
  else if (items.length) status = `<div class="live-status" data-tone="ok">找到 ${items.length} 筆，可直接加入行程。</div>`;

  const rows = items.map((p) => {
    const added = !!getPOI(p.id);
    const meta = [p.region, p.alt ? `海拔 ${fmtKm(p.alt)} m` : "", p.kind].filter(Boolean);
    return `<div class="live-row" style="--c:${catVar(p.cat)}">
      <div class="live-main">
        <div class="live-name"><strong>${esc(p.name)}</strong><span class="badge">${esc(p.kind)}</span></div>
        <div class="live-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>
      </div>
      <button type="button" class="mini-btn ${added ? "" : "solid"}" data-live-add="${p.id}" ${added ? "disabled" : ""}>${added ? "已加入" : "＋ 加入"}</button>
    </div>`;
  }).join("");

  wrap.innerHTML = `${head}${status}${rows ? `<div class="live-list">${rows}</div>` : ""}`;
  wrap.dataset.tone = tone;
  renderMountainHelper();
}

function addLivePoi(id) {
  const item = state.livePoi.items.find((p) => p.id === id);
  if (!item) return;
  if (!getPOI(id)) state.custom.push({ ...item, live: false });
  state.livePoi.items = state.livePoi.items.filter((p) => p.id !== id);
  addStop(id);
}

/* ---------------- 美食 ---------------- */
function renderFoodControls() {
  const anchor = anchorPoint();
  if (anchor && state.anchorId !== anchor.id) state.anchorId = anchor.id;

  const selected = state.anchorId;
  const tripStops = stops();
  const anchorSelect = $("#foodAnchor");
  const options = [];
  if (tripStops.length) {
    options.push(`<optgroup label="行程站點">${tripStops.map((p) =>
      `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>`);
  }
  const groups = ["camp", "car", "hike"].map((cat) => {
    const items = POIS.filter((p) => p.cat === cat)
      .sort((a, b) => a.region.localeCompare(b.region, "zh-Hant"));
    return `<optgroup label="${catLabel(cat)}">${items.map((p) =>
      `<option value="${p.id}" ${p.id === selected ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</optgroup>`;
  }).join("");
  anchorSelect.innerHTML = options.join("") + groups;

  $("#radiusChips").innerHTML = [3, 5, 10, 15, 25, 40].map((r) =>
    `<button type="button" class="chip ${state.radius === r ? "is-on" : ""}" style="--chip:var(--food)" data-radius="${r}" aria-pressed="${state.radius === r}">${r} km</button>`
  ).join("");

  $("#kindChips").innerHTML = FOOD_KINDS.map((k) =>
    `<button type="button" class="chip ${state.foodKinds.includes(k) ? "is-on" : ""}" style="--chip:var(--food)" data-kind="${k}" aria-pressed="${state.foodKinds.includes(k)}">${k}</button>`
  ).join("");
}

function renderFood() {
  renderFoodControls();
  const anchor = anchorPoint();
  const results = currentFoodResults();
  state.foodResults = results.map((f) => f.id || f.name);
  $("#foodCount").textContent = anchor
    ? `以「${anchor.name}」為圓心 · ${results.length} 家`
    : "請選擇圓心";

  const wrap = $("#foodList");
  if (!anchor) {
    wrap.innerHTML = `<div class="empty-state"><strong>先選一個圓心</strong>從行程或上方選單挑一個營地、登山口或車泊點。</div>`;
    return;
  }
  if (!results.length) {
    wrap.innerHTML = `<div class="empty-state"><strong>半徑 ${state.radius} km 內沒有資料</strong>把半徑拉大，或按「OSM 即時搜尋」找更多店家。</div>`;
    return;
  }

  wrap.innerHTML = results.map((f, i) => {
    const isLive = f.source === "OSM" || !getPOI(f.id);
    const added = !isLive && state.itinerary.includes(f.id);
    const meta = [
      `<span class="dist">${f.dist < 1 ? `${Math.round(f.dist * 1000)} m` : `${f.dist.toFixed(1)} km`}</span>`,
      f.kind ? `<span>${esc(f.kind)}</span>` : "",
      f.price ? `<span>${esc(f.price)}</span>` : "",
      f.open ? `<span>${esc(f.open)}</span>` : "",
      f.rating ? `<span style="color:#9a6b12">★ ${Number(f.rating).toFixed(1)}</span>` : "",
    ].filter(Boolean);
    return `<div class="food-row" data-food="${i}">
      <span class="food-rank">${i + 1}</span>
      <div class="food-body">
        <div class="food-title">
          <strong>${esc(f.name)}</strong>
          ${isLive ? '<span style="color:var(--food)">OSM</span>' : ""}
          ${added ? '<span style="color:var(--forest)">已加入</span>' : ""}
        </div>
        <div class="food-meta">${meta.join("")}</div>
        <p class="food-desc">${esc(f.desc || f.address || f.region || "")}</p>
      </div>
      <div class="food-tools">
        <a class="mini-btn" href="https://www.google.com/maps/dir/?api=1&destination=${f.lat},${f.lng}&travelmode=driving" target="_blank" rel="noopener" style="text-align:center;line-height:24px">導航</a>
        ${isLive ? "" : `<button type="button" class="mini-btn ${added ? "" : "solid"}" data-act="add-food" data-food="${i}" ${added ? "disabled" : ""}>${added ? "已加入" : "加入"}</button>`}
      </div>
    </div>`;
  }).join("");
}

async function fetchLiveFood() {
  const anchor = anchorPoint();
  if (!anchor) { toast("請先選擇搜尋圓心"); return; }
  const btn = $("#liveFoodBtn");
  const status = $("#foodStatus");
  if (!navigator.onLine) { toast("目前離線，無法即時查詢"); return; }
  const radius = state.radius;
  btn.disabled = true;
  btn.textContent = "查詢中…";
  status.hidden = false;
  status.dataset.tone = "";
  status.textContent = `正在查詢「${anchor.name}」方圓 ${radius} km 的 OpenStreetMap 店家…`;

  try {
    let items = [];
    let via = "Nominatim";
    try {
      items = await searchNominatimFood(anchor, radius);
    } catch (err) { /* 換 Overpass */ }
    if (!items.length) {
      via = "Overpass";
      items = await searchOverpassFood(anchor, radius);
    }

    state.liveFood = items.slice(0, 45);
    status.dataset.tone = "ok";
    status.textContent = items.length
      ? `即時查到 ${items.length} 家店家（OpenStreetMap／${via}），已依距離排序，最多顯示 45 家。`
      : `方圓 ${radius} km 內沒有查到具名店家；山區 OSM 覆蓋率較低，試試放寬半徑或查看內建資料。`;
    renderFood();
    renderMarkers();
    if (items.length) fitFood();
  } catch (err) {
    state.liveFood = [];
    status.dataset.tone = "error";
    status.textContent = "即時查詢失敗（OpenStreetMap 服務忙碌或網路受限），已保留內建示範資料。";
    renderFood();
    renderMarkers();
  } finally {
    btn.disabled = false;
    btn.textContent = "OSM 即時搜尋";
  }
}

/* Nominatim：先以地名字索引查詢，速度快、CORS 穩定 */
async function searchNominatimFood(anchor, radius) {
  const dLat = radius / 111.32;
  const dLon = radius / (111.32 * Math.cos((anchor.lat * Math.PI) / 180));
  const viewbox = [anchor.lng - dLon, anchor.lat + dLat, anchor.lng + dLon, anchor.lat - dLat]
    .map((n) => n.toFixed(4))
    .join(",");
  const terms = ["restaurant", "cafe"];
  const seen = new Set();
  const items = [];

  for (const term of terms) {
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&extratags=1&limit=40&bounded=1&q=${term}&viewbox=${viewbox}&accept-language=zh-TW`;
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(9000),
    });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows)) throw new Error("Nominatim bad payload");
    rows.forEach((row) => {
      if (!row.name || !["restaurant", "cafe", "fast_food", "bakery"].includes(row.type)) return;
      const key = row.name.trim();
      if (seen.has(key)) return;
      const lat = Number(row.lat);
      const lng = Number(row.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      if (haversine(anchor, { lat, lng }) > radius * 1000 * 1.05) return;
      seen.add(key);
      const extra = row.extratags || {};
      items.push({
        id: `osm-${row.osm_type || "node"}-${row.osm_id}`,
        name: key,
        cat: "food",
        kind: extra.cuisine ? extra.cuisine.split(";")[0] : livKind(row.type),
        lat,
        lng,
        region: anchor.region,
        desc: [extra.cuisine, extra["addr:street"], extra.opening_hours].filter(Boolean).join(" · "),
        open: extra.opening_hours || "",
        address: (row.display_name || "").split(",").slice(0, 2).join(",").trim(),
        source: "OSM",
      });
    });
    await new Promise((r) => setTimeout(r, 1100));
  }

  return items.sort((a, b) => haversine(anchor, a) - haversine(anchor, b));
}

function livKind(type) {
  if (type === "cafe" || type === "bakery") return "咖啡甜點";
  if (type === "fast_food") return "速食";
  return "餐廳";
}

/* Overpass：Nominatim 查不到時，改抓完整圖徵（含 ways） */
async function searchOverpassFood(anchor, radius) {
  const q = `[out:json][timeout:20];(
    nwr(around:${radius * 1000},${anchor.lat},${anchor.lng})["amenity"~"^(restaurant|cafe|fast_food)$"];
    nwr(around:${radius * 1000},${anchor.lat},${anchor.lng})["shop"="bakery"];
  );out center 120;`;
  const endpoints = [
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  ];
  let data = null;
  let lastError = null;
  for (const endpoint of endpoints) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
          Accept: "application/json",
        },
        body: "data=" + encodeURIComponent(q),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      if (Array.isArray(data.elements)) break;
      data = null;
    } catch (err) {
      lastError = err;
    }
  }
  if (!data) throw lastError || new Error("Overpass unavailable");

  const seen = new Set();
  return (data.elements || [])
    .filter((el) => el.tags && el.tags.name && (el.lat || el.center))
    .map((el) => {
      const t = el.tags;
      const kind = t.cuisine ? t.cuisine.split(";")[0] : livKind(t.amenity === "bakery" ? "bakery" : t.amenity);
      return {
        id: `osm-${el.type || "node"}-${el.id}`,
        name: t.name,
        cat: "food",
        kind,
        lat: el.lat ?? el.center.lat,
        lng: el.lon ?? el.center.lon,
        region: anchor.region,
        desc: [t.cuisine, t["addr:street"] || t["addr:full"], t.opening_hours].filter(Boolean).join(" · "),
        open: t.opening_hours || "",
        address: t["addr:full"] || t["addr:street"] || "",
        source: "OSM",
      };
    })
    .filter((el) => {
      const key = el.name.trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => haversine(anchor, a) - haversine(anchor, b));
}

/* ---------------- 地圖 ---------------- */
function initMap() {
  if (typeof L === "undefined") {
    $("#mapFallback").hidden = false;
    return;
  }
  map = L.map("map", {
    zoomControl: false,
    attributionControl: true,
    minZoom: 7,
    maxZoom: 18,
  }).setView([23.74, 120.96], 8);

  // 注意：不要再用 tile.openstreetmap.org 當底圖。OSM 官方圖磚伺服器會對這類
  // 瀏覽器 App 回傳「Access blocked」圖磚（HTTP 仍是 200，所以程式看不出錯，
  // 畫面卻整片都是警告圖）。改用法國 OSM 分會的 HOT 圖層，同樣是 OSM 資料、
  // 不用 API key，實測在瀏覽器 UA＋localhost referer 下能正常出圖。
  baseStreet = L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, Tiles style by <a href="https://www.hotosm.org/" target="_blank" rel="noopener">Humanitarian OpenStreetMap Team</a> hosted by <a href="https://openstreetmap.fr/" target="_blank" rel="noopener">OpenStreetMap France</a>',
  }).addTo(map);

  // 地形圖同理：OpenTopoMap 也是志工伺服器，同樣會被擋／限流，改用 Esri
  // World Topo（不用 API key，Leaflet 模板注意是 {z}/{y}/{x} 順序）。
  baseTerrain = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, DeLorme, NAVTEQ, TomTom, Intermap, iPC, USGS, FAO, NPS, NRCAN, GeoBase, Kadaster NL, Ordnance Survey, Esri Japan, METI, Esri China (Hong Kong), and the GIS User Community',
  });

  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.control.scale({ imperial: false, position: "bottomleft", maxWidth: 110 }).addTo(map);

  mapLayers.route = L.layerGroup().addTo(map);

  if (typeof L.markerClusterGroup === "function") {
    const clusterIcon = (cls) => (cluster) => {
      const n = cluster.getChildCount();
      const size = n < 10 ? 34 : n < 30 ? 40 : 46;
      return L.divIcon({
        className: `poi-cluster ${cls}`,
        html: `<div><span>${n}</span></div>`,
        iconSize: [size, size],
      });
    };
    mapLayers.cluster = L.markerClusterGroup({
      maxClusterRadius: 46,
      disableClusteringAtZoom: 11,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      removeOutsideVisibleBounds: true,
      iconCreateFunction: clusterIcon(""),
    }).addTo(map);
    mapLayers.partner = L.markerClusterGroup({
      maxClusterRadius: 44,
      disableClusteringAtZoom: 12,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      removeOutsideVisibleBounds: true,
      iconCreateFunction: clusterIcon("poi-cluster--partner"),
    }).addTo(map);
    mapLayers.chargers = L.markerClusterGroup({
      maxClusterRadius: 42,
      disableClusteringAtZoom: 12,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      removeOutsideVisibleBounds: true,
      iconCreateFunction: clusterIcon("poi-cluster--charge"),
    });
  } else {
    mapLayers.cluster = L.layerGroup().addTo(map);
    mapLayers.partner = L.layerGroup().addTo(map);
    mapLayers.chargers = L.layerGroup();
  }

  map.fitBounds([[21.84, 119.95], [25.4, 122.15]], { padding: [6, 6] });

  map.on("click", () => closeDetail(false));
}

function pinIcon(p, small = false) {
  const color = catVar(p.cat);
  const cls = [
    "poi-marker",
    `poi-marker--${p.cat}`,
    state.selectedId === p.id ? "is-active" : "",
  ].filter(Boolean).join(" ");
  const size = small ? 24 : 31;
  return L.divIcon({
    className: cls,
    html: `<span class="poi-pin" style="--pin:${color}">${svgIcon(CATEGORIES[p.cat]?.icon || "pin")}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size + 5],
    popupAnchor: [0, -size - 2],
  });
}

function visiblePOIs() {
  const cats = state.filters.cats;

  if (state.view === "food") {
    const results = currentFoodResults();
    const out = results.filter((f) => f.cat === "food");
    const anchor = anchorPoint();
    if (anchor && !out.some((p) => p.id === anchor.id)) out.push(anchor);
    return out;
  }

  const base = allPOIs();
  let list = base.filter((p) => p.cat !== "food" && cats.includes(p.cat));
  if (cats.includes("food")) {
    list = list.concat(base.filter((p) => p.cat === "food"));
  }

  const q = state.filters.q.trim();
  if (partnerPOIs().length && cats.includes("car") && (state.filters.partner || q.length >= 2)) {
    let extra = partnerPOIs();
    if (!q && state.filters.partnerKind !== "all") {
      extra = extra.filter((p) => p.partnerKind === state.filters.partnerKind);
    }
    const seen = new Set(list.map(poiKey));
    list = list.concat(extra.filter((p) => !seen.has(poiKey(p))));
  }
  return list;
}

function updateRangeRing() {
  if (!map) return;
  const sp = startPoint();
  const usable = computeEv(state.ev).usableRange;
  if (!rangeCircle) {
    rangeCircle = L.circle([sp.lat, sp.lng], {
      radius: usable * 1000,
      color: "#7bab2f",
      weight: 1.6,
      opacity: 0.85,
      fillColor: "#a8d94f",
      fillOpacity: 0.05,
      dashArray: "4 7",
      interactive: false,
    })
      .bindTooltip("", {
        permanent: true,
        direction: "top",
        className: "range-tip",
        offset: [0, -4],
      })
      .addTo(map);
  }
  rangeCircle.setLatLng([sp.lat, sp.lng]);
  rangeCircle.setRadius(usable * 1000);
  rangeCircle.setTooltipContent(`可用里程 ${Math.round(usable)} km（直線距離，實際道路更短）`);
  if (!map.hasLayer(rangeCircle)) rangeCircle.addTo(map);
  rangeCircle.openTooltip();
}

function renderMarkers() {
  if (!map) return;
  Object.values(mapLayers).forEach((layer) => layer?.clearLayers());

  const pois = state.view === "trip" ? [] : visiblePOIs();
  const anchor = state.view === "food" ? anchorPoint() : null;

  pois.forEach((p) => {
    const small = p.cat === "food" || !!p.partner;
    const marker = L.marker([p.lat, p.lng], {
      icon: pinIcon(p, small),
      title: p.name,
      riseOnHover: true,
      keyboard: true,
    });
    if (!getPOI(p.id)) {
      marker.bindPopup(
        `<strong>${esc(p.name)}</strong><br><span style="color:#68756b">${esc(p.kind || "OSM 店家")}${p.desc ? ` · ${esc(p.desc)}` : ""}</span>`
      );
    } else {
      marker.on("click", () => selectPOI(p.id, { fly: false, openCard: true }));
    }
    marker.addTo(p.partner ? mapLayers.partner : mapLayers.cluster);
  });

  // 探索：OSM 即時搜尋結果（紫色虛線圈，和在地資料區隔）
  const query = state.filters.q.trim();
  if (state.view === "explore" && query.length >= 2
    && state.livePoi.q === query && state.livePoi.items.length) {
    state.livePoi.items.forEach((p) => {
      const marker = L.marker([p.lat, p.lng], {
        icon: L.divIcon({
          className: "poi-marker poi-marker--live",
          html: `<span class="poi-pin poi-pin--live" style="--pin:${catVar(p.cat)}">${svgIcon(CATEGORIES[p.cat]?.icon || "pin")}</span>`,
          iconSize: [32, 32],
          iconAnchor: [16, 32],
          popupAnchor: [0, -30],
        }),
        title: `${p.name}（OSM 搜尋結果）`,
        riseOnHover: true,
        zIndexOffset: 600,
      });
      marker.bindPopup(`<strong>${esc(p.name)}</strong><br><span style="color:#68756b">${esc(p.kind)}${p.region ? ` · ${esc(p.region)}` : ""}</span><br>
        <button type="button" class="mini-btn solid" data-popup-add="${p.id}" style="margin-top:6px">＋ 加入行程</button>`);
      marker.on("popupopen", (e) => {
        e.popup.getElement()?.querySelector("[data-popup-add]")?.addEventListener("click", () => {
          addLivePoi(p.id);
          map.closePopup();
        });
      });
      marker.addTo(mapLayers.cluster);
    });
  }

  if (state.view === "food" && anchor) {
    radiusCircle = radiusCircle || L.circle([anchor.lat, anchor.lng], {
      radius: state.radius * 1000,
      color: "#c8455c",
      weight: 1.5,
      opacity: 0.7,
      fillColor: "#c8455c",
      fillOpacity: 0.06,
      dashArray: "5 6",
      interactive: false,
    });
    radiusCircle.setLatLng([anchor.lat, anchor.lng]);
    radiusCircle.setRadius(state.radius * 1000);
    if (!map.hasLayer(radiusCircle)) radiusCircle.addTo(map);
  } else if (radiusCircle && map.hasLayer(radiusCircle)) {
    map.removeLayer(radiusCircle);
  }

  if (state.view === "ev") {
    updateRangeRing();
  } else if (rangeCircle && map.hasLayer(rangeCircle)) {
    map.removeLayer(rangeCircle);
  }

  if (state.showChargers) {
    CHARGERS.forEach((c) => {
      L.marker([c.lat, c.lng], {
        icon: L.divIcon({
          className: "poi-marker poi-marker--charge",
          html: `<span class="poi-pin" style="--pin:${catVar("car")}">${svgIcon("bolt")}</span>`,
          iconSize: [27, 27],
          iconAnchor: [13, 27],
        }),
        title: `${c.name} · ${c.power} kW`,
        riseOnHover: true,
      }).bindPopup(
        `<strong>${esc(c.name)}</strong><br><span style="color:#68756b">${esc(c.network)} · ${c.power} kW ${c.type}<br>${esc(c.note)}</span>`
      ).addTo(mapLayers.chargers);
    });
    if (!map.hasLayer(mapLayers.chargers)) mapLayers.chargers.addTo(map);
  } else if (map.hasLayer(mapLayers.chargers)) {
    map.removeLayer(mapLayers.chargers);
  }

  renderRoute();
  updateMapCount();
}

function renderRoute() {
  if (!map || !mapLayers.route) return;
  mapLayers.route.clearLayers();
  const start = startPoint();
  const stopItems = stops();
  if (!stopItems.length) {
    L.marker([start.lat, start.lng], {
      icon: L.divIcon({
        className: "stop-marker",
        html: `<span class="stop-marker-inner">起</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
      interactive: false,
    }).addTo(mapLayers.route);
    return;
  }

  const p = plan();
  const coords = [[start.lat, start.lng]];
  const chargeMarkers = [];

  p.legs.forEach((leg) => {
    const midCharge = leg.baseCharge || leg.inRouteCharge;
    if (midCharge && midCharge.charger) {
      coords.push([midCharge.charger.lat, midCharge.charger.lng]);
      chargeMarkers.push(midCharge);
    }
    coords.push([leg.to.lat, leg.to.lng]);
    if (leg.charge && leg.charge.charger) {
      chargeMarkers.push(leg.charge);
    }
  });

  L.polyline(coords, { color: "#ffffff", weight: 8, opacity: 0.7, lineCap: "round" }).addTo(mapLayers.route);
  L.polyline(coords, { color: "#0c2f24", weight: 4.5, opacity: 0.55, lineCap: "round" }).addTo(mapLayers.route);
  L.polyline(coords, { color: "#a8dd4a", weight: 2.5, opacity: 1, dashArray: "8 7", lineCap: "round" }).addTo(mapLayers.route);

  L.marker([start.lat, start.lng], {
    icon: L.divIcon({
      className: "stop-marker",
      html: `<span class="stop-marker-inner">起</span>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    }),
    interactive: false,
  }).addTo(mapLayers.route);

  chargeMarkers.forEach((c) => {
    const label = c.where === "base" ? "山下補電" : c.where === "mid" ? "途中補電" : "目的地補電";
    L.marker([c.charger.lat, c.charger.lng], {
      icon: L.divIcon({
        className: "stop-marker stop-marker--charge",
        html: `<span class="stop-marker-inner">⚡</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      }),
      zIndexOffset: 680,
    })
      .bindPopup(
        `<strong>⚡ ${label}：${esc(c.charger.name)}</strong><br><span style="color:#68756b">${esc(c.charger.network)} · ${c.charger.power} kW ${c.charger.type}（${esc(c.charger.connectors || "CCS1")}）<br>${Math.round(c.from)}% → ${Math.round(c.to)}%（約 ${c.minutes} 分鐘）</span>`
      )
      .addTo(mapLayers.route);
  });

  stopItems.forEach((s, i) => {
    L.marker([s.lat, s.lng], {
      icon: L.divIcon({
        className: "stop-marker",
        html: `<span class="stop-marker-inner">${i + 1}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
      interactive: false,
      zIndexOffset: 700,
    }).addTo(mapLayers.route);
  });
}

function updateMapCount() {
  const n = visiblePOIs().length;
  const label = $("#mapCount");
  if (!label) return;
  if (state.view === "trip") {
    label.innerHTML = `<b>${stops().length}</b> 站行程`;
    return;
  }
  if (state.view === "ev") {
    label.innerHTML = `<b>${Math.round(computeEv(state.ev).usableRange)}</b> km 可用`;
    return;
  }
  label.innerHTML = `<b>${n}</b> 個據點`;
}

function selectPOI(id, opts = {}) {
  const p = getPOI(id);
  if (!p) return;
  state.selectedId = id;
  renderDetail(p);
  if (state.view === "explore") renderMountainHelper();
  renderMarkers();
  syncSelection();
  if (opts.fly !== false) {
    const target = [p.lat, p.lng];
    map?.flyTo(target, Math.max(map.getZoom(), 12), { duration: 0.7 });
  }
}

function syncSelection() {
  $$(".poi-row").forEach((row) => {
    row.classList.toggle("is-selected", row.dataset.id === state.selectedId);
  });
}

function renderDetail(p) {
  const card = $("#poiCard");
  const body = $("#poiCardBody");
  const added = state.itinerary.includes(p.id);
  const isFood = p.cat === "food";
  const facts = [
    p.region,
    p.alt ? `海拔 ${fmtKm(p.alt)} m` : "",
    p.level || p.kind || "",
    ...(p.facts || []),
  ].filter(Boolean);

  const nearbyCarsForHike = p.cat === "hike" && typeof nearbyCarSpots === "function"
    ? nearbyCarSpots(p, 12, partnerPOIs()).slice(0, 3)
    : [];
  const nearbyCarHtml = nearbyCarsForHike.length
    ? `<div class="pc-nearby-cars">
        <div class="pc-nearby-title">🚐 登山口附近可車露／車宿點（不是每個山頭都能直接車宿）：</div>
        ${nearbyCarsForHike.map((c) => {
          const cAdded = state.itinerary.includes(c.id);
          const dTxt = c.dist < 1 ? `${Math.round(c.dist * 1000)} m` : `${c.dist.toFixed(1)} km`;
          return `<div class="pc-nearby-row">
            <span><b>${esc(c.name)}</b> <small>(${dTxt})</small></span>
            <button type="button" class="mini-btn ${cAdded ? "" : "solid"}" data-act="add" data-id="${c.id}" ${cAdded ? "disabled" : ""}>${cAdded ? "已加入" : "＋ 車露"}</button>
          </div>`;
        }).join("")}
      </div>`
    : "";

  body.innerHTML = `
    <div class="pc-head">
      <span class="pc-icon" style="--c:${catVar(p.cat)}">${svgIcon(CATEGORIES[p.cat]?.icon || "pin")}</span>
      <div>
        <strong>${esc(p.name)}</strong>
        <span>${catLabel(p.cat)}${p.rating ? ` · ★ ${Number(p.rating).toFixed(1)}` : ""}${p.price ? ` · ${esc(p.price)}` : ""}</span>
      </div>
    </div>
    <div class="pc-facts">${facts.slice(0, 4).map((f) => `<span>${esc(f)}</span>`).join("")}</div>
    <p class="pc-desc">${esc(p.desc || "")}</p>
    ${p.note ? `<p class="pc-note">注意：${esc(p.note)}</p>` : ""}
    ${nearbyCarHtml}
    <div class="pc-actions">
      <button type="button" class="mini-btn ${added ? "" : "solid"}" data-act="add" data-id="${p.id}" ${added ? "disabled" : ""}>${added ? "已在行程中" : "＋ 加入行程"}</button>
      ${isFood ? "" : `<button type="button" class="mini-btn" data-act="nearby" data-id="${p.id}">附近美食</button>`}
      <a class="mini-btn" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving" target="_blank" rel="noopener" style="text-align:center;line-height:26px">導航</a>
    </div>
  `;
  card.hidden = false;
}

function closeDetail(clearSelection = true) {
  $("#poiCard").hidden = true;
  if (clearSelection) {
    state.selectedId = null;
    syncSelection();
  }
}

function fitRoute() {
  if (!map) return;
  const pts = [startPoint(), ...stops()];
  if (!pts.length) return;
  if (pts.length === 1) { map.flyTo([pts[0].lat, pts[0].lng], 12); return; }
  const bounds = L.latLngBounds(pts.map((p) => [p.lat, p.lng]));
  map.flyToBounds(bounds, { padding: [48, 48], maxZoom: 12, duration: 0.7 });
}

function fitAll() {
  if (!map) return;
  const list = filteredPOIs();
  if (!list.length) return;
  const bounds = L.latLngBounds(list.map((p) => [p.lat, p.lng]));
  map.flyToBounds(bounds, { padding: [40, 40], maxZoom: 10, duration: 0.7 });
}

/* ---------------- 檢視切換 ---------------- */
function fitFood() {
  if (!map) return;
  const a = anchorPoint();
  if (!a) return;
  const pts = [a, ...currentFoodResults()].filter((p) => p && Number.isFinite(p.lat));
  if (pts.length > 1) {
    map.flyToBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), {
      padding: [46, 46],
      maxZoom: 12,
      duration: 0.6,
    });
  } else {
    map.flyTo([a.lat, a.lng], 11, { duration: 0.6 });
  }
}

function switchView(view) {
  state.view = view;
  $$(".tab").forEach((tab) => {
    const on = tab.dataset.view === view;
    tab.classList.toggle("is-active", on);
    tab.setAttribute("aria-selected", String(on));
  });
  $$(".view").forEach((el) => {
    el.hidden = el.id !== `panel-${view}`;
  });
  $("#panelBody").scrollTop = 0;

  if (view === "trip") {
    renderTrip();
    fitRoute();
  }
  if (view === "food") {
    renderFood();
    renderMarkers();
    fitFood();
  }
  if (view === "ev") {
    renderEvPanel();
    renderMarkers();
    const narrow = window.matchMedia("(max-width: 760px)").matches;
    if (narrow) {
      const sp = startPoint();
      map?.flyTo([sp.lat, sp.lng], 8, { duration: 0.7 });
    } else {
      map?.flyTo([23.74, 120.96], 8, { duration: 0.7 });
    }
  }
  if (view === "explore") {
    renderMarkers();
  }
}

function updateTop() {
  const calc = computeEv(state.ev);
  const pillName = $("#evPillName");
  if (pillName) pillName.textContent = calc.vehicle.name;
  $("#evPillRange").textContent = `可用里程 ${Math.round(calc.usableRange)} km`;
  const n = state.itinerary.length;
  const badge = $("#tripBadge");
  badge.hidden = n === 0;
  badge.textContent = String(n);
}

/* ---------------- 行程操作 ---------------- */
function addStop(id) {
  if (!id) return;
  if (state.itinerary.includes(id)) { toast("這個據點已經在行程裡了"); return; }
  state.itinerary.push(id);
  state.selectedId = id;
  const poi = getPOI(id);
  if (poi && (poi.cat === "car" || poi.cat === "camp")) {
    const suggested = typeof suggestedDestReserve === "function" ? suggestedDestReserve(poi) : 30;
    if (!state.ev.destReserve || state.ev.destReserve < suggested) {
      state.ev.destReserve = suggested;
    }
  }
  persist();
  refreshAll();
  toast(`已加入「${poi?.name || ""}」`);
  // 若加入的是車宿或露營點，主動彈出視窗詢問預計在車宿點留多少電，並顯示山下補電試算
  if (poi && (poi.cat === "car" || poi.cat === "camp") && typeof openReserveModal === "function") {
    openReserveModal(id);
  }
}

function removeStop(id) {
  state.itinerary = state.itinerary.filter((x) => x !== id);
  persist();
  refreshAll();
  toast("已從行程移除");
}

function moveStop(id, dir) {
  const i = state.itinerary.indexOf(id);
  if (i < 0) return;
  const j = i + dir;
  if (j < 0 || j >= state.itinerary.length) return;
  [state.itinerary[i], state.itinerary[j]] = [state.itinerary[j], state.itinerary[i]];
  persist();
  refreshAll();
}

function setAnchorAndFood(id) {
  if (!id) return;
  state.anchorId = id;
  state.liveFood = [];
  persist();
  switchView("food");
  renderFood();
  renderMarkers();
  const p = getPOI(id);
  if (p) map?.flyTo([p.lat, p.lng], 11, { duration: 0.6 });
}

/* ---------------- OSRM ---------------- */
async function refineOsrm() {
  const list = stops();
  if (!list.length) { toast("先加入至少一個站點"); return; }
  const btn = $("#osrmBtn");
  const status = $("#osrmStatus");
  btn.classList.add("is-busy");
  btn.innerHTML = "取得道路里程…";
  status.hidden = false;
  status.dataset.tone = "";
  status.textContent = "正在向 OSRM 取得實際道路里程，若伺服器忙碌會自動保留估算值。";

  const chain = [startPoint(), ...list];
  let ok = 0;
  let fail = 0;

  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1];
    const b = chain[i];
    const key = legKey(a, b);
    if (state.osrm[key]) { ok++; continue; }
    const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false&alternatives=false&steps=false`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(9000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const route = data.routes?.[0];
      if (!route) throw new Error("no route");
      const est = estimateLeg(a, b);
      state.osrm[key] = {
        km: Math.round((route.distance / 1000) * 10) / 10,
        climb: est.climb,
        minutes: Math.round((route.duration / 60) * 10) / 10,
      };
      ok++;
    } catch (err) {
      fail++;
    }
  }

  persist();
  btn.classList.remove("is-busy");
  btn.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 19V6.5A2.5 2.5 0 0 1 6.5 4H18l-3 4 3 4H6.5"/></svg>重新取得道路里程`;
  if (ok && !fail) {
    status.dataset.tone = "";
    status.textContent = `已更新 ${ok} 段實際道路里程；爬升仍以據點海拔估算。`;
    toast("道路里程已更新");
  } else if (ok && fail) {
    status.dataset.tone = "warn";
    status.textContent = `更新 ${ok} 段，${fail} 段失敗並保留估算值。`;
  } else {
    status.dataset.tone = "warn";
    status.textContent = "OSRM 目前無法連線，已保留原本的里程估算。";
    toast("無法連線 OSRM，保留估算值");
  }
  refreshAll();
}

/* ---------------- 儲存與匯出 ---------------- */
function readSaved() {
  try {
    const raw = localStorage.getItem(SAVED_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (err) { return []; }
}

function writeSaved(list) {
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(list)); } catch (err) { /* ignore */ }
}

function saveCurrent() {
  if (!state.itinerary.length) { toast("行程還是空的，先加入一兩個據點吧"); return; }
  const list = readSaved();
  const name = window.prompt("為這趟行程取個名字", list.length ? "我的野電小旅行" : "合歡山星空車泊");
  if (!name) return;
  const item = {
    id: `trip-${Date.now()}`,
    name: name.trim().slice(0, 40) || "未命名行程",
    createdAt: new Date().toISOString(),
    startId: state.startId,
    startCustom: state.startCustom,
    itinerary: [...state.itinerary],
    stopDays: { ...state.stopDays },
    custom: state.custom.filter((p) => state.itinerary.includes(p.id)),
    ev: { ...state.ev },
  };
  list.unshift(item);
  writeSaved(list.slice(0, 20));
  refreshAll();
  toast(`已儲存「${item.name}」`);
}

function loadSaved(id) {
  const item = readSaved().find((x) => x.id === id);
  if (!item) return;
  state.startId = item.startId || "taipei";
  state.startCustom = item.startCustom || null;
  if (Array.isArray(item.custom)) {
    item.custom.forEach((p) => {
      if (p && p.id && !getPOI(p.id)) state.custom.push(p);
    });
  }
  state.itinerary = (item.itinerary || []).filter((x) => getPOI(x));
  state.stopDays = item.stopDays && typeof item.stopDays === "object" ? { ...item.stopDays } : {};
  if (item.ev) {
    const base = typeof defaultEv === "function" ? defaultEv() : { ...EV_DEFAULTS };
    state.ev = { ...base, ...item.ev };
    if (!Array.isArray(state.ev.vehicles) || !state.ev.vehicles.length) state.ev.vehicles = base.vehicles;
  }
  state.osrm = {};
  persist();
  switchView("trip");
  refreshAll();
  toast(`已載入「${item.name}」`);
}

function deleteSaved(id) {
  writeSaved(readSaved().filter((x) => x.id !== id));
  refreshAll();
  toast("已刪除儲存行程");
}

function exportTrip() {
  const list = stops();
  if (!list.length) { toast("沒有行程可以匯出"); return; }
  const p = plan();
  const data = {
    app: "WildVolt 野電計畫",
    exportedAt: new Date().toISOString(),
    start: startPoint(),
    stops: list.map((s) => ({
      id: s.id, name: s.name, cat: s.cat, lat: s.lat, lng: s.lng, alt: s.alt,
      route: s.route || null,
    })),
    ev: state.ev,
    estimate: {
      totalKm: Math.round(p.totalKm * 10) / 10,
      totalClimb: p.totalClimb,
      totalEnergyKwh: Math.round(p.totalEnergy * 10) / 10,
      finalSoc: Math.round(p.finalSoc),
      chargeStops: p.charges.length,
      driveMinutes: Math.round(p.totalMinutes),
    },
    legs: p.legs.map((l) => ({
      from: l.from.name, to: l.to.name,
      km: Math.round(l.km * 10) / 10,
      climb: l.climb,
      arriveSoc: Math.round(l.arriveSoc),
      energyKwh: Math.round(l.energy * 10) / 10,
    })),
    charges: p.charges.map((c) => ({
      at: c.at.name, charger: c.charger.name, where: c.where,
      fromSoc: Math.round(c.from), toSoc: Math.round(c.to), minutes: c.minutes,
    })),
    basePlans: (p.basePlans || []).map((b) => ({
      at: b.at.name, charger: b.charger.name, needed: b.needed,
      fromSoc: b.from, toSoc: b.to, minutes: b.minutes,
      arriveIfCharged: Math.round(b.arriveIfCharged),
      arriveIfNotCharged: Math.round(b.arriveIfNotCharged),
    })),
    warnings: p.warnings.map((w) => w.text),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `wildvolt-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast("已下載 JSON 行程檔");
}

/* ---------------- 全域刷新 ---------------- */
function refreshAll() {
  updateTop();
  renderExplore();
  renderTrip();
  if (state.view === "food") renderFood();
  renderMarkers();
  renderEvOutputs();
}

/* ---------------- 事件 ---------------- */
function wireEvents() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchView(tab.dataset.view));
  });

  $("#evPill").addEventListener("click", () => switchView("ev"));

  $("#catChips").addEventListener("click", (e) => {
    const partnerBtn = e.target.closest("[data-partner]");
    if (partnerBtn) {
      state.filters.partner = !state.filters.partner;
      renderExplore();
      renderMarkers();
      return;
    }
    const btn = e.target.closest("[data-cat]");
    if (!btn) return;
    const cat = btn.dataset.cat;
    const on = state.filters.cats.includes(cat);
    state.filters.cats = on
      ? state.filters.cats.filter((c) => c !== cat)
      : [...state.filters.cats, cat];
    renderCatChips();
    renderExplore();
    renderMarkers();
  });

  const partnerKinds = $("#partnerKinds");
  if (partnerKinds) {
    partnerKinds.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-pkind]");
      if (!btn) return;
      state.filters.partnerKind = btn.dataset.pkind;
      renderExplore();
      renderMarkers();
    });
  }

  $("#poiList").addEventListener("click", (e) => {
    const action = e.target.closest("[data-act]");
    if (action) {
      e.stopPropagation();
      if (action.dataset.act === "add") addStop(action.dataset.id);
      if (action.dataset.act === "nearby") setAnchorAndFood(action.dataset.id);
      if (action.dataset.act === "more") {
        state.exploreLimit += 40;
        renderExplore();
      }
      return;
    }
    const row = e.target.closest(".poi-row");
    if (row) selectPOI(row.dataset.id);
  });

  $("#poiList").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".poi-row");
    if (row) { e.preventDefault(); selectPOI(row.dataset.id); }
  });

  const mhWrap = $("#mountainHelperWrap");
  if (mhWrap) {
    mhWrap.addEventListener("click", (e) => {
      const liveBtn = e.target.closest("[data-live-add]");
      if (liveBtn) { addLivePoi(liveBtn.dataset.liveAdd); return; }
      const addBtn = e.target.closest("[data-mh-add]");
      if (addBtn) {
        e.stopPropagation();
        addStop(addBtn.dataset.mhAdd);
        return;
      }
      const comboBtn = e.target.closest("[data-mh-combo]");
      if (comboBtn) {
        e.stopPropagation();
        const [mId, cId] = String(comboBtn.dataset.mhCombo || "").split("|");
        if (mId && !state.itinerary.includes(mId)) state.itinerary.push(mId);
        if (cId) addStop(cId);
        else { persist(); refreshAll(); }
        return;
      }
      const focusEl = e.target.closest("[data-mh-focus]");
      if (focusEl && focusEl.dataset.mhFocus) {
        selectPOI(focusEl.dataset.mhFocus);
      }
    });
  }

  const liveWrap = $("#livePoiWrap");
  if (liveWrap) {
    liveWrap.addEventListener("click", (e) => {
      const add = e.target.closest("[data-live-add]");
      if (add) { addLivePoi(add.dataset.liveAdd); return; }
      if (e.target.closest("[data-live-retry]")) {
        searchPlacesOnline(state.filters.q, { force: true });
      }
    });
  }

  $("#searchInput").addEventListener("input", debounce((e) => {
    state.filters.q = e.target.value;
    renderExplore();
    renderMarkers();
    scheduleLivePoiSearch(state.filters.q);
  }, 120));

  $("#regionSelect").addEventListener("change", (e) => {
    state.filters.region = e.target.value;
    renderExplore();
    renderMarkers();
  });

  $("#sortSelect").addEventListener("change", (e) => {
    state.filters.sort = e.target.value;
    renderExplore();
    renderMarkers();
  });

  $("#fitAllBtn").addEventListener("click", fitAll);

  $("#startSelect").addEventListener("change", (e) => {
    if (e.target.value === "__geo__") return;
    state.startId = e.target.value;
    state.startCustom = null;
    state.osrm = {};
    persist();
    refreshAll();
    toast(`出發地改為「${startPoint().name}」`);
  });

  $("#locateBtn").addEventListener("click", () => {
    if (!navigator.geolocation) { toast("瀏覽器不支援定位"); return; }
    toast("正在取得目前位置…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.startCustom = {
          id: "geo",
          name: "目前位置",
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          alt: 0,
        };
        state.startId = "geo";
        state.osrm = {};
        persist();
        refreshAll();
        toast("已將出發地設為目前位置");
      },
      () => toast("無法取得位置，請確認瀏覽器定位權限"),
      { enableHighAccuracy: true, timeout: 9000 }
    );
  });

  $("#sampleTrips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-sample]");
    if (!btn) return;
    const sample = SAMPLE_TRIPS.find((s) => s.id === btn.dataset.sample);
    if (!sample) return;
    // 範例可以自帶出發地／終點預留電量／山下補電模式（例如雲林→隙頂車宿）
    if (sample.startId && STARTS.some((s) => s.id === sample.startId)) {
      state.startId = sample.startId;
      state.startCustom = null;
      const startSel = $("#startSelect");
      if (startSel) startSel.value = sample.startId;
    }
    if (Number.isFinite(Number(sample.destReserve))) {
      state.ev.destReserve = clamp(Number(sample.destReserve), 10, 60);
    }
    if (sample.baseChargeMode) state.ev.baseChargeMode = sample.baseChargeMode;
    if (sample.routeMode) state.ev.routeMode = sample.routeMode;
    if (Number.isFinite(Number(sample.tripDays))) state.ev.tripDays = clamp(Number(sample.tripDays), 1, 7);
    if (typeof sample.returnTrip === "boolean") state.ev.returnTrip = sample.returnTrip;
    if (typeof sample.overnightMode === "string") state.ev.overnightMode = sample.overnightMode;
    state.ev.baseChargerId = "";
    state.ev.highwayChargeId = "";
    state.stopDays = sample.stopDays && typeof sample.stopDays === "object" ? { ...sample.stopDays } : {};
    state.itinerary = [...sample.stops];
    state.osrm = {};
    persist();
    switchView("trip");
    refreshAll();
    toast(`已載入範例：${sample.name}`);
    const lastId = sample.stops[sample.stops.length - 1];
    const lastPoi = getPOI(lastId);
    if (lastPoi && (lastPoi.cat === "car" || lastPoi.cat === "camp") && typeof openReserveModal === "function") {
      openReserveModal(lastId);
    }
  });

  $("#stopList").addEventListener("click", (e) => {
    const tool = e.target.closest("[data-tool]");
    if (!tool) return;
    const id = tool.dataset.id;
    if (tool.dataset.tool === "up") moveStop(id, -1);
    if (tool.dataset.tool === "down") moveStop(id, 1);
    if (tool.dataset.tool === "remove") removeStop(id);
    if (tool.dataset.tool === "focus") selectPOI(id);
  });

  $("#poiCardBody").addEventListener("click", (e) => {
    const act = e.target.closest("[data-act]");
    if (!act) return;
    if (act.dataset.act === "add") addStop(act.dataset.id);
    if (act.dataset.act === "nearby") setAnchorAndFood(act.dataset.id);
  });

  $("#poiCardClose").addEventListener("click", () => closeDetail());

  $("#osrmBtn").addEventListener("click", refineOsrm);
  $("#exportBtn").addEventListener("click", exportTrip);
  const clearTrip = () => {
    if (!state.itinerary.length) { toast("行程已經是空的"); return; }
    if (!window.confirm("確定清空目前行程？")) return;
    state.itinerary = [];
    state.stopDays = {};
    state.osrm = {};
    state.selectedId = null;
    if (state.ev) state.ev.highwayChargeId = "";
    persist();
    refreshAll();
    toast("行程已清空");
  };
  $("#clearBtn").addEventListener("click", clearTrip);
  $("#clearBtn2")?.addEventListener("click", clearTrip);

  $("#printBtn").addEventListener("click", () => window.print());
  $("#saveBtn").addEventListener("click", saveCurrent);
  $("#saveBtn2").addEventListener("click", saveCurrent);

  $("#helpBtn").addEventListener("click", () => {
    lastFocusedEl = document.activeElement;
    $("#helpModal").hidden = false;
    $("#helpOk").focus();
  });
  $("#helpClose").addEventListener("click", closeHelp);
  $("#helpOk").addEventListener("click", closeHelp);
  $("#helpModal").addEventListener("click", (e) => {
    if (e.target === $("#helpModal")) closeHelp();
  });

  $("#foodAnchor").addEventListener("change", (e) => {
    state.anchorId = e.target.value;
    state.liveFood = [];
    persist();
    renderFood();
    renderMarkers();
    fitFood();
  });

  $("#radiusChips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-radius]");
    if (!btn) return;
    state.radius = Number(btn.dataset.radius);
    persist();
    renderFood();
    renderMarkers();
    fitFood();
  });

  $("#kindChips").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-kind]");
    if (!btn) return;
    const kind = btn.dataset.kind;
    state.foodKinds = state.foodKinds.includes(kind)
      ? state.foodKinds.filter((k) => k !== kind)
      : [...state.foodKinds, kind];
    renderFood();
  });

  $("#foodList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act='add-food']");
    if (!btn) return;
    const idx = Number(btn.dataset.food);
    const results = currentFoodResults();
    const item = results[idx];
    if (!item) return;
    if (!item.id) return;
    addStop(item.id);
  });

  $("#liveFoodBtn").addEventListener("click", fetchLiveFood);

  $("#terrainBtn").addEventListener("click", () => {
    state.terrain = !state.terrain;
    $("#terrainBtn").setAttribute("aria-pressed", String(state.terrain));
    if (!map) return;
    if (state.terrain) {
      map.removeLayer(baseStreet);
      baseTerrain.addTo(map);
    } else {
      map.removeLayer(baseTerrain);
      baseStreet.addTo(map);
    }
  });

  $("#chargerBtn").addEventListener("click", () => {
    state.showChargers = !state.showChargers;
    $("#chargerBtn").setAttribute("aria-pressed", String(state.showChargers));
    renderMarkers();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$("#helpModal").hidden) closeHelp();
      else if (!$("#poiCard").hidden) closeDetail();
    }
    if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      switchView("explore");
      $("#searchInput").focus();
    }
  });
}

function closeHelp() {
  $("#helpModal").hidden = true;
  lastFocusedEl?.focus?.();
}

/* ---------------- 靜態 UI ---------------- */
function buildStaticUI() {
  $("#startSelect").innerHTML = STARTS.map((s) =>
    `<option value="${s.id}" ${state.startId === s.id ? "selected" : ""}>${s.name}</option>`
  ).join("") + (state.startCustom
    ? `<option value="geo" ${state.startId === "geo" ? "selected" : ""}>目前位置</option>`
    : "");

  $("#regionSelect").innerHTML = ["all", "北部", "中部", "南部", "東部"].map((r) =>
    `<option value="${r}" ${state.filters.region === r ? "selected" : ""}>${r === "all" ? "全台灣" : r}</option>`
  ).join("");

  $("#sampleTrips").innerHTML = SAMPLE_TRIPS.map((s) =>
    `<button type="button" class="sample-chip" data-sample="${s.id}">
      <strong>${esc(s.name)}</strong><span>${esc(s.meta)}</span>
    </button>`
  ).join("");

  $("#dataNote").textContent = DATA_DISCLAIMER;
}

/* ---------------- 啟動 ---------------- */
function init() {
  loadState();
  buildStaticUI();
  renderEvPanel();
  initMap();
  wireEvents();
  refreshAll();
  if (state.itinerary.length) switchView("trip");
  else switchView("explore");
  if (state.startCustom) {
    const sel = $("#startSelect");
    if (![...sel.options].some((o) => o.value === "geo")) {
      sel.insertAdjacentHTML("beforeend", `<option value="geo" selected>目前位置</option>`);
    }
  }
}

document.addEventListener("DOMContentLoaded", init);
