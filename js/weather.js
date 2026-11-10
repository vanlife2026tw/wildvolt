/* =========================================================
   野電計畫 WildVolt — 天氣預報與「低溫／下雨」情境
   （純前端全域函式，風格與 engine.js / planner.js 一致）
   來源：
   - 預設 Open-Meteo（免金鑰）：https://api.open-meteo.com/v1/forecast
   - 選填升級 CWA 中央氣象署鄉鎮預報（F-D0047 系列，需授權碼）
   原則：絕不編造天氣數字；每個即時數字都標來源與更新時間；
   抓取失敗就回傳明確錯誤＋重試，不要用假數字填補。
   情境開關是手動「what-if」：預報再冷、雨再大都不會自動套用，
   只有使用者親自勾選才改變耗電／步行時間。
   ========================================================= */

"use strict";

/* ---------- 常數 ---------- */
const WEATHER_CACHE_MINUTES = 30;
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const CWA_BASE_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore";
const SCENARIO_KEY = "wildvolt_scenario";
const CWA_KEY = "wildvolt_cwa";
const COLD_THRESHOLD_C = 10; // 低溫情境定義：低於 10°C（任務指定）

/* 情境耗電因子（任務指定，白紙黑字寫在 UI 上）：
   下雨 EV 耗電 +8%  → 因子 1.08；低溫 EV 耗電 +10% → 因子 1.10；
   兩者疊加相乘 1.08 × 1.10 = 1.188。無情境 = 1.0。 */
const RAIN_ENERGY_FACTOR = 1.08;
const COLD_ENERGY_FACTOR = 1.10;
const RAIN_HIKE_FACTOR = 1.25; // 下雨步行時間 ×1.25（濕滑＋放慢）

/* ---------- 小工具（不依賴其他檔案，避免載入順序問題） ---------- */
function weatherEsc(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function weatherRound1(n) {
  return Math.round(Number(n) * 10) / 10;
}

/* localStorage 在 Node 測試環境可能不存在：讀不到就用記憶體備援，
   瀏覽器內一律走 localStorage（與 app.js 的 WV_KEY 做法一致）。 */
const _weatherMemStore = {};
function weatherLsGet(key) {
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      return localStorage.getItem(key);
    }
  } catch (err) { /* ignore：退回記憶體備援 */ }
  return Object.prototype.hasOwnProperty.call(_weatherMemStore, key)
    ? _weatherMemStore[key]
    : null;
}
function weatherLsSet(key, value) {
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      localStorage.setItem(key, value);
      return;
    }
  } catch (err) { /* ignore：退回記憶體備援 */ }
  _weatherMemStore[key] = value;
}
function weatherLsRemove(key) {
  try {
    if (typeof localStorage !== "undefined" && localStorage) {
      localStorage.removeItem(key);
      return;
    }
  } catch (err) { /* ignore */ }
  delete _weatherMemStore[key];
}

function weatherFetch() {
  if (typeof fetch === "function") return fetch;
  if (typeof globalThis !== "undefined" && typeof globalThis.fetch === "function") {
    return globalThis.fetch;
  }
  throw new Error("這個環境沒有 fetch，無法抓取天氣預報（請用支援網路的瀏覽器開啟）。");
}

function weatherCheckLatLng(lat, lng) {
  const la = Number(lat);
  const lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) {
    throw new Error("天氣預報需要有效的經緯度。");
  }
  if (la < -90 || la > 90 || lo < -180 || lo > 180) {
    throw new Error(`經緯度超出範圍：${lat}, ${lng}。`);
  }
  return { lat: la, lng: lo };
}

/* ---------- 情境狀態（localStorage "wildvolt_scenario"） ---------- */
/** 讀情境：{ rain: bool, cold: bool }，缺欄位／壞掉一律視為 false。 */
function getScenario() {
  try {
    const raw = weatherLsGet(SCENARIO_KEY);
    if (!raw) return { rain: false, cold: false };
    const parsed = JSON.parse(raw);
    return { rain: !!parsed.rain, cold: !!parsed.cold };
  } catch (err) {
    return { rain: false, cold: false };
  }
}

/** 寫情境（只合併傳入的欄位），回傳寫入後的新狀態。 */
function setScenario(patch) {
  const next = { ...getScenario(), ...(patch || {}) };
  next.rain = !!next.rain;
  next.cold = !!next.cold;
  weatherLsSet(SCENARIO_KEY, JSON.stringify(next));
  return next;
}

/** EV 耗電乘數：下雨 1.08、低溫 1.10、雙開 1.188、無情境 1.0。 */
function scenarioEnergyFactor(scn) {
  const s = scn || getScenario();
  const f = (s.rain ? RAIN_ENERGY_FACTOR : 1) * (s.cold ? COLD_ENERGY_FACTOR : 1);
  return Math.round(f * 10000) / 10000;
}

/** 步行時間乘數：下雨 ×1.25，否則 1.0（低溫不影響步行時間）。 */
function scenarioHikeFactor(scn) {
  const s = scn || getScenario();
  return s.rain ? RAIN_HIKE_FACTOR : 1.0;
}

/** 情境生效中的名稱清單，例如 ["下雨"]、["下雨", "低溫"]、[]。 */
function scenarioActiveNames(scn) {
  const s = scn || getScenario();
  const names = [];
  if (s.rain) names.push("下雨");
  if (s.cold) names.push("低溫");
  return names;
}

/**
 * 要顯示在 UI 的白紙黑字效果清單（繁體中文）：
 * 下雨＝步行時間 ×1.25、EV 耗電 +8%、步道濕滑提醒；
 * 低溫＝EV 耗電 +10%、過夜用電提醒；關掉＝恢復原數字。
 */
function scenarioNotes(scn) {
  const s = scn || getScenario();
  const notes = [];
  if (s.rain) {
    notes.push("下雨情境：EV 耗電 +8%（每度電里程 ×0.926），步行時間 ×1.25，步道濕滑、請放慢並注意落石與溪水。");
  }
  if (s.cold) {
    notes.push("低溫情境（低於 10°C）：EV 耗電 +10%（每度電里程 ×0.909），過夜開冷暖氣會再耗電，請多留電量。");
  }
  if (!notes.length) notes.push("情境已關閉，恢復原始數字（未加任何耗電／步行加成）。");
  return notes;
}

/** 情境摘要（給行程面板一次取齊）：因子、步行因子、生效名稱、效果清單。 */
function scenarioSummary(scn) {
  const s = scn || getScenario();
  return {
    scenario: s,
    energyFactor: scenarioEnergyFactor(s),
    hikeFactor: scenarioHikeFactor(s),
    activeNames: scenarioActiveNames(s),
    notes: scenarioNotes(s),
  };
}

/* ---------- 步道時間換算（詳情卡步道列是文字，如 "3 小時 30 分"） ---------- */
/** 把「3 小時 30 分／2.5 小時／90 分鐘／45 分」這類文字解析成分鐘；解析不到回傳 null（不編造）。 */
function parseHikeMinutes(text) {
  if (text === null || text === undefined) return null;
  const t = String(text).trim();
  if (!t) return null;
  let minutes = 0;
  let matched = false;
  const hourMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:小時|hr|h)/i);
  if (hourMatch) {
    minutes += Number(hourMatch[1]) * 60;
    matched = true;
  }
  const minMatch = t.match(/(\d+(?:\.\d+)?)\s*(?:分鐘|分|min)/);
  if (minMatch) {
    minutes += Number(minMatch[1]);
    matched = true;
  }
  if (!matched) return null;
  return Math.round(minutes);
}

/** 格式化分鐘數回中文：「65 分」→「1 小時 5 分」，0 分回傳原字串。 */
function formatHikeMinutes(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m <= 0) return "0 分";
  if (m < 60) return `${m} 分`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小時 ${rest} 分` : `${h} 小時`;
}

/**
 * 依情境因子調整步道時間文字。factor 省略時取 scenarioHikeFactor()。
 * 解析不到（例如 "約半天"）就原字串回傳，不編造數字。
 * 有套用時在尾巴註明「（已套用下雨情境 ×1.25）」。
 */
function adjustHikeTimeText(text, factor) {
  const f = Number(factor) || scenarioHikeFactor();
  const original = parseHikeMinutes(text);
  if (original === null) return String(text || "");
  if (!f || f === 1) return String(text || "");
  const adjusted = Math.round((original * f) / 5) * 5; // 四捨五入到 5 分鐘
  return `${formatHikeMinutes(adjusted)}（已套用下雨情境 ×${f}，原 ${formatHikeMinutes(original)}）`;
}

/* ---------- 天氣快取（同一座標 session 內 30 分鐘） ---------- */
const _weatherCache = new Map();
function weatherCacheKey(provider, lat, lng) {
  return `${provider}:${Number(lat).toFixed(3)},${Number(lng).toFixed(3)}`;
}
function weatherCacheGet(provider, lat, lng) {
  const hit = _weatherCache.get(weatherCacheKey(provider, lat, lng));
  if (!hit) return null;
  if (Date.now() - hit.at > WEATHER_CACHE_MINUTES * 60 * 1000) {
    _weatherCache.delete(weatherCacheKey(provider, lat, lng));
    return null;
  }
  return hit.data;
}
function weatherCachePut(provider, lat, lng, data) {
  _weatherCache.set(weatherCacheKey(provider, lat, lng), { at: Date.now(), data });
}
/** 清掉全部天氣快取（重試按鈕／換地點時用）。 */
function clearWeatherCache() {
  _weatherCache.clear();
}

/* ---------- Open-Meteo（預設來源，免金鑰） ---------- */
/**
 * 把 Open-Meteo 逐小時回傳解析成逐日摘要。
 * 輸入：fetch 回傳的 JSON（hourly.time / temperature_2m /
 * precipitation_probability / precipitation / wind_speed_10m）。
 * 輸出：{ source: "Open-Meteo", updatedAt, timezone, days: [
 *   { date, minTemp, maxTemp, maxRainProb, rainMm, maxWind } ] }。
 * 缺某個變數時該欄為 null，不拿 0 或前一天數字充數。
 */
function parseOpenMeteo(json) {
  if (!json || !json.hourly || !Array.isArray(json.hourly.time) || !json.hourly.time.length) {
    throw new Error("Open-Meteo 回傳格式不符預期（缺少 hourly.time），無法解析。");
  }
  const hourly = json.hourly;
  const n = hourly.time.length;
  const pick = (arr, i) => {
    if (!Array.isArray(arr)) return null;
    const v = Number(arr[i]);
    return Number.isFinite(v) ? v : null;
  };
  const byDay = new Map();
  for (let i = 0; i < n; i++) {
    const date = String(hourly.time[i]).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!byDay.has(date)) {
      byDay.set(date, {
        date, temps: [], rainProbs: [], rainMm: 0, hasRainMm: false, winds: [],
      });
    }
    const d = byDay.get(date);
    const t = pick(hourly.temperature_2m, i);
    if (t !== null) d.temps.push(t);
    const p = pick(hourly.precipitation_probability, i);
    if (p !== null) d.rainProbs.push(p);
    const r = pick(hourly.precipitation, i);
    if (r !== null) { d.rainMm += r; d.hasRainMm = true; }
    const w = pick(hourly.wind_speed_10m, i);
    if (w !== null) d.winds.push(w);
  }
  const days = [...byDay.values()].map((d) => ({
    date: d.date,
    minTemp: d.temps.length ? weatherRound1(Math.min(...d.temps)) : null,
    maxTemp: d.temps.length ? weatherRound1(Math.max(...d.temps)) : null,
    maxRainProb: d.rainProbs.length ? Math.round(Math.max(...d.rainProbs)) : null,
    rainMm: d.hasRainMm ? weatherRound1(d.rainMm) : null,
    maxWind: d.winds.length ? weatherRound1(Math.max(...d.winds)) : null,
  }));
  return {
    source: "Open-Meteo",
    sourceLabel: "Open-Meteo（免金鑰）",
    updatedAt: new Date().toISOString(),
    timezone: json.timezone || "auto",
    days,
  };
}

/**
 * 抓 Open-Meteo 未來 7 天逐小時預報（temperature_2m、
 * precipitation_probability、precipitation、wind_speed_10m，
 * timezone=auto）。失敗自動重試一次；兩次都失敗就拋出明確錯誤，
 * 絕不回傳編造的天氣。同一座標 30 分鐘內直接用快取，不重抓。
 */
async function fetchOpenMeteo(lat, lng, opts) {
  const { lat: la, lng: lo } = weatherCheckLatLng(lat, lng);
  const options = opts || {};
  if (!options.noCache) {
    const hit = weatherCacheGet("open-meteo", la, lo);
    if (hit) return hit;
  }
  const url = `${OPEN_METEO_URL}?latitude=${encodeURIComponent(la)}`
    + `&longitude=${encodeURIComponent(lo)}`
    + `&hourly=temperature_2m,precipitation_probability,precipitation,wind_speed_10m`
    + `&forecast_days=7&timezone=auto`;
  const doFetch = weatherFetch();
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await doFetch(url);
      if (!res || !res.ok) {
        throw new Error(`HTTP ${res ? res.status : "?"}`);
      }
      const json = await res.json();
      const parsed = parseOpenMeteo(json);
      weatherCachePut("open-meteo", la, lo, parsed);
      return parsed;
    } catch (err) {
      lastErr = err;
      if (attempt === 1) continue; // 重試一次
    }
  }
  throw new Error(`Open-Meteo 預報抓取失敗（已重試 1 次）：${lastErr ? lastErr.message : "未知錯誤"}。請檢查網路後按重試，不要用舊天氣判斷。`);
}

/* ---------- CWA 中央氣象署（選填升級，需授權碼） ---------- */
/**
 * 查證結果（2026-11-08，見 INTEGRATION.md §5）：
 * - F-D0047-061 是「臺北市未來 3 天」專用資料集，不是全台灣通用。
 *   22 縣市各有自己的 3 天版／1 週版編號（3 天版自 001 起每 4 號遞增，
 *   1 週版＝3 天版 +2），以下對照表取自 open-tw/cwa-sdk datasets.ts
 *   並與 opendata.cwa.gov.tw 資料集頁面交叉核對。
 * - locationName 查詢參數對 F-D0047 系列無過濾效果（實測仍回全縣市），
 *   所以一律抓全縣市、再依鄉鎮名在前端篩選，不帶 locationName。
 * - F-D0047 的元素為 Wx / MaxT / MinT / T / Td / RH / Wind / AT / CI /
 *   PoP（12 小時降雨機率）/ PoP6h（6 小時降雨機率）/
 *   WeatherDescription，沒有「降雨量」元素，因此 CWA 的 rainMm 固定為
 *   null（顯示「—」），絕不從機率反推雨量。
 */
const CWA_TOWNSHIP_3DAYS = {
  "宜蘭縣": "F-D0047-001", "桃園市": "F-D0047-005", "新竹縣": "F-D0047-009",
  "苗栗縣": "F-D0047-013", "彰化縣": "F-D0047-017", "南投縣": "F-D0047-021",
  "雲林縣": "F-D0047-025", "嘉義縣": "F-D0047-029", "屏東縣": "F-D0047-033",
  "臺東縣": "F-D0047-037", "花蓮縣": "F-D0047-041", "澎湖縣": "F-D0047-045",
  "基隆市": "F-D0047-049", "新竹市": "F-D0047-053", "嘉義市": "F-D0047-057",
  "臺北市": "F-D0047-061", "高雄市": "F-D0047-065", "新北市": "F-D0047-069",
  "臺中市": "F-D0047-073", "臺南市": "F-D0047-077", "連江縣": "F-D0047-081",
  "金門縣": "F-D0047-085",
};
/* 縣市中心概略座標（只用來「由經緯度選資料集」，非精確鄉鎮定位；
   邊界鄉鎮可能選錯縣，呼叫端有 POI 的 region／縣市名時請改傳 opts.county）。 */
const CWA_COUNTY_CENTERS = [
  ["臺北市", 25.032, 121.565], ["新北市", 25.012, 121.465], ["基隆市", 25.128, 121.741],
  ["桃園市", 24.993, 121.301], ["新竹市", 24.803, 120.968], ["新竹縣", 24.827, 121.013],
  ["苗栗縣", 24.561, 120.821], ["臺中市", 24.137, 120.686], ["彰化縣", 24.051, 120.516],
  ["南投縣", 23.960, 120.971], ["雲林縣", 23.709, 120.431], ["嘉義市", 23.480, 120.449],
  ["嘉義縣", 23.451, 120.389], ["臺南市", 22.991, 120.184], ["高雄市", 22.627, 120.301],
  ["屏東縣", 22.551, 120.548], ["宜蘭縣", 24.702, 121.738], ["花蓮縣", 23.987, 121.601],
  ["臺東縣", 22.797, 121.071], ["澎湖縣", 23.571, 119.579],
  ["金門縣", 24.437, 118.317], ["連江縣", 26.150, 119.928],
];

/** 依縣市名取 3 天版資料集編號；名稱含「台」會先轉「臺」再比對。找不到回傳 null。 */
function cwaDatasetForCounty(countyName) {
  if (!countyName) return null;
  const name = String(countyName).replaceAll("台", "臺").trim();
  if (CWA_TOWNSHIP_3DAYS[name]) return CWA_TOWNSHIP_3DAYS[name];
  const hit = Object.keys(CWA_TOWNSHIP_3DAYS).find((k) => name.includes(k) || k.includes(name));
  return hit ? CWA_TOWNSHIP_3DAYS[hit] : null;
}

/** 依經緯度取最近縣市中心的 3 天版資料集編號（概略，見上方註解）。 */
function cwaDatasetForLatLng(lat, lng) {
  const { lat: la, lng: lo } = weatherCheckLatLng(lat, lng);
  let best = null;
  let bestD = Infinity;
  for (const [name, cla, clo] of CWA_COUNTY_CENTERS) {
    const d = (la - cla) ** 2 + (lo - clo) ** 2;
    if (d < bestD) { bestD = d; best = name; }
  }
  return best ? { county: best, datasetId: CWA_TOWNSHIP_3DAYS[best] } : null;
}

/** CWA 授權碼（localStorage "wildvolt_cwa"，使用者自行輸入，40 碼）。 */
function getCwaKey() {
  const key = weatherLsGet(CWA_KEY);
  return key ? String(key).trim() : "";
}
function setCwaKey(key) {
  const k = String(key || "").trim();
  if (!k) weatherLsRemove(CWA_KEY);
  else weatherLsSet(CWA_KEY, k);
  return k;
}
function hasCwaKey() {
  return getCwaKey().length > 0;
}

/**
 * 把 CWA F-D0047 回傳解析成逐日摘要。
 * 輸入：fetch 回傳的 JSON（records.Locations[0].Location[]，
 * 每個 Location 有 WeatherElement[]，元素名 Wx / MaxT / MinT / T /
 * PoP / PoP6h / WeatherDescription，每個元素有 Time[]，每筆有
 * StartTime 與 ElementValue[0].value）。
 * opts.township 指定鄉鎮名時只回傳該鄉鎮，否則回傳全縣市 locations。
 * 輸出：{ source: "CWA", datasetId, county, updatedAt, locations: [
 *   { name, days: [{ date, minTemp, maxTemp, maxRainProb, rainMm: null,
 *   maxWind, wx }] } ] }。rainMm 固定 null（F-D0047 無降雨量元素）。
 */
function parseCwaForecast(json, opts) {
  const options = opts || {};
  const locations = json?.records?.Locations?.[0]?.Location;
  if (!Array.isArray(locations) || !locations.length) {
    throw new Error("CWA 回傳格式不符預期（缺少 records.Locations[0].Location），無法解析。");
  }
  const elementMap = (loc) => {
    const map = {};
    for (const el of loc.WeatherElement || []) {
      if (el && el.ElementName) map[el.ElementName] = el.Time || [];
    }
    return map;
  };
  const numVal = (timeEntry) => {
    const v = Number(timeEntry?.ElementValue?.[0]?.value);
    return Number.isFinite(v) ? v : null;
  };
  const textVal = (timeEntry) => {
    const v = timeEntry?.ElementValue?.[0]?.value;
    return v === undefined || v === null ? "" : String(v);
  };
  const parseOne = (loc) => {
    const els = elementMap(loc);
    const byDay = new Map();
    const dayOf = (startTime) => String(startTime || "").slice(0, 10);
    const ensure = (date) => {
      if (!byDay.has(date)) {
        byDay.set(date, { date, temps: [], rainProbs: [], wxList: [] });
      }
      return byDay.get(date);
    };
    for (const t of els.T || []) {
      const date = dayOf(t.StartTime);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const v = numVal(t);
      if (v !== null) ensure(date).temps.push(v);
    }
    // T 缺資料時退回 MaxT／MinT（12 小時分段）當日極值
    for (const t of [...(els.MaxT || []), ...(els.MinT || [])]) {
      const date = dayOf(t.StartTime);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const v = numVal(t);
      if (v !== null) ensure(date).temps.push(v);
    }
    for (const t of els.PoP6h || []) {
      const date = dayOf(t.StartTime);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const v = numVal(t);
      if (v !== null) ensure(date).rainProbs.push(v);
    }
    if (!(els.PoP6h || []).length) {
      for (const t of els.PoP || []) {
        const date = dayOf(t.StartTime);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
        const v = numVal(t);
        if (v !== null) ensure(date).rainProbs.push(v);
      }
    }
    for (const t of els.Wx || []) {
      const date = dayOf(t.StartTime);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const v = textVal(t);
      if (v) ensure(date).wxList.push(v);
    }
    const days = [...byDay.values()]
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((d) => ({
        date: d.date,
        minTemp: d.temps.length ? weatherRound1(Math.min(...d.temps)) : null,
        maxTemp: d.temps.length ? weatherRound1(Math.max(...d.temps)) : null,
        maxRainProb: d.rainProbs.length ? Math.round(Math.max(...d.rainProbs)) : null,
        rainMm: null, // F-D0047 無降雨量元素，不編造
        maxWind: null, // F-D0047 的 Wind 為文字（風向風速），不硬轉數字
        wx: d.wxList.length ? d.wxList[0] : "",
      }));
    return { name: loc.LocationName || "", days };
  };
  let list = locations.map(parseOne);
  if (options.township) {
    const tw = String(options.township).trim();
    const hit = list.find((l) => l.name === tw)
      || list.find((l) => l.name && (l.name.includes(tw) || tw.includes(l.name)));
    list = hit ? [hit] : [];
  }
  return {
    source: "CWA",
    sourceLabel: "中央氣象署（CWA）鄉鎮預報",
    datasetId: options.datasetId || "",
    county: options.county || "",
    updatedAt: new Date().toISOString(),
    locations: list,
  };
}

/**
 * 抓 CWA 鄉鎮逐 3 小時預報（F-D0047 系列）。
 * 簽名：fetchCwaForecast(lat, lng, key, opts)
 * - key 省略時改讀 localStorage "wildvolt_cwa"；沒有 key 就直接拋出
 *   NO_KEY 錯誤、完全不發請求（UI 收到此錯誤時整個 CWA 路徑不顯示）。
 * - opts.county（縣市名，如 "嘉義縣"）優先決定資料集；否則依經緯度
 *   取最近縣市中心（概略）；opts.datasetId 可直接指定編號。
 * - opts.township（鄉鎮名，如 "阿里山鄉"）指定時只回傳該鄉鎮。
 * 失敗自動重試一次；401 代表授權碼無效或已過期，會明說。
 * 注意：F-D0047-061 只是臺北市 3 天版，不要把它當全台灣通用編號。
 */
async function fetchCwaForecast(lat, lng, key, opts) {
  const { lat: la, lng: lo } = weatherCheckLatLng(lat, lng);
  const options = opts || {};
  const authKey = String(key || getCwaKey() || "").trim();
  if (!authKey) {
    const err = new Error("尚未設定 CWA 授權碼：請到行程分頁天氣區塊輸入中央氣象署授權碼（免付費申請），或繼續使用免金鑰的 Open-Meteo 預報。");
    err.code = "NO_KEY";
    throw err;
  }
  const county = options.county || (cwaDatasetForLatLng(la, lo) || {}).county || "";
  const datasetId = options.datasetId
    || cwaDatasetForCounty(county)
    || (cwaDatasetForLatLng(la, lo) || {}).datasetId
    || "F-D0047-061"; // 最後防線：只在完全無法判斷縣市時退回臺北市，並在回傳標明
  const cacheKey = `cwa:${datasetId}:${options.township || "all"}`;
  if (!options.noCache) {
    const hit = weatherCacheGet(cacheKey, la, lo);
    if (hit) return hit;
  }
  const url = `${CWA_BASE_URL}/${datasetId}?Authorization=${encodeURIComponent(authKey)}`;
  const doFetch = weatherFetch();
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await doFetch(url);
      if (!res) throw new Error("無回應");
      if (res.status === 401 || res.status === 403) {
        throw new Error("CWA 授權碼無效或已過期（HTTP 401／403），請重新申請並更新授權碼。");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (json?.success === "false" || json?.success === false) {
        throw new Error(`CWA 回傳失敗：${json?.message || "success=false"}。`);
      }
      const parsed = parseCwaForecast(json, {
        datasetId, county, township: options.township || "",
      });
      weatherCachePut(cacheKey, la, lo, parsed);
      return parsed;
    } catch (err) {
      lastErr = err;
      if (attempt === 1 && !(err && /401|403/.test(err.message))) continue; // 授權錯誤不重試
      break;
    }
  }
  throw new Error(`CWA 預報抓取失敗（已重試 1 次）：${lastErr ? lastErr.message : "未知錯誤"}。`);
}

/* ---------- 統一入口：有 CWA key 用 CWA，否則用 Open-Meteo ---------- */
/**
 * 取指定點的預報（給行程卡／詳情卡共用）。
 * opts: { county, township, datasetId, forceSource: "open-meteo" | "cwa" }
 * 回傳一律是 { provider, sourceLabel, updatedAt, days, ... }，
 * 其中 days 為逐日摘要陣列；CWA 且指定 township 時 days 為該鄉鎮的，
 * CWA 未指定 township 時 days 為該縣市第一個鄉鎮的（並在 note 註明）。
 * 失敗時拋出錯誤（由呼叫端顯示錯誤＋重試按鈕），不回傳假天氣。
 */
async function getForecastForPoint(point, opts) {
  const options = opts || {};
  const { lat, lng } = weatherCheckLatLng(point?.lat, point?.lng);
  const wantCwa = options.forceSource === "cwa"
    || (options.forceSource !== "open-meteo" && hasCwaKey());
  if (wantCwa) {
    const cwa = await fetchCwaForecast(lat, lng, "", {
      county: options.county || point?.county || point?.region || "",
      township: options.township || "",
      datasetId: options.datasetId || "",
    });
    const first = cwa.locations[0];
    return {
      provider: "cwa",
      source: "CWA",
      sourceLabel: cwa.sourceLabel,
      datasetId: cwa.datasetId,
      county: cwa.county,
      township: first ? first.name : (options.township || ""),
      updatedAt: cwa.updatedAt,
      days: first ? first.days : [],
      locations: cwa.locations,
      note: options.township || cwa.locations.length <= 1
        ? ""
        : `本縣市共 ${cwa.locations.length} 個鄉鎮，以下為 ${first ? first.name : "第一個鄉鎮"}；請在 opts.township 指定鄉鎮以精確顯示。`,
    };
  }
  const om = await fetchOpenMeteo(lat, lng);
  return {
    provider: "open-meteo",
    source: "Open-Meteo",
    sourceLabel: om.sourceLabel,
    updatedAt: om.updatedAt,
    timezone: om.timezone,
    days: om.days,
    township: "",
    note: "",
  };
}

/**
 * 只給「建議」，不自動套用：依預報判斷是否值得開啟情境。
 * 下雨建議：任一日最高降雨機率 ≥ 50% 或雨量 ≥ 5 mm；
 * 低溫建議：任一日最低溫 < 10°C。
 * 回傳 { rain: bool, cold: bool, reasons: [中文原因] }。
 */
function suggestScenarioFromForecast(forecast) {
  const days = (forecast && forecast.days) || [];
  let rain = false;
  let cold = false;
  const reasons = [];
  for (const d of days) {
    if (!rain && ((d.maxRainProb !== null && d.maxRainProb >= 50)
      || (d.rainMm !== null && d.rainMm >= 5))) {
      rain = true;
      reasons.push(`${d.date} 降雨機率高（${d.maxRainProb !== null ? `${d.maxRainProb}%` : `雨量 ${d.rainMm} mm`}），建議開啟下雨情境。`);
    }
    if (!cold && d.minTemp !== null && d.minTemp < COLD_THRESHOLD_C) {
      cold = true;
      reasons.push(`${d.date} 最低溫 ${d.minTemp}°C（低於 ${COLD_THRESHOLD_C}°C），建議開啟低溫情境。`);
    }
  }
  return { rain, cold, reasons };
}

/* ---------- 顯示文字（給 app.js／planner.js 注入，全部繁體中文） ---------- */
/** 單日摘要一行文字：「11/09（日） 12–19°C · 降雨機率最高 60% · 雨量 3.2 mm · 風速最高 18 km/h」。缺值顯示「—」。 */
function weatherDayText(day) {
  if (!day) return "";
  const temp = (day.minTemp !== null && day.maxTemp !== null)
    ? `${day.minTemp}–${day.maxTemp}°C`
    : (day.minTemp !== null ? `最低 ${day.minTemp}°C`
      : (day.maxTemp !== null ? `最高 ${day.maxTemp}°C` : "氣溫 —"));
  const rain = day.maxRainProb !== null ? `降雨機率最高 ${day.maxRainProb}%` : "降雨機率 —";
  const mm = day.rainMm !== null ? `雨量 ${day.rainMm} mm` : "雨量 —";
  const wind = day.maxWind !== null ? `風速最高 ${day.maxWind} km/h` : "";
  const wx = day.wx ? ` · ${day.wx}` : "";
  const dateTxt = String(day.date || "").slice(5).replace("-", "/");
  return `${dateTxt} ${temp} · ${rain} · ${mm}${wind ? ` · ${wind}` : ""}${wx}`;
}

/** 更新時間中文格式（zh-TW，24 小時制）。 */
function weatherUpdatedText(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleString("zh-TW", {
      month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch (err) {
    return "";
  }
}

/**
 * 預報區塊 HTML（行程卡／詳情卡共用）。forecast 為 getForecastForPoint 回傳；
 * 失敗時傳 null＋error 字串，改用 weatherErrorHtml()。
 * 內含來源、更新時間、逐日摘要、重試按鈕（data-act="retry-weather"，
 * 由協調員在事件層接上）、情境建議（只建議、不自動套用）。
 */
function weatherHtml(forecast, opts) {
  const options = opts || {};
  if (!forecast || !Array.isArray(forecast.days) || !forecast.days.length) {
    return weatherErrorHtml("尚無預報資料。", options);
  }
  const updated = weatherUpdatedText(forecast.updatedAt);
  const suggestion = suggestScenarioFromForecast(forecast);
  const suggestTxt = suggestion.reasons.length
    ? `<p class="wx-suggest">💡 預報提醒（只建議、不會自動套用）：${weatherEsc(suggestion.reasons.join(" "))}</p>`
    : "";
  const daysHtml = forecast.days.slice(0, 7).map((d) => {
    const coldMark = (d.minTemp !== null && d.minTemp < COLD_THRESHOLD_C) ? " ❄ 低溫" : "";
    const rainMark = (d.maxRainProb !== null && d.maxRainProb >= 50) ? " 🌧 高降雨機率" : "";
    return `<li>${weatherEsc(weatherDayText(d))}${coldMark}${rainMark}</li>`;
  }).join("");
  const place = forecast.township ? ` · ${weatherEsc(forecast.township)}` : "";
  return `<div class="wx-block">
    <div class="wx-head"><b>天氣預報${place}</b>
      <button type="button" class="mini-btn" data-act="retry-weather">重新抓取</button></div>
    <ul class="wx-days">${daysHtml}</ul>
    <p class="wx-meta">來源：${weatherEsc(forecast.sourceLabel || forecast.source || "—")} · 更新：${weatherEsc(updated || "—")}${forecast.datasetId ? ` · 資料集 ${weatherEsc(forecast.datasetId)}` : ""}</p>
    ${forecast.note ? `<p class="wx-meta">${weatherEsc(forecast.note)}</p>` : ""}
    ${suggestTxt}
  </div>`;
}

/** 預報失敗／尚無資料時的區塊 HTML：明說原因＋重試按鈕，絕不留白、絕不編數字。 */
function weatherErrorHtml(message, opts) {
  const options = opts || {};
  const retry = options.noRetry ? "" : `<button type="button" class="mini-btn" data-act="retry-weather">重試</button>`;
  return `<div class="wx-block wx-error">
    <b>天氣預報暫時無法顯示</b>
    <p>${weatherEsc(message || "預報抓取失敗，請檢查網路後重試。")}</p>
    <p class="wx-meta">來源：${weatherEsc(options.sourceLabel || "Open-Meteo（免金鑰）")} · 不會用舊天氣或假數字代替。</p>
    ${retry}
  </div>`;
}
