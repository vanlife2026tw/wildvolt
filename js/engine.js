/* =========================================================
   野電計畫 WildVolt — 里程與行程計算引擎
   （純函式，方便日後抽換成真實路徑 API）
   ========================================================= */

"use strict";

const EV_DEFAULTS = {
  vehicleId: "veh-n7s",
  startSoc: 90,
  reserve: 10,
  destReserve: 30,
  // 山下補電模式：auto＝智能規劃（預設）、always＝強制山下補滿、need＝只在到不了預留電量時補、off＝不預排山下補電
  baseChargeMode: "auto",
  baseChargerId: "",
  // 走法：auto＝自動估算（預設）、nh1＝國道一號、nh3＝國道三號、local＝一般道路
  routeMode: "auto",
  // 使用者在國道沿途服務區清單手動選的補電點（充電站 id），空字串＝自動
  highwayChargeId: "",
  // 出遊天數（1–7）與是否加入回程（最後回到出發地）
  tripDays: 1,
  returnTrip: false,
  // 過夜休息電力模式：camp-ac＝車宿開冷暖氣／露營模式（每晚約耗 10%）、
  // no-drain＝純休息不耗電、camp-charge＝營地接電慢充補滿至 95%
  overnightMode: "camp-ac",
  temp: 24,
  ac: "mid",
  load: "duo",
  drive: "mixed",
  weather: "sunny",
};

/**
 * 正規化一台車：
 * 核心五欄位：車子型號（name）、可行駛總里程（range, km）、
 * 平常道路每度電幾公里（road, km/kWh）、高速每度電幾公里（highway, km/kWh）、爬坡每度電幾公里（climb, km/kWh）。
 * 電池可用容量（capacity, kWh）若未填或自動推算，由「可行駛總里程 ÷ 平常道路每度電公里數」算出。
 */
function normalizeVehicle(v, i = 0) {
  const num = (x, d, min, max) => clamp(Number(x) || d, min, max);
  const road = num(v?.road, 6.7, 1.5, 15);
  const highway = num(v?.highway, 3.1, 1.5, 15);
  const climb = num(v?.climb, 2.9, 1.2, 15);
  const hasCap = Number.isFinite(Number(v?.capacity)) && Number(v?.capacity) > 0;
  const capacity = hasCap
    ? num(v.capacity, 57, 10, 200)
    : (Number.isFinite(Number(v?.range)) && Number(v?.range) > 0
      ? Math.round((Number(v.range) / road) * 10) / 10
      : 57);
  const defaultRange = Math.round(capacity * road);
  const range = num(v?.range, defaultRange, 50, 1000);
  return {
    id: String(v?.id || `veh-${Date.now()}-${i}`),
    name: String(v?.name || "未命名車款").slice(0, 40),
    capacity,
    range,
    road,
    highway,
    climb,
    connector: String(v?.connector || "CCS1").slice(0, 20),
  };
}

/** 車庫清單（正規化後）；沒有車庫資料就退回預設車庫 */
function vehicleList(ev) {
  const fallback = typeof DEFAULT_VEHICLES !== "undefined" ? DEFAULT_VEHICLES : [];
  const raw = Array.isArray(ev?.vehicles) && ev.vehicles.length ? ev.vehicles : fallback;
  return raw.map((v, i) => normalizeVehicle(v, i));
}

/** 取得一份乾淨的預設電動車設定（避免車庫陣列被共用） */
function defaultEv() {
  return {
    ...EV_DEFAULTS,
    vehicles: vehicleList(null),
  };
}

/** 目前選用的車輛；找不到就退回車庫第一台 */
function activeVehicle(ev) {
  const list = vehicleList(ev);
  return list.find((v) => v.id === ev?.vehicleId) || list[0] || normalizeVehicle({});
}

/**
 * 標示總里程與平常道路電耗對照：
 * 推算可用電池容量 ＝ 可行駛總里程 ÷ 平常道路 km/kWh。
 */
function vehicleRangeCheck(vehicle) {
  const impliedCap = Math.round((vehicle.range / vehicle.road) * 10) / 10;
  const computed = Math.round(vehicle.capacity * vehicle.road);
  const diffPct = vehicle.range
    ? Math.round(((computed - vehicle.range) / vehicle.range) * 100)
    : 0;
  return {
    computed,
    stated: vehicle.range,
    impliedCap,
    diffPct,
    ok: Math.abs(diffPct) <= 15,
  };
}

/** 建議的終點預留電量：高山車宿／露營建議留 30%～40%，一般過夜留 25%，一般終點留 20% */
function suggestedDestReserve(stop) {
  if (!stop) return 20;
  const overnight = stop.cat === "camp" || stop.cat === "car";
  const alt = Number(stop.alt) || 0;
  if (overnight && alt >= 1000) return 30;
  if (overnight && alt >= 500) return 30;
  if (overnight) return 25;
  return 20;
}

const AC_FACTORS = { off: 1.0, low: 0.995, mid: 0.96, high: 0.91 };
const LOAD_FACTORS = { solo: 1.0, duo: 0.985, full: 0.94, gear: 0.88 };
const WEATHER_FACTORS = { sunny: 1.0, rain: 0.95, wind: 0.92 };
const DRIVE_SPEEDS = { city: 28, mixed: 46, highway: 72, mountain: 30 };

/** 爬坡路段佔比：以每公里爬升 52 m 估計，最多佔該段 90% */
const CLIMB_SHARE_PER_M = 1 / 52;

const TEMP_TABLE = [
  [-10, 0.68], [0, 0.72], [5, 0.79], [10, 0.85], [15, 0.9],
  [20, 0.95], [26, 1.0], [30, 0.99], [35, 0.95], [40, 0.9],
];

function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

function haversine(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function tempFactor(t) {
  if (t <= TEMP_TABLE[0][0]) return TEMP_TABLE[0][1];
  for (let i = 1; i < TEMP_TABLE.length; i++) {
    const [x1, y1] = TEMP_TABLE[i - 1];
    const [x2, y2] = TEMP_TABLE[i];
    if (t <= x2) return y1 + ((t - x1) / (x2 - x1)) * (y2 - y1);
  }
  return TEMP_TABLE[TEMP_TABLE.length - 1][1];
}

/**
 * 估算兩點間的道路里程與爬升。
 * 依目的地海拔決定道路係數：平地 1.26、山區 1.5、高山 1.58。
 * 回傳 { km, climb, mountain }。
 */
function estimateLeg(a, b) {
  const straight = haversine(a, b);
  const altA = Number(a.alt) || 0;
  const altB = Number(b.alt) || 0;
  const climb = Math.max(0, altB - altA);
  const high = Math.max(altA, altB);
  let factor = 1.26;
  if (high > 1200 || climb > 400 || b.cat === "hike") factor = 1.5;
  if (high > 2000) factor = 1.58;
  return {
    km: Math.max(2, straight * factor),
    climb,
    mountain: factor > 1.3,
  };
}

/**
 * 由車輛資料算出各種路況的實際 km/kWh 與有效滿電里程。
 * 直接以「可行駛總里程（range）」與「平常道路／高速／爬坡（km/kWh）」計算：
 *  - 有效滿電里程 fullRange ＝ 可行駛總里程 × 環境打折係數 mult
 *  - 有效電池容量 capacity ＝ 可行駛總里程 ÷ 平常道路 km/kWh（確保總里程與三種路況電耗完全連動）
 */
function computeEv(ev) {
  const vehicle = activeVehicle(ev);
  const factors = {
    temp: tempFactor(clamp(Number(ev.temp) || 0, -10, 40)),
    ac: AC_FACTORS[ev.ac] ?? AC_FACTORS.mid,
    load: LOAD_FACTORS[ev.load] ?? LOAD_FACTORS.duo,
    weather: WEATHER_FACTORS[ev.weather] ?? WEATHER_FACTORS.sunny,
  };
  const mult = factors.temp * factors.ac * factors.load * factors.weather;
  const baseRoad = Math.max(1.5, Number(vehicle.road) || 6.7);
  const baseHighway = Math.max(1.5, Number(vehicle.highway) || 3.1);
  const baseClimb = Math.max(1.2, Number(vehicle.climb) || 2.9);
  const capacity = Math.max(10, Number(vehicle.capacity) || 57);
  // 100% 滿電（例如 57 度電）在三種路況下的理論滿電里程（未計氣溫／空調／載重折扣）
  const idealRanges = {
    road: capacity * baseRoad,
    highway: capacity * baseHighway,
    climb: capacity * baseClimb,
  };
  const kmPerKwh = {
    road: Math.max(1.2, baseRoad * mult),
    highway: Math.max(1.2, baseHighway * mult),
    climb: Math.max(1.0, baseClimb * mult),
  };
  // 納入氣溫／空調／載重／天候後的 100% 滿電實際里程
  const fullRanges = {
    road: capacity * kmPerKwh.road,
    highway: capacity * kmPerKwh.highway,
    climb: capacity * kmPerKwh.climb,
  };
  const startSoc = clamp(Number(ev.startSoc) || 0, 0, 100);
  const reserve = clamp(Number(ev.reserve) || 0, 0, 40);
  const usableRatio = Math.max(0, (startSoc - reserve) / 100);
  const usableKwh = capacity * usableRatio;
  const fullRange = fullRanges.road;
  const usableRange = fullRange * usableRatio;
  const usableRanges = {
    road: fullRanges.road * usableRatio,
    highway: fullRanges.highway * usableRatio,
    climb: fullRanges.climb * usableRatio,
  };
  return {
    vehicle,
    rangeCheck: vehicleRangeCheck(vehicle),
    factors,
    mult,
    fullRange,
    usableRange,
    idealRanges,
    fullRanges,
    usableRanges,
    usableKwh,
    kmPerKwh,
    capacity,
    startSoc,
    reserve,
    kwhPer100: 100 / kmPerKwh.road,
  };
}

/**
 * 把一段路拆成「平常道路（roadKm）」、「高速道路（highwayKm）」與「爬坡山路（climbKm）」。
 * climb 是累積爬升（公尺），每公里爬升 52 m 視為爬坡路段。
 * 平路部分再依行車型態（drive）與距離自動分配高速與一般道路比例。
 */
function splitRoadTypes(km, climb, drive = "mixed") {
  const c = Math.max(0, Number(climb) || 0);
  const k = Math.max(0, Number(km) || 0);
  const climbKm = Math.min(k * 0.9, c * CLIMB_SHARE_PER_M);
  const flatKm = Math.max(0, k - climbKm);

  let hwRatio = 0;
  if (drive === "highway") {
    hwRatio = 0.8;
  } else if (drive === "city" || drive === "mountain") {
    hwRatio = 0;
  } else {
    // 混合模式：依平路距離智能估算國道／快速道路佔比（例如雲林→嘉義中埔走國3約佔 65%）
    if (flatKm >= 22) hwRatio = 0.65;
    else if (flatKm >= 10) hwRatio = 0.45;
    else hwRatio = 0.15;
  }

  const highwayKm = flatKm * hwRatio;
  const roadKm = Math.max(0, flatKm - highwayKm);
  return { roadKm, highwayKm, climbKm, flatKm };
}

/** 相容舊呼叫：拆成平路＋爬坡 */
function splitClimb(km, climb) {
  const { flatKm, climbKm } = splitRoadTypes(km, climb, "mixed");
  return { flatKm, climbKm };
}

/**
 * 單段詳細耗電明細（分別以平常道路、高速、爬坡三種 km/kWh 計算度數）
 */
function legEnergyDetail(km, climb, kmPerKwh, drive = "mixed") {
  const { roadKm, highwayKm, climbKm } = splitRoadTypes(km, climb, drive);
  const roadKwh = roadKm / kmPerKwh.road;
  const highwayKwh = highwayKm / kmPerKwh.highway;
  const climbKwh = climbKm / kmPerKwh.climb;
  const energy = roadKwh + highwayKwh + climbKwh;
  return {
    energy,
    roadKm,
    highwayKm,
    climbKm,
    roadKwh,
    highwayKwh,
    climbKwh,
  };
}

/** 單段耗電（kWh） */
function legEnergy(km, climb, kmPerKwh, drive = "mixed") {
  return legEnergyDetail(km, climb, kmPerKwh, drive).energy;
}

/**
 * 補電點以「目前選用車輛的接頭」為主：n⁷ 是 CCS1 快充／J1772 慢充，
 * 所以預設只推 CCS1／J1772 站點。其他車款（例如 CCS2）則對應自己的接頭。
 */
function isVehicleCompatible(charger, vehicle) {
  if (!charger) return false;
  const conn = String(vehicle?.connector || "CCS1").toUpperCase();
  const text = String(charger.connectors || charger.note || "").toUpperCase();
  if (text.includes(conn)) return true;
  if (conn === "CCS1" && /J1772/.test(text)) return true;
  if (charger.n7 && conn === "CCS1") return true;
  return false;
}

/** n⁷ 可用的接頭（CCS1 快充 / J1772 慢充） */
function isN7Compatible(charger) {
  return isVehicleCompatible(charger, { connector: "CCS1" });
}

/**
 * 找最近充電點：N7／該車接頭相容的站點優先（分數直接 -30 km 權重）
 */
function nearestCharger(point, chargers, maxKm = 25, vehicle = null) {
  let best = null;
  const list = chargers || (typeof CHARGERS !== "undefined" ? CHARGERS : []);
  for (const c of list) {
    const d = haversine(point, c);
    if (d > maxKm) continue;
    const ok = isVehicleCompatible(c, vehicle);
    const score = d + (c.type === "DC" ? 0 : 12) + (c.power >= 100 ? 0 : 2) + (ok ? 0 : 30);
    if (!best || score < best.score) best = { charger: c, dist: d, score, n7: ok };
  }
  return best;
}

function nearestDC(point, chargers, maxKm = 70, vehicle = null) {
  let best = null;
  for (const c of chargers || []) {
    if (c.type !== "DC") continue;
    const d = haversine(point, c);
    if (d > maxKm) continue;
    const ok = isVehicleCompatible(c, vehicle);
    const score = d + (ok ? 0 : 30);
    if (!best || score < best.score) best = { charger: c, dist: d, score, n7: ok };
  }
  return best;
}

/**
 * 目的地「山上」有沒有快充：只算跟目的地同海拔帶（海拔差 250 m 內）的 DC 站。
 */
function nearestMountainDC(point, chargers, vehicle = null) {
  const destAlt = Number(point.alt) || 0;
  let best = null;
  for (const c of chargers || []) {
    if (c.type !== "DC") continue;
    // 高山地區僅採信已驗證的高功率快充站，避免把山區小功率充電樁誤判為超充而略過山下補電
    if (destAlt >= 600 && (!c.verified || c.power < 120)) continue;
    if (!isVehicleCompatible(c, vehicle)) continue;
    if (destAlt >= 500 && (Number(c.alt) || 0) < destAlt - 250) continue;
    const d = haversine(point, c);
    if (d > 25) continue;
    if (!best || d < best.dist) best = { charger: c, dist: d };
  }
  return best;
}

/**
 * 找出「沿線」的快充候選：把 prev→dest 連線當成路線，取跨線距離以內的站點。
 * 若起訖點皆在平地（< 400 m），排除高海拔山區站點（避免平地長途誤選山區站）。
 */
function alongCorridor(prev, dest, chargers, kmTotal, vehicle = null) {
  const maxCross = clamp(kmTotal * 0.12, 8, 25);
  const bx = (dest.lng - prev.lng) * 102.5;
  const by = (dest.lat - prev.lat) * 111.0;
  const len2 = bx * bx + by * by;
  if (len2 < 1) return [];
  const flatTrip = (Number(prev.alt) || 0) < 400 && (Number(dest.alt) || 0) < 400;
  const out = [];
  for (const c of chargers || []) {
    if (c.type !== "DC" || !isVehicleCompatible(c, vehicle)) continue;
    if (flatTrip && (Number(c.alt) || 0) >= 500) continue;
    const px = (c.lng - prev.lng) * 102.5;
    const py = (c.lat - prev.lat) * 111.0;
    const t = (px * bx + py * by) / len2;
    if (t < 0.08 || t > 0.95) continue;
    const cross = Math.abs(px * by - py * bx) / Math.sqrt(len2);
    if (cross > maxCross) continue;
    out.push({ charger: c, t, cross, dist: haversine(c, dest) });
  }
  return out.sort((a, b) => b.t - a.t);
}

/**
 * 途中補電點：沿線可到、且充完能抵達目的地保留電量的「最遠」快充站
 */
function midStopOf(prev, stop, chargers, { kmTotal, climbTotal, departSoc, need, calc, drive }) {
  let fallback = null;
  for (const p of alongCorridor(prev, stop, chargers, kmTotal, calc.vehicle)) {
    const km1 = clamp(haversine(prev, p.charger) * 1.26, 1, Math.max(1.5, kmTotal - 1));
    const km2 = Math.max(0.5, kmTotal - km1);
    const e1 = legEnergy(km1, 0, calc.kmPerKwh, drive);
    const e2 = legEnergy(km2, climbTotal * (km2 / Math.max(kmTotal, 0.1)), calc.kmPerKwh, drive);
    const socAtCharger = departSoc - (e1 / calc.capacity) * 100;
    const needAtCharger = need + (e2 / calc.capacity) * 100;
    const cand = { charger: p.charger, dist: p.dist, km1, km2, e1, e2, socAtCharger, needAtCharger };
    if (socAtCharger >= 10 && needAtCharger <= 96) return cand;
    if (!fallback && socAtCharger >= 0) fallback = cand;
  }
  return fallback;
}

/**
 * 找出「山下最後一個 N7 快充站」及同區域備選站點。
 * 條件：DC、相容該車接頭（N7 CCS1）、距山上目的地 2–55 km、位於山下（海拔明顯低於目的地）、
 * 且順路不繞遠路。優先選擇高功率指標站（如 U-Power 嘉義中埔站、U-Power 埔里站等）。
 */
function baseChargerOf(prev, dest, chargers, vehicle = null, preferredId = "") {
  const destAlt = Number(dest.alt) || 0;
  const prevDist = haversine(prev, dest);
  const candidates = [];

  for (const c of chargers || []) {
    if (c.type !== "DC") continue;
    if (!isVehicleCompatible(c, vehicle)) continue;
    const dist = haversine(c, dest);
    if (dist < 1.5 || dist > 55) continue;
    const cAlt = Number(c.alt) || 0;
    if (destAlt >= 500 && cAlt > destAlt - 250) continue;
    // 避免挑到另一座高山上的充電站當成「山下」
    if (cAlt >= 600) continue;
    // 一定要比出發點更靠近目的地，避免往回頭方向開
    if (dist > prevDist - 1) continue;

    const dPrev = haversine(prev, c);
    // 繞路程度：台灣西部往山區常先走國道再轉橫向省道（如台北→埔里→清境），放寬走廊容許值
    const detour = Math.max(0, dPrev + dist - prevDist);
    if (detour > Math.max(50, prevDist * 0.45)) continue;

    const score =
      dist * 0.85 +
      detour * 0.35 -
      (c.power >= 180 ? 4.5 : c.power >= 120 ? 1.5 : 0) -
      (c.verified ? 3.5 : 0);

    candidates.push({ charger: c, dist, detour, score });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.score - b.score);

  const chosen = (preferredId && candidates.find((x) => x.charger.id === preferredId)) || candidates[0];
  const alternatives = candidates
    .filter((x) => x.charger.id !== chosen.charger.id)
    .slice(0, 4)
    .map((x) => ({ charger: x.charger, dist: x.dist }));

  return {
    ...chosen,
    alternatives,
  };
}

function chargeMinutes(charger, fromSoc, toSoc, capacity) {
  const delta = Math.max(0, toSoc - fromSoc);
  if (delta <= 0) return 0;
  const isAC = charger.type === "AC" || charger.power < 22;
  const avgKW = isAC ? Math.max(3.5, charger.power * 0.85) : Math.min(charger.power, 120) * 0.72;
  const hours = ((delta / 100) * capacity) / avgKW;
  return isAC
    ? Math.max(30, Math.round((hours * 60) / 15) * 15)
    : Math.max(5, Math.round((hours * 60) / 5) * 5);
}

/**
 * 國道路線估算（純前端、不用即時路徑 API）：
 * 取起訖點在國道線形上最近的兩個節點，中間走國道折線里程，
 * 兩端用一般道路接上國道（×1.3 道路係數）。
 * 回傳 null 表示該段不適合走這條國道（起訖點貼在同一個節點附近）。
 */
function highwayRouteInfo(start, dest, route) {
  if (!route || !Array.isArray(route.waypoints) || route.waypoints.length < 2) return null;
  const nearestIdx = (pt) => {
    let best = 0, bestD = Infinity;
    route.waypoints.forEach((w, i) => {
      const d = haversine(pt, w);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  };
  const sIdx = nearestIdx(start);
  const dIdx = nearestIdx(dest);
  if (sIdx === dIdx) return null;
  const step = dIdx > sIdx ? 1 : -1;
  let polyKm = 0;
  for (let i = sIdx; i !== dIdx; i += step) {
    polyKm += haversine(route.waypoints[i], route.waypoints[i + step]);
  }
  const entryKm = haversine(start, route.waypoints[sIdx]) * 1.3;
  const exitKm = haversine(route.waypoints[dIdx], dest) * 1.3;
  const totalKm = Math.max(2, entryKm + polyKm * 1.05 + exitKm);
  return { route, startIdx: sIdx, destIdx: dIdx, step, polyKm, entryKm, exitKm, totalKm };
}

/** 國道沿途服務區（按行駛方向排序，附距出發點約略里程） */
function highwayServiceStops(start, dest, route, chargers) {
  const info = highwayRouteInfo(start, dest, route);
  if (!info) return [];
  const list = chargers || (typeof CHARGERS !== "undefined" ? CHARGERS : []);
  const byId = new Map(list.map((c) => [c.id, c]));
  const inRange = (idx) => info.step === 1
    ? (idx >= info.startIdx && idx <= info.destIdx)
    : (idx <= info.startIdx && idx >= info.destIdx);
  const out = [];
  for (const id of route.serviceAreaIds || []) {
    const charger = byId.get(id);
    if (!charger) continue;
    let wpIdx = 0, bestD = Infinity;
    route.waypoints.forEach((w, i) => {
      const d = haversine(charger, w);
      if (d < bestD) { bestD = d; wpIdx = i; }
    });
    if (!inRange(wpIdx)) continue;
    let segKm = 0;
    for (let i = info.startIdx; i !== wpIdx; i += info.step) {
      segKm += haversine(route.waypoints[i], route.waypoints[i + info.step]);
    }
    out.push({ charger, kmFromStart: info.entryKm + segKm * 1.05, waypointIdx: wpIdx });
  }
  out.sort((a, b) => a.kmFromStart - b.kmFromStart);
  return out;
}

function legSpeed(leg, ev) {
  let speed = DRIVE_SPEEDS[ev.drive] || 46;
  if (leg.mountain) speed = Math.min(speed, 33);
  if (leg.climb > 800) speed = Math.min(speed, 28);
  return speed;
}

/**
 * 建立完整行程計畫。
 *
 * 智能山下補電邏輯（以「雲林出發 → 嘉義山下補電 → 隙頂車宿」為典型）：
 *  1. 當終點或中途過夜點為高海拔（海拔 ≥ 600 m 或爬升 ≥ 350 m）時，系統自動啟動「二階段山下補電檢查」：
 *     - 第一階段（平地／高速段）：從出發地（如雲林斗南）行駛至山下快充站（如嘉義中埔 U-Power 站），
 *       依「高速 km/kWh」與「平常道路 km/kWh」計算抵達山下時的剩餘電量（socAtBase）。
 *     - 第二階段（上山爬坡段）：從山下快充站爬坡上山至車宿點（如隙頂，海拔 1,250 m），
 *       依車款「爬坡 km/kWh」計算上山所需耗電度數（e2）與耗電百分比（climbPct）。
 *     - 依據使用者設定的「預計留在車宿點的電量（need，如 30%）」＋「上山爬坡耗電（climbPct）」＋「山區安全與車宿緩衝」，
 *       反推在嘉義山下必須充到多少 % 再上山（若山上無 N7 DC 快充，智能建議在山下補滿至 85%～90% 再上山）。
 */
/**
 * 自動為各行程站點分配「第幾天」：
 *  手動指定優先；未指定時 2 日遊以第一個車宿／露營點分界，
 *  3 天以上按順序平均分配；最後強制單調不遞減且過夜點下一站至少隔天。
 */
function assignStopDays(stops, tripDays = 1, dayMap = {}) {
  const days = clamp(Number(tripDays) || 1, 1, 7);
  if (!Array.isArray(stops) || !stops.length) return [];
  if (days === 1) return stops.map(() => 1);
  const firstOvernightIdx = stops.findIndex((s) => s.cat === "car" || s.cat === "camp");
  const day1EndIdx = firstOvernightIdx >= 0 ? firstOvernightIdx : 0;
  const out = stops.map((s, idx) => {
    const manual = Number(dayMap[s.id]);
    if (Number.isFinite(manual)) return clamp(manual, 1, days);
    if (days === 2) return idx <= day1EndIdx ? 1 : 2;
    return clamp(Math.floor((idx / Math.max(1, stops.length)) * days) + 1, 1, days);
  });
  for (let i = 1; i < out.length; i++) {
    let d = Math.max(out[i], out[i - 1]);
    const prevIsOvernight = stops[i - 1].cat === "car" || stops[i - 1].cat === "camp";
    const manual = Number(dayMap[stops[i].id]);
    if (prevIsOvernight && !Number.isFinite(manual)) d = Math.max(d, out[i - 1] + 1);
    out[i] = clamp(d, 1, days);
  }
  return out;
}

/** 沿途國道服務區逐站評估：到站剩餘電量、建議充到幾 %、預估時間、是否充完可抵達 */
function evalHighwayStop({ charger, kmFromStart, legKm, climb, legDrive, departSoc, need, calc }) {
  const km1 = kmFromStart;
  const km2 = Math.max(0.5, legKm - km1);
  const d1 = legEnergyDetail(km1, 0, calc.kmPerKwh, "highway");
  const d2 = legEnergyDetail(km2, climb, calc.kmPerKwh, legDrive);
  const e1 = d1.energy, e2 = d2.energy;
  const socAt = departSoc - (e1 / calc.capacity) * 100;
  const e2Pct = (e2 / calc.capacity) * 100;
  const to = clamp(Math.ceil(Math.max(need + e2Pct + 8, socAt + 5)), 50, 96);
  return {
    charger, kmFromStart, km1, km2, e1, e2,
    socAt, to, e2Pct,
    minutes: socAt >= 0 && to > socAt ? chargeMinutes(charger, socAt, to, calc.capacity) : 0,
    arriveIfCharged: to - e2Pct,
    feasible: socAt >= 8 && (to - e2Pct) >= need - 2,
  };
}

function buildTripPlan({ start, stops, ev, chargers, destReserve, stopDays }) {
  const dayMap = stopDays && typeof stopDays === "object" ? stopDays : {};
  const tripDays = clamp(Number(ev.tripDays) || 1, 1, 7);
  const returnTrip = !!ev.returnTrip;
  const overnightMode = ev.overnightMode || "camp-ac";
  // 每站生效天數（智慧分日）：
  //  - 手動指定（每站旁「第幾天」選單）優先，限制在 1..tripDays；
  //  - 沒指定時：1 日遊全為第 1 天；2 日遊以第一個車宿／露營點為界，
  //    之前（含該點）為第 1 天、之後為第 2 天；3 天以上按站點順序平均分配；
  //  - 之後再強制單調不遞減，且過夜點的下一站至少是隔天（睡一晚再出發）。
  const effDays = assignStopDays(stops, tripDays, dayMap);
  const maxStopDay = effDays.length ? Math.max(...effDays) : 1;
  const returnDay = Math.max(maxStopDay, tripDays);
  // 回程當成最後一腿：回到出發地，需求電量用一般保留值（不是終點預留）
  const planStops = returnTrip && stops.length
    ? [...stops, { ...start, id: "__return__", name: `${start.name}（回程）`, cat: "return", forceDay: returnDay }]
    : [...stops];
  const calc = computeEv(ev);
  const list = chargers || (typeof CHARGERS !== "undefined" ? CHARGERS : []);
  const routeMode = ev.routeMode || "auto";
  const highwayRoute = (routeMode === "nh1" || routeMode === "nh3") && typeof highwayRouteById === "function"
    ? highwayRouteById(routeMode) : null;
  const highwayStops = [];
  let usedHighwayCharge = false;
  const reserve = clamp(Number(ev.reserve) || 0, 0, 40);
  const destR = clamp(
    Number(destReserve ?? ev.destReserve ?? 30),
    0,
    60
  );
  const baseMode = ev.baseChargeMode || "auto";
  const legs = [];
  const charges = [];
  const warnings = [];
  const basePlans = [];
  const overnightStays = [];
  let prevLegDay = 1;

  let soc = clamp(Number(ev.startSoc) || 90, 10, 100);
  let prev = start;
  let totalKm = 0;
  let totalClimb = 0;
  let totalEnergy = 0;
  let totalMinutes = 0;
  let maxAlt = Number(start.alt) || 0;
  let firstBaseCharge = null;
  let baseHint = null;

  planStops.forEach((stop, i) => {
    const isLast = i === planStops.length - 1;
    const isOvernight = stop.cat === "camp" || stop.cat === "car";
    const isReturn = stop.id === "__return__";
    // 回程時，原本的最後一站仍用終點預留（在最遠點留安全電量），回程腿本身只用一般保留值
    const need = isReturn ? reserve : ((isLast || isOvernight || (returnTrip && i === stops.length - 1)) ? destR : reserve);
    const legDay = isReturn ? stop.forceDay : (effDays[i] ?? 1);
    /* ---- 跨日過夜休息：換天時先結算前一晚的電量變化，再開始當天行程 ---- */
    if (i > 0 && legDay > prevLegDay) {
      const beforeSoc = soc;
      let afterSoc = soc;
      let deltaKwh = 0;
      let noteText = "";
      const nights = Math.max(1, legDay - prevLegDay);
      if (overnightMode === "camp-charge") {
        afterSoc = Math.max(soc, 95);
        deltaKwh = ((afterSoc - beforeSoc) / 100) * calc.capacity;
        noteText = `營地過夜接電慢充（${Math.round(beforeSoc)}% → ${Math.round(afterSoc)}%）`;
      } else if (overnightMode === "no-drain") {
        afterSoc = soc;
        noteText = `過夜休息不開冷暖氣（維持 ${Math.round(afterSoc)}%）`;
      } else {
        const drainPct = 10 * nights;
        afterSoc = Math.max(0, soc - drainPct);
        deltaKwh = -((beforeSoc - afterSoc) / 100) * calc.capacity;
        noteText = `車宿過夜休息（冷暖氣／露營模式耗電約 ${drainPct}%，約 ${Math.abs(deltaKwh).toFixed(1)} 度電）`;
        if (afterSoc < 15) {
          warnings.push({
            tone: "warn",
            text: `第 ${prevLegDay} 晚在「${prev.name}」過夜耗電後，第 ${legDay} 天早上出發電量僅剩 ${Math.round(afterSoc)}%，建議前一天上山前多補一點電或當天下山後立即快充。`,
          });
        }
      }
      soc = afterSoc;
      const stay = {
        night: prevLegDay, day: prevLegDay, nextDay: legDay, at: prev,
        socBefore: Math.round(beforeSoc), socAfter: Math.round(afterSoc),
        beforeSoc: Math.round(beforeSoc), afterSoc: Math.round(afterSoc),
        deltaKwh, mode: overnightMode, label: noteText, noteText,
      };
      overnightStays.push(stay);
      if (legs[i - 1]) legs[i - 1].overnightStay = stay;
    }
    prevLegDay = legDay;
    const baseEst = estimateLeg(prev, stop);
    // 走法覆寫：國道走法不採用 OSRM 預設路徑（OSRM 不分國一／國三），
    // 改用國道折線里程；一般道路走法也不走高速。
    let est = (routeMode === "auto" && stop.route && stop.route.km)
      ? { km: stop.route.km, climb: stop.route.climb ?? 0, mountain: (stop.route.climb ?? 0) > 400 }
      : baseEst;
    let legDrive = ev.drive;
    let legSpeedVal = null;
    let hwInfo = null;
    if (highwayRoute) {
      hwInfo = highwayRouteInfo(prev, stop, highwayRoute);
      if (hwInfo && hwInfo.totalKm < baseEst.km * 1.8) {
        est = { km: hwInfo.totalKm, climb: baseEst.climb, mountain: baseEst.mountain };
        legDrive = "highway";
        legSpeedVal = est.mountain ? 33 : 72;
        if (est.climb > 800) legSpeedVal = Math.min(legSpeedVal, 28);
        for (const hs of highwayServiceStops(prev, stop, highwayRoute, list)) {
          highwayStops.push({
            legIndex: i,
            charger: hs.charger,
            kmFromStart: hs.kmFromStart,
            kmFromTripStart: totalKm + hs.kmFromStart,
          });
        }
        // 沿途服務區逐站評估（篩選用）：每站到站電量、建議充到幾 %、預估時間、是否可行
        for (const hs of highwayStops.filter((h) => h.legIndex === i)) {
          hs.eval = evalHighwayStop({
            charger: hs.charger, kmFromStart: hs.kmFromStart,
            legKm: est.km, climb: est.climb, legDrive,
            departSoc: soc, need, calc,
          });
        }
      } else {
        hwInfo = null;
      }
    } else if (routeMode === "local") {
      legDrive = "city"; // 能量只用一般道路 km/kWh，不拆高速段
      legSpeedVal = 46;  // 但行車時間仍用一般道路均速，不是市區 28
    }

    const directDetail = legEnergyDetail(est.km, est.climb, calc.kmPerKwh, legDrive);
    let energy = directDetail.energy;
    const minutes = legSpeedVal
      ? (est.km / legSpeedVal) * 60
      : (est.km / legSpeed(est, ev)) * 60;
    const departSoc = soc;
    let arriveSoc = soc - (energy / calc.capacity) * 100;
    const highDest = est.climb >= 250 && ((Number(stop.alt) || 0) >= 550 || est.climb >= 350);

    const leg = {
      index: i,
      from: prev,
      to: stop,
      km: est.km,
      climb: est.climb,
      mountain: !!est.mountain,
      highDest,
      need,
      energy,
      detail: directDetail,
      minutes,
      departSoc,
      arriveSoc,
      estimated: !(stop.route && stop.route.km),
      routeMode,
      highway: hwInfo,
      legDrive,
      day: legDay,
      isReturn,
      charge: null,
      baseCharge: null,
      inRouteCharge: null,
    };

    const base = (highDest && (isLast || isOvernight) && baseMode !== "off")
      ? baseChargerOf(prev, stop, list, calc.vehicle, ev.baseChargerId)
      : null;

    /* ---- 山下補電二階段精算：平地/高速段（起點→山下）＋ 爬坡段（山下→車宿點） ---- */
    let basePlan = null;
    if (base) {
      const km1 = clamp(haversine(prev, base.charger) * 1.26, 1.5, Math.max(2, est.km - 3));
      const km2 = Math.max(3, Math.max(est.km - km1, haversine(base.charger, stop) * 1.48));
      const climb1 = Math.max(0, (Number(base.charger.alt) || 70) - (Number(prev.alt) || 0));
      const climb2 = Math.max(0, (Number(stop.alt) || 0) - (Number(base.charger.alt) || 70));

      const stage1 = legEnergyDetail(km1, climb1, calc.kmPerKwh, legDrive);
      const stage2 = legEnergyDetail(km2, climb2, calc.kmPerKwh, "mountain");
      const e1 = stage1.energy;
      const e2 = stage2.energy;

      const socAtBase = departSoc - (e1 / calc.capacity) * 100;
      const climbPct = (e2 / calc.capacity) * 100;
      const arriveWithoutCharge = socAtBase - climbPct;

      const destDC = nearestMountainDC(stop, list, calc.vehicle);
      const noDestDC = !destDC;
      // 車宿／露營在山上過夜（開冷暖氣／露營模式）加上山上無快充，安全緩衝至少 +8%
      const buffer = baseMode === "auto" || baseMode === "always" ? 8 : 0;
      const minBaseSocForReserve = need + climbPct + buffer;
      const targetAtBase = Math.max(
        minBaseSocForReserve,
        ((baseMode === "auto" && noDestDC) || baseMode === "always") ? 85 : 0
      );

      const needed = socAtBase < 0
        ? true
        : baseMode === "always"
          ? socAtBase < 90
          : baseMode === "need"
            ? arriveWithoutCharge < need
            : (arriveWithoutCharge < need + buffer) || (noDestDC && socAtBase < 85);

      const to = needed
        ? clamp(Math.ceil(Math.max(targetAtBase, socAtBase + 5)), 50, 96)
        : Math.round(socAtBase);

      basePlan = {
        charger: base.charger,
        alternatives: base.alternatives || [],
        dist: base.dist,
        from: Math.round(socAtBase),
        to,
        minutes: socAtBase >= 0 && to > socAtBase
          ? chargeMinutes(base.charger, socAtBase, to, calc.capacity)
          : 0,
        where: "base",
        at: stop,
        km1,
        km2,
        climb1,
        climb2,
        stage1,
        stage2,
        e1,
        e2,
        socAtBase,
        socNeedBase: minBaseSocForReserve,
        climbPct,
        noDestDC,
        destDC: destDC ? destDC.charger : null,
        needed,
        arriveIfCharged: to - climbPct,
        arriveIfNotCharged: arriveWithoutCharge,
      };
      leg.basePlan = basePlan;
      leg.km1 = km1;
      leg.km2 = km2;
      basePlans.push({ legIndex: i, ...basePlan });
    }

    /* ---- 使用者手選的國道服務區補電點：先算是否真的需要充 ----
       到站電量已夠（目標 <= 到站電量）時不硬排一個 0 分鐘假充電，
       交回山下／自動補電；只有真的需要充才進 pickedHw 分支。 */
    let pickedHw = null;
    {
      const hs = (routeMode === "nh1" || routeMode === "nh3") && ev.highwayChargeId
        ? (highwayStops.find((h) => h.legIndex === i && h.charger.id === ev.highwayChargeId) || null)
        : null;
      if (hs) {
        const km1 = hs.kmFromStart;
        const km2 = Math.max(0.5, leg.km - km1);
        const d1 = legEnergyDetail(km1, 0, calc.kmPerKwh, "highway");
        const d2 = legEnergyDetail(km2, est.climb, calc.kmPerKwh, legDrive);
        const e1 = d1.energy, e2 = d2.energy;
        const socAt = departSoc - (e1 / calc.capacity) * 100;
        const to = clamp(Math.ceil(Math.max(need + (e2 / calc.capacity) * 100 + 8, socAt + 5)), 50, 96);
        if (socAt >= 0 && to > socAt + 0.5) {
          pickedHw = { charger: hs.charger, km1, km2, d1, d2, e1, e2, socAt, to };
        } else if (socAt < 0) {
          // 到不了手選服務區：同樣交回自動邏輯（它會找更前面的充電點），
          // 但不在事後誤報「不在沿途」（該站確實在沿途，只是到不了）
          usedHighwayCharge = true;
        }
      }
    }
    /* ---- 國道走法自動篩選：沿途最新一個「可行」的服務區（wildvolt-3 邏輯） ---- */
    const saPick = (routeMode === "nh1" || routeMode === "nh3") && !pickedHw
      ? [...highwayStops.filter((h) => h.legIndex === i && h.eval)].reverse().find(
          (h) => h.eval.feasible && h.eval.socAt >= (isReturn ? 12 : 14) && h.eval.arriveIfCharged >= need
        )
      : null;
    if (pickedHw) {
        const { km1, km2, d1, d2, e1, e2, socAt, to: preTo } = pickedHw;
        usedHighwayCharge = true;
        if (false) {
          warnings.push({
            tone: "danger",
            text: `第 ${i + 1} 段連國道「${pickedHw.charger.name}」都到不了（估計會少 ${Math.round(-socAt)}%），請改選更前面的服務區，或先提高出發電量。`,
          });
          arriveSoc = socAt - (e2 / calc.capacity) * 100;
          soc = arriveSoc;
        } else {
          const to = preTo;
          const charge = {
            charger: pickedHw.charger,
            dist: haversine(pickedHw.charger, stop),
            from: Math.round(socAt),
            to,
            minutes: chargeMinutes(pickedHw.charger, socAt, to, calc.capacity),
            where: "highway",
            at: stop,
            km1,
            km2,
            socNeedBase: need + (e2 / calc.capacity) * 100,
          };
          charges.push({ legIndex: i, ...charge });
          leg.highwayCharge = charge;
          leg.km1 = km1;
          leg.km2 = km2;
          leg.energy = e1 + e2;
          energy = e1 + e2;
          leg.detail = {
            energy: e1 + e2,
            roadKm: d1.roadKm + d2.roadKm,
            highwayKm: d1.highwayKm + d2.highwayKm,
            climbKm: d1.climbKm + d2.climbKm,
            roadKwh: d1.roadKwh + d2.roadKwh,
            highwayKwh: d1.highwayKwh + d2.highwayKwh,
            climbKwh: d1.climbKwh + d2.climbKwh,
          };
          arriveSoc = to - (e2 / calc.capacity) * 100;
          soc = arriveSoc;
          usedHighwayCharge = true;
          warnings.push({
            tone: "info",
            text: `國道補電（已選）：先開 ${km1.toFixed(1)} km 到「${pickedHw.charger.name}」（剩約 ${Math.round(socAt)}%），補電至 ${to}%（約 ${charge.minutes} 分鐘），再開 ${km2.toFixed(1)} km 抵達「${stop.name}」約剩 ${Math.round(arriveSoc)}%，保留 ${need}%。`,
          });
          /* 單次手選補電仍到不了預留（例如太早的服務區＋長高速段）：
             再用自動途中充電補一次，避免只充一次就低電量抵達。 */
          if (arriveSoc < need) {
            const mid2 = midStopOf(pickedHw.charger, stop, list, {
              kmTotal: km2, climbTotal: est.climb, departSoc: to, need, calc, drive: legDrive,
            });
            if (mid2 && mid2.socAtCharger >= 0) {
              const to2 = Math.min(96, Math.ceil(mid2.needAtCharger + 3));
              const charge2 = {
                charger: mid2.charger, dist: mid2.dist,
                from: Math.round(mid2.socAtCharger), to: to2,
                minutes: chargeMinutes(mid2.charger, mid2.socAtCharger, to2, calc.capacity),
                where: "mid", at: stop, km1: mid2.km1, km2: mid2.km2,
              };
              charges.push({ legIndex: i, ...charge2 });
              leg.energy = e1 + mid2.e1 + mid2.e2;
              energy = leg.energy;
              arriveSoc = to2 - (mid2.e2 / calc.capacity) * 100;
              soc = arriveSoc;
              warnings.push({
                tone: "info",
                text: `手選服務區一次充不夠（即使充到 ${to}% 仍低於預留 ${need}%），已再安排途中在「${mid2.charger.name}」補電：${Math.round(mid2.socAtCharger)}% → ${to2}%（約 ${charge2.minutes} 分鐘），抵達「${stop.name}」約剩 ${Math.round(arriveSoc)}%。若想只充一次，請改選更後面的服務區（如關廟）。`,
              });
            } else {
              warnings.push({
                tone: "warn",
                text: `即使在「${pickedHw.charger.name}」充到 ${to}%，抵達「${stop.name}」仍只有約 ${Math.round(arriveSoc)}%，低於預留 ${need}%。建議改選更後面的服務區，或改回自動補電讓系統挑最晚的可充點。`,
              });
            }
          }
        }
    } else if (basePlan && basePlan.needed) {
      /* ---- 執行山下補電：先跑平地/高速到山下快充，補完電再爬坡上山 ---- */
      const { km1, km2, e1, e2, socAtBase } = basePlan;
      energy = e1 + e2;
      leg.energy = energy;
      leg.km = km1 + km2;
      leg.detail = {
        energy,
        roadKm: basePlan.stage1.roadKm + basePlan.stage2.roadKm,
        highwayKm: basePlan.stage1.highwayKm + basePlan.stage2.highwayKm,
        climbKm: basePlan.stage1.climbKm + basePlan.stage2.climbKm,
        roadKwh: basePlan.stage1.roadKwh + basePlan.stage2.roadKwh,
        highwayKwh: basePlan.stage1.highwayKwh + basePlan.stage2.highwayKwh,
        climbKwh: basePlan.stage1.climbKwh + basePlan.stage2.climbKwh,
      };

      if (socAtBase < 0) {
        warnings.push({
          tone: "danger",
          text: `第 ${i + 1} 段連山下「${base.charger.name}」都到不了（估計會少 ${Math.round(-socAtBase)}%），請先在更前面的交流道或服務區快充補電。`,
        });
        arriveSoc = socAtBase - (e2 / calc.capacity) * 100;
        soc = arriveSoc;
      } else {
        const to = basePlan.to;
        if (to > socAtBase + 0.5) {
          const mins = basePlan.minutes;
          const charge = {
            charger: base.charger,
            alternatives: base.alternatives || [],
            dist: base.dist,
            from: Math.round(socAtBase),
            to,
            minutes: mins,
            where: "base",
            at: stop,
            km1,
            km2,
            e1,
            e2,
            climb2: basePlan.climb2,
            socNeedBase: basePlan.socNeedBase,
          };
          charges.push({ legIndex: i, ...charge });
          leg.baseCharge = charge;
          if (!firstBaseCharge) firstBaseCharge = charge;
          arriveSoc = to - (e2 / calc.capacity) * 100;
          soc = arriveSoc;
          warnings.push({
            tone: "info",
            text: `智能山下補電：先從「${prev.name}」開 ${km1.toFixed(1)} km 到山下「${base.charger.name}」（剩約 ${Math.round(socAtBase)}%），補電至 ${to}%（約 ${mins} 分鐘）；再爬坡上山 ${km2.toFixed(1)} km（爬升 ${Math.round(basePlan.climb2)} m，耗電約 ${e2.toFixed(1)} kWh／${Math.round(basePlan.climbPct)}%），抵達「${stop.name}」約剩 ${Math.round(arriveSoc)}%，高於預計留電 ${need}%。`,
          });
          if (basePlan.socNeedBase > 96) {
            warnings.push({
              tone: "warn",
              text: `即使在山下充到 96%，抵達「${stop.name}」仍可能低於預留的 ${need}%。建議把車宿點預留電量降到 ${Math.max(10, 96 - Math.round(basePlan.climbPct) - 3)}% 以下，或放慢車速減少爬坡耗電。`,
            });
          }
        } else {
          soc = basePlan.arriveIfNotCharged;
          arriveSoc = soc;
          baseHint = { charger: base.charger, dist: base.dist, soc: Math.round(socAtBase) };
        }
      }
    } else if (basePlan) {
      soc = basePlan.arriveIfNotCharged;
      arriveSoc = soc;
      baseHint = { charger: base.charger, dist: base.dist, soc: Math.round(basePlan.socAtBase) };
    } else if (saPick && arriveSoc < need) {
      /* ---- 國道服務區自動補電（已篩選的最新可行服務區） ---- */
      const ev2 = saPick.eval;
      const charge = {
        charger: saPick.charger,
        dist: haversine(saPick.charger, stop),
        from: Math.round(ev2.socAt),
        to: ev2.to,
        minutes: ev2.minutes,
        where: "highway",
        at: stop,
        km1: ev2.km1,
        km2: ev2.km2,
        e1: ev2.e1,
        e2: ev2.e2,
      };
      charges.push({ legIndex: i, ...charge });
      leg.highwayCharge = charge;
      usedHighwayCharge = true;
      arriveSoc = ev2.arriveIfCharged;
      soc = arriveSoc;
      warnings.push({
        tone: "info",
        text: `國道服務區自動補電：在「${saPick.charger.name}」補電 ${Math.round(ev2.socAt)}% → ${ev2.to}%（約 ${ev2.minutes} 分鐘），再開 ${Math.round(ev2.km2)} km 抵達「${stop.name}」約剩 ${Math.round(arriveSoc)}%。`,
      });
    } else if (arriveSoc < need) {
      /* ---- 到不了保留電量：先找快充（目的地優先，其次途中），最後才用慢充 ---- */
      const isACPick = (p) => p.charger.type === "AC" || p.charger.power < 22;
      const nearDest = nearestCharger(stop, list, 25, calc.vehicle);
      const nearMid = midStopOf(prev, stop, list, {
        kmTotal: est.km,
        climbTotal: est.climb,
        departSoc,
        need,
        calc,
        drive: legDrive,
      });
      const canReachDest = arriveSoc >= 0;
      let pick = null;
      let where = null;
      if (canReachDest && nearDest && !isACPick(nearDest)) {
        pick = nearDest;
        where = "dest";
      } else if (nearMid) {
        pick = nearMid;
        where = "mid";
      } else if (canReachDest && nearDest) {
        pick = nearDest;
        where = "dest";
      }

      if (pick && where === "mid") {
        /* ---- 途中快充：起點 →（充電點）→ 目的地 ---- */
        const { km1, km2, e1, e2, socAtCharger, needAtCharger } = pick;
        energy = e1 + e2;
        leg.energy = energy;
        leg.km1 = km1;
        leg.km2 = km2;

        if (socAtCharger < 0) {
          warnings.push({
            tone: "danger",
            text: `第 ${i + 1} 段連途中「${pick.charger.name}」都到不了（估計會少 ${Math.round(-socAtCharger)}%），請先在更前面的充電點補電，或改用較低耗電的行車型態。`,
          });
          arriveSoc = socAtCharger - (e2 / calc.capacity) * 100;
          soc = arriveSoc;
        } else {
          if (socAtCharger < 10) {
            warnings.push({
              tone: "warn",
              text: `到「${pick.charger.name}」時估計只剩 ${Math.round(socAtCharger)}%，建議先在更前面的快充補一次，避免低電量長距離行駛。`,
            });
          }
          const to = Math.min(96, Math.ceil(needAtCharger + 3));
          const charge = {
            charger: pick.charger,
            dist: pick.dist,
            from: Math.round(socAtCharger),
            to,
            minutes: chargeMinutes(pick.charger, socAtCharger, to, calc.capacity),
            where,
            at: stop,
            km1,
            km2,
            socNeedBase: needAtCharger,
          };
          charges.push({ legIndex: i, ...charge });
          leg.inRouteCharge = charge;
          arriveSoc = to - (e2 / calc.capacity) * 100;
          soc = arriveSoc;
          warnings.push({
            tone: "info",
            text: `途中在「${pick.charger.name}」補電：${Math.round(socAtCharger)}% → ${to}%（約 ${charge.minutes} 分鐘），再開 ${Math.round(km2)} km 抵達「${stop.name}」約剩 ${Math.round(arriveSoc)}%，保留 ${need}%。`,
          });
          if (needAtCharger > 96) {
            warnings.push({
              tone: "danger",
              text: `即使途中充到 96%，抵達「${stop.name}」仍低於保留的 ${need}%。請增加一個充電站，或把目的地保留電量降到 ${Math.max(5, Math.floor(96 - (e2 / calc.capacity) * 100))}%。`,
            });
          }
        }
      } else if (pick) {
        /* ---- 抵達後補電（目的地唯一可用充電點） ---- */
        const isAC = isACPick(pick);
        const to = isAC ? 100 : Math.min(96, Math.round(need + 45));
        const from = Math.max(arriveSoc, 1);
        const mins = chargeMinutes(pick.charger, from, to, calc.capacity);
        const charge = {
          charger: pick.charger,
          dist: pick.dist,
          from: Math.round(from),
          to,
          minutes: mins,
          where,
          at: stop,
        };
        charges.push({ legIndex: i, ...charge });
        leg.charge = charge;
        soc = to;
        const dc = nearestDC(stop, list, 70, calc.vehicle);
        if (isAC) {
          warnings.push({
            tone: "warn",
            text: `抵達「${stop.name}」時僅剩 ${Math.round(arriveSoc)}%，目的地只有慢充（${pick.charger.name}）${dc ? `；建議先在「${dc.charger.name}」（距目的地直線約 ${Math.round(dc.dist)} km）快充至 80%，抵達後再慢慢補` : "，請確認營地可過夜充電"}。`,
          });
        } else {
          warnings.push({
            tone: arriveSoc < 0 ? "danger" : "warn",
            text: `抵達「${stop.name}」時估計剩 ${Math.round(arriveSoc)}%，已安排抵達後在「${pick.charger.name}」快充到 ${to}%（約 ${mins} 分鐘）。`,
          });
        }
      } else {
        warnings.push({
          tone: "danger",
          text: `第 ${i + 1} 段抵達「${stop.name}」時電量僅剩 ${Math.round(arriveSoc)}%，周邊 25 km 內沒有 ${calc.vehicle.connector} 可用的充電點，請務必先在其他站點補電或調整行程。`,
        });
        soc = arriveSoc;
      }
    } else {
      soc = arriveSoc;
      if (base) baseHint = { charger: base.charger, dist: base.dist, soc: Math.round(soc) };
    }

    leg.arriveSoc = arriveSoc;
    totalKm += leg.km;
    totalClimb += est.climb;
    totalEnergy += energy;
    totalMinutes += minutes;
    maxAlt = Math.max(maxAlt, Number(stop.alt) || 0);
    legs.push(leg);
    prev = stop;
  });

  if ((routeMode === "nh1" || routeMode === "nh3") && ev.highwayChargeId && legs.length
    && !highwayStops.some((h) => h.charger.id === ev.highwayChargeId)) {
    warnings.push({
      tone: "warn",
      text: "你選的國道服務區不在本次國道路線沿途（可能在反方向或另一條國道），已改回自動補電，請在沿途服務區清單裡重選一個。",
    });
  }

  const finalSoc = legs.length ? legs[legs.length - 1].arriveSoc : soc;

  /* ---- 分日彙總：每一天的腿、里程、耗電、補電、夜宿／回程 ---- */
  const maxDay = legs.length ? Math.max(...legs.map((l) => l.day)) : 1;
  const dayCount = Math.max(maxDay, returnTrip ? returnDay : tripDays, 1);
  const days = [];
  for (let d = 1; d <= dayCount; d++) {
    const dLegs = legs.filter((l) => l.day === d);
    const dCharges = charges.filter((c) => dLegs.some((l) => l.index === c.legIndex));
    const lastLeg = dLegs[dLegs.length - 1];
    const overnight = lastLeg && (lastLeg.to.cat === "camp" || lastLeg.to.cat === "car") ? lastLeg.to : null;
    days.push({
      day: d,
      legs: dLegs,
      km: dLegs.reduce((s, l) => s + l.km, 0),
      energy: dLegs.reduce((s, l) => s + l.energy, 0),
      minutes: dLegs.reduce((s, l) => s + l.minutes, 0),
      charges: dCharges,
      startSoc: dLegs.length ? dLegs[0].departSoc : null,
      endSoc: lastLeg ? lastLeg.arriveSoc : null,
      overnight,
      morningStay: overnightStays.find((s) => s.nextDay === d) || null,
      isReturnDay: dLegs.some((l) => l.isReturn),
      stops: dLegs.map((l) => l.to),
    });
  }
  const chargeMinutesTotal = charges.reduce((sum, c) => sum + c.minutes, 0);

  // ---- 提醒 ----
  if (legs.length) {
    if (totalKm > calc.usableRange && charges.length === 0) {
      warnings.push({
        tone: "danger",
        text: `總里程 ${Math.round(totalKm)} km 超過扣除保留電量後的可用里程 ${Math.round(calc.usableRange)} km，建議加入充電站或縮短行程。`,
      });
    }
    if (maxAlt >= 2500) {
      warnings.push({
        tone: "warn",
        text: `路線最高點約 ${Math.round(maxAlt).toLocaleString()} m。高山低溫會讓電池效率下降，實際續航建議再預留 10–15%。`,
      });
    }
    if (totalClimb > 2000) {
      warnings.push({
        tone: "warn",
        text: `全程累積爬升約 ${Math.round(totalClimb).toLocaleString()} m，爬坡耗電已按「爬坡 km/kWh」計入，滿載或雨天仍可能再多 5–10%。`,
      });
    }
    const last = returnTrip ? null : stops[stops.length - 1];
    if (last && !firstBaseCharge && !(legs[legs.length - 1].charge)) {
      const destCharge = nearestCharger(last, list, 25, calc.vehicle);
      if (!destCharge) {
        warnings.push({
          tone: "warn",
          text: `最後一站「${last.name}」25 km 內查無 ${calc.vehicle.connector} 可用的充電點，請先確認營地是否供電，或改住有充電樁的住宿。`,
        });
      } else if (destCharge.charger.type === "AC") {
        warnings.push({
          tone: "warn",
          text: `最後一站最近的充電點為 AC 慢充（${destCharge.charger.name}），建議確認是否開放外車使用，並自備充電線。`,
        });
      } else if (destCharge.n7 === false) {
        warnings.push({
          tone: "warn",
          text: `最後一站最近的充電點（${destCharge.charger.name}）未標示 ${calc.vehicle.connector} 接頭，出發前請先確認該車能不能充，系統已優先找相容站點。`,
        });
      }
    }
    if (stops.some((s) => s.cat === "car")) {
      warnings.push({
        tone: "warn",
        text: "行程含車泊點：各風景區與國家公園對停車場夜宿規定不同，出發前請確認合法性與垃圾、污水處理方式。",
      });
    }
    if (destR < 15 && maxAlt > 1800) {
      warnings.push({
        tone: "warn",
        text: "目的地保留電量低於 15%，高山夜間低溫與臨時繞路都吃電，建議至少留 20%～30%。",
      });
    }
  } else {
    warnings.push({ tone: "warn", text: "還沒有加入任何站點。從「探索」挑一個營地或登山口開始吧。" });
  }

  return {
    calc,
    legs,
    charges,
    warnings,
    totalKm,
    totalClimb,
    totalEnergy,
    totalMinutes,
    chargeMinutes: chargeMinutesTotal,
    finalSoc,
    maxAlt,
    start,
    destReserve: destR,
    reserve,
    baseCharge: firstBaseCharge,
    baseHint,
    basePlans,
    routeMode,
    highwayRoute,
    highwayStops,
    tripDays,
    returnTrip,
    overnightMode,
    overnightStays,
    days,
    baseChargeMode: baseMode,
    highDest: legs.length ? !!legs[legs.length - 1].highDest : false,
  };
}

function nearbyFood(anchor, radiusKm, kinds, extra = []) {
  if (!anchor) return [];
  const pool = [
    ...(typeof FOOD_POIS !== "undefined" ? FOOD_POIS : []),
    ...extra,
  ];
  const seen = new Set();
  return pool
    .map((f) => ({ ...f, dist: haversine(anchor, f) }))
    .filter((f) => f.dist <= radiusKm)
    .filter((f) => !kinds || !kinds.length || kinds.includes(f.kind))
    .filter((f) => {
      const key = f.id || f.name;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.dist - b.dist);
}

/**
 * 搜尋某個山頭／登山口／座標附近的「可車露／車宿／特約車泊／露營點」
 * 並非每個山頭本身都可以車宿（如棚集山登山口旁即有天際驛站、丹林桃心木兩個特約車泊點），
 * 系統自動找出半徑內（預設 12 km）可過夜的車泊／特約／營地並依距離與車泊優先度排序。
 */
function nearbyCarSpots(anchor, maxKm = 12, extra = []) {
  if (!anchor || !Number.isFinite(anchor.lat) || !Number.isFinite(anchor.lng)) return [];
  const pool = [
    ...(typeof POIS !== "undefined" ? POIS : []),
    ...extra,
  ];
  const seen = new Set([anchor.id]);
  const out = [];
  for (const p of pool) {
    if (!p || seen.has(p.id)) continue;
    const isCarOrCamp =
      p.cat === "car" ||
      p.cat === "camp" ||
      (p.cat === "partner" && (p.partnerKind === "car" || p.partnerKind === "camp" || p.partnerKind === "bath"));
    if (!isCarOrCamp) continue;
    const dist = haversine(anchor, p);
    if (dist > maxKm) continue;
    seen.add(p.id);
    // 車泊點／特約車泊優先，其次一般露營區
    const isCarFirst = p.cat === "car" || (p.cat === "partner" && p.partnerKind === "car");
    const score = dist + (isCarFirst ? 0 : 1.5);
    out.push({ ...p, dist, score, isCarFirst });
  }
  return out.sort((a, b) => a.score - b.score || a.dist - b.dist);
}

/**
 * 找出單一據點或整條行程沿線附近的順遊景點（運動公園、森林園區、吊橋、老街、熱門景點）
 * anchors 可傳單點或陣列。
 */
function nearbySpots(anchors, maxKm = 18, extra = []) {
  const pts = (Array.isArray(anchors) ? anchors : [anchors]).filter(
    (a) => a && Number.isFinite(a.lat) && Number.isFinite(a.lng)
  );
  if (!pts.length) return [];
  const stopIds = new Set(pts.map((a) => a.id).filter(Boolean));
  const pool = [
    ...(typeof SPOT_POIS !== "undefined" ? SPOT_POIS : []),
    ...(typeof POIS !== "undefined" ? POIS.filter((p) => p.cat === "spot") : []),
    ...extra,
  ];
  const seen = new Set();
  const out = [];
  for (const s of pool) {
    if (!s || stopIds.has(s.id)) continue;
    const key = s.id || s.name;
    if (seen.has(key)) continue;
    let bestDist = Infinity;
    let nearAnchor = pts[0];
    for (const a of pts) {
      const d = haversine(a, s);
      if (d < bestDist) {
        bestDist = d;
        nearAnchor = a;
      }
    }
    if (bestDist > maxKm) continue;
    seen.add(key);
    out.push({
      ...s,
      dist: bestDist,
      nearName: nearAnchor?.name || "",
    });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/* ---------- 格式化 ---------- */
function fmtKm(km, digits = 0) {
  const n = Number(km) || 0;
  return n.toLocaleString("zh-TW", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtDuration(hours) {
  const total = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h <= 0) return `${m} 分`;
  if (m === 0) return `${h} 小時`;
  return `${h} 小時 ${m} 分`;
}

function fmtSoc(soc) {
  if (soc < 0) return "0%";
  return `${Math.round(soc)}%`;
}

function esc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function svgIcon(name) {
  const paths = {
    tent: '<path d="M12 3.6 2.8 19.4h18.4L12 3.6Z"/><path d="M12 9.4v10M8.5 19.4 12 13l3.5 6.4"/>',
    van: '<path d="M3.2 16.4V9.6c0-.8.6-1.4 1.4-1.4h8.8c.5 0 .9.2 1.2.5l4.6 4.7c.3.3.4.6.4 1v2"/><path d="M3.2 16.4h17.6"/><circle cx="7.2" cy="17.7" r="1.7"/><circle cx="17" cy="17.7" r="1.7"/><path d="M13.4 8.2v4.4h5.2"/>',
    peak: '<path d="M2.6 19.3 9.4 6.8l4 7.1 2.1-3.5 6 8.9z"/><path d="M9.4 6.8 6.6 11.8h3.1M15.5 10.4l-1.4 3.5h2.9"/>',
    bowl: '<path d="M3.6 11.4h16.8a8.4 8.4 0 0 1-16.8 0Z"/><path d="M8 8.2c0-1.5 1.2-1.8 1.2-3.2M12 8.2c0-1.5 1.2-1.8 1.2-3.2M16 8.2c0-1.5 1.2-1.8 1.2-3.2"/>',
    bolt: '<path d="M13.1 2.4 4.9 13.5h5.4L9.4 21.6l8.2-11.4h-5.3z" fill="currentColor" stroke="none"/>',
    pin: '<path d="M12 21s6.4-5.8 6.4-10.6A6.4 6.4 0 0 0 5.6 10.4C5.6 15.2 12 21 12 21Z"/><circle cx="12" cy="10.3" r="2.3"/>',
    clock: '<circle cx="12" cy="12" r="8.3"/><path d="M12 7.6V12l3 1.8"/>',
    route: '<circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="6" r="2.2"/><path d="M8.2 18H13a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6.8"/>',
    warn: '<path d="M12 3.8 21 19.6H3z"/><path d="M12 9.3v4.4"/><circle cx="12" cy="16.9" r=".85" fill="currentColor" stroke="none"/>',
    arrowRight: '<path d="M4 12h15M14.5 6.5 20 12l-5.5 5.5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
    down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.9 12.5h9.2L17.5 7"/><path d="M10 11v5M14 11v5"/>',
    nav: '<path d="m3.6 11 16.8-7.2L13.2 20.6l-2.1-7.4z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="m4.8 12.4 4.7 4.7 9.7-10"/>',
  };
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.pin}</svg>`;
}
