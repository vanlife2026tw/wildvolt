/* ===== 充電站即時狀態（TDX）＋營地訂位深連結 =====
 * 純前端、無建置流程；預設不執行、不改既有計算，須由接線端呼叫才會打 API。
 *
 * 資料來源（2026-11-08 查證，見 phase3-work/f1-live-status/INTEGRATION.md）：
 * - TDX 交通部運輸資料流通服務，綠色運輸-充電樁 Swagger
 *   https://tdx.transportdata.tw/api/basic
 *   （OAS：https://tdx.transportdata.tw/webapi/File/Swagger/V3/b378d320-04a9-4fba-80b8-0df1b96dd5e8）
 * - 認證：OIDC Client Credentials 流程。先到 TDX 註冊會員，
 *   於「會員中心 -> 資料服務 -> API 金鑰」取得 Client Id / Client Secret，
 *   再以 POST 換 Bearer token（有效期 86400 秒 = 1 天）。
 * - 充電站基本資料（data.gov.tw 資料集 170220）：
 *   GET /v1/EV/Station/City/{City}?$format=JSON&$top=1000
 *   回傳 Stations[]，每站有 StationName{Zh_tw, En}、PositionLat、PositionLon。
 *   注意：Swagger 的 Station schema 未列出 StationID 欄位，本檔以
 *   StationID（若回傳有帶）為主鍵；若無，則以 ChargingPoint 橋接
 *   （見 linkLiveToStations），橋接失敗時該站狀態標「未知」，絕不亂配。
 * - 充電槍即時狀態（data.gov.tw 資料集 170224，每 1 分鐘更新）：
 *   GET /v1/EV/ConnectorLiveStatus/City/{City}?$format=JSON&$top=1000
 *   回傳 LiveStatuses[]，每槍有 StationID、ChargingPointID、ConnectorType、
 *   ConnectorStatus、LastUpdateTime。
 *   ConnectorStatus：1 = 可使用_閒置、2 = 不可使用_佔用或充電中、
 *   3 = 不可使用_異常故障。
 *   ConnectorType：1 CCS1、2 CCS2、3 CHAdeMO、4 Tesla_TPC、5 J1772、
 *   6 Mennekes_Type2、254 Others、255 Unknown。
 * - 高速公路服務區另有專用端點（無縣市參數）：
 *   GET /v1/EV/Station/Freeway/ServiceArea
 *   GET /v1/EV/ConnectorLiveStatus/Freeway/ServiceArea
 *
 * 安全提醒：Client Secret 只存使用者本機瀏覽器的 localStorage
 *（key "wildvolt_tdx"，使用者自行輸入），絕不寫進程式碼、不進版本控管；
 * token 只放記憶體，絕不寫 localStorage。瀏覽器直連會把 Secret 暴露給
 * 同源任何腳本，長期應改走後端代理（見 INTEGRATION.md「已知限制」）。
 * CORS 注意：TDX 未在官方文件保證瀏覽器直連可用；實務上瀏覽器 fetch
 * 極可能被 CORS 擋下，本檔把 TypeError / Failed to fetch 辨認為
 * cors_blocked，不編造狀態，UI 顯示查詢連結請使用者自行查詢。
 * （此判斷為啟發式：離線也會拋 TypeError，文案寫「疑似 CORS／網路被擋」。）
 */

var TDX_API_BASE = "https://tdx.transportdata.tw/api/basic";
var TDX_TOKEN_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";
var TDX_REGISTER_URL = "https://tdx.transportdata.tw/register";
var TDX_KEYS_URL = "https://tdx.transportdata.tw/user/dataservice/key";
var TDX_SWAGGER_URL = "https://tdx.transportdata.tw/api-service/swagger/basic/b378d320-04a9-4fba-80b8-0df1b96dd5e8";
var TDX_DATASET_STATION_URL = "https://data.gov.tw/dataset/170220";
var TDX_DATASET_LIVE_URL = "https://data.gov.tw/dataset/170224";
var TDX_STORAGE_KEY = "wildvolt_tdx";
var TDX_SOURCE_LABEL = "TDX 交通部運輸資料流通服務";
/* 即時狀態記憶體快取（毫秒）：同一批縣市 60 秒內不重打 TDX。 */
var TDX_LIVE_CACHE_MS = 60 * 1000;
/* token 提前 60 秒重換，避免用到過期邊緣的 token。 */
var TDX_TOKEN_EARLY_MS = 60 * 1000;

/* TDX 縣市 enum（Swagger 列舉，22 個）。WildVolt 充電站 region 為中文縣市＋鄉鎮，
   以 tdxCityForRegion() 對映；對不上的站不查詢、不報錯，狀態標「未知」。 */
var TDX_CITIES = [
  "Taipei", "NewTaipei", "Taoyuan", "Taichung", "Tainan", "Kaohsiung",
  "Keelung", "Hsinchu", "HsinchuCounty", "MiaoliCounty", "ChanghuaCounty",
  "NantouCounty", "YunlinCounty", "ChiayiCounty", "Chiayi", "PingtungCounty",
  "YilanCounty", "HualienCounty", "TaitungCounty", "KinmenCounty", "PenghuCounty",
];

/* region 前綴 -> TDX 縣市。注意新竹、嘉義有「市／縣」同名歧義，用鄉鎮區別：
   竹北／竹東／湖口／關西／新豐／新埔／寶山／橫山／尖石／五峰／峨眉／北埔 為新竹縣；
   東區／北區／香山 為新竹市；中埔／阿里山／番路／民雄／水上／竹崎／梅山 為嘉義縣；
   東區／西區 為嘉義市（嘉義市只有東、西兩區）。 */
var TDX_CITY_BY_PREFIX = [
  ["台北", "Taipei"], ["臺北", "Taipei"],
  ["新北", "NewTaipei"], ["桃園", "Taoyuan"], ["台中", "Taichung"],
  ["臺中", "Taichung"], ["台南", "Tainan"], ["臺南", "Tainan"],
  ["高雄", "Kaohsiung"], ["基隆", "Keelung"],
  ["新竹竹北", "HsinchuCounty"], ["新竹竹東", "HsinchuCounty"],
  ["新竹湖口", "HsinchuCounty"], ["新竹關西", "HsinchuCounty"],
  ["新竹新豐", "HsinchuCounty"], ["新竹新埔", "HsinchuCounty"],
  ["新竹寶山", "HsinchuCounty"], ["新竹橫山", "HsinchuCounty"],
  ["新竹尖石", "HsinchuCounty"], ["新竹五峰", "HsinchuCounty"],
  ["新竹峨眉", "HsinchuCounty"], ["新竹北埔", "HsinchuCounty"],
  ["新竹東區", "Hsinchu"], ["新竹北區", "Hsinchu"], ["新竹香山", "Hsinchu"],
  ["新竹", "HsinchuCounty"],
  ["苗栗", "MiaoliCounty"], ["彰化", "ChanghuaCounty"],
  ["南投", "NantouCounty"], ["雲林", "YunlinCounty"],
  ["嘉義中埔", "ChiayiCounty"], ["嘉義阿里山", "ChiayiCounty"],
  ["嘉義番路", "ChiayiCounty"], ["嘉義民雄", "ChiayiCounty"],
  ["嘉義水上", "ChiayiCounty"], ["嘉義竹崎", "ChiayiCounty"],
  ["嘉義梅山", "ChiayiCounty"], ["嘉義大林", "ChiayiCounty"],
  ["嘉義東區", "Chiayi"], ["嘉義西區", "Chiayi"],
  ["嘉義", "ChiayiCounty"],
  ["屏東", "PingtungCounty"], ["宜蘭", "YilanCounty"],
  ["花蓮", "HualienCounty"], ["台東", "TaitungCounty"],
  ["臺東", "TaitungCounty"], ["金門", "KinmenCounty"], ["澎湖", "PenghuCounty"],
];

/* 營地訂位平台（2026-11-08 查證）：
   愛露營 m.icamping.app 為 SPA 首頁，未找到穩定的關鍵字查詢參數
   （個別營區為 https://m.icamping.app/store/<店家代碼>，代碼無法由站名推導），
   故一律連到首頁，請使用者在站內搜尋營地名稱。
   露營樂「查訂空位」頁 https://www.easycamp.com.tw/reserve 亦未找到穩定的
   關鍵字查詢參數，故連到查訂空位頁，請使用者依日期／區域找營位。
   兩平台皆無「即時空位」公開 API，UI 必須加註「點進訂位頁確認」。 */
var CAMP_BOOKING_PLATFORMS = {
  icampingSearchUrl: "https://m.icamping.app/",
  easycampReserveUrl: "https://www.easycamp.com.tw/reserve",
};

/* ---------------- 小工具（與 engine.js 風格一致：全域函式） ---------------- */

function tdxEsc(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function tdxStorage() {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch (e) {
    return null;
  }
}

function tdxFetchImpl(opts) {
  if (opts && typeof opts.fetchImpl === "function") return opts.fetchImpl;
  if (typeof fetch !== "undefined") return fetch;
  return null;
}

function tdxIsCorsLikeError(err) {
  if (!err) return false;
  if (err.name === "TypeError") return true;
  var msg = String((err && err.message) || err);
  return /failed to fetch|networkerror|network request failed|load failed/i.test(msg);
}

function tdxFormatTime(iso) {
  if (!iso) return "";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  try {
    return d.toLocaleString("zh-TW", {
      month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
  } catch (e) {
    return d.toISOString();
  }
}

function tdxHaversineKm(lat1, lng1, lat2, lng2) {
  var r = 6371;
  var dLat = ((lat2 - lat1) * Math.PI) / 180;
  var dLng = ((lng2 - lng1) * Math.PI) / 180;
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180)
    * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * r * Math.asin(Math.sqrt(a));
}

/* ---------------- TDX 憑證（localStorage，只存使用者自行輸入的 Key） ---------------- */

function getTdxCredentials() {
  var store = tdxStorage();
  if (!store) return { clientId: "", clientSecret: "" };
  try {
    var raw = store.getItem(TDX_STORAGE_KEY);
    if (!raw) return { clientId: "", clientSecret: "" };
    var obj = JSON.parse(raw);
    return {
      clientId: String((obj && obj.clientId) || ""),
      clientSecret: String((obj && obj.clientSecret) || ""),
    };
  } catch (e) {
    return { clientId: "", clientSecret: "" };
  }
}

function hasTdxCredentials() {
  var c = getTdxCredentials();
  return !!(c.clientId && c.clientSecret);
}

function saveTdxCredentials(clientId, clientSecret) {
  var store = tdxStorage();
  if (!store) return false;
  try {
    store.setItem(TDX_STORAGE_KEY, JSON.stringify({
      clientId: String(clientId || ""),
      clientSecret: String(clientSecret || ""),
    }));
    /* 換憑證後，記憶體內的 token 快取立即失效，避免拿舊憑證的 token 續用。 */
    tdxTokenCache.token = "";
    tdxTokenCache.expiresAt = 0;
    tdxTokenCache.promise = null;
    return true;
  } catch (e) {
    return false;
  }
}

function clearTdxCredentials() {
  var store = tdxStorage();
  if (!store) return false;
  try {
    store.removeItem(TDX_STORAGE_KEY);
  } catch (e) { /* 忽略 */ }
  tdxTokenCache.token = "";
  tdxTokenCache.expiresAt = 0;
  tdxTokenCache.promise = null;
  return true;
}

/* ---------------- token（只放記憶體，絕不寫 localStorage） ---------------- */

var tdxTokenCache = { token: "", expiresAt: 0, promise: null };

function getTdxToken(opts) {
  var now = Date.now();
  if (tdxTokenCache.token && tdxTokenCache.expiresAt > now + TDX_TOKEN_EARLY_MS) {
    return Promise.resolve(tdxTokenCache.token);
  }
  if (tdxTokenCache.promise) return tdxTokenCache.promise;
  var creds = getTdxCredentials();
  if (!creds.clientId || !creds.clientSecret) {
    var noCred = new Error("未設定 TDX Key");
    noCred.code = "no_credentials";
    return Promise.reject(noCred);
  }
  var fetchImpl = tdxFetchImpl(opts);
  if (!fetchImpl) {
    var noFetch = new Error("此環境不支援 fetch，無法連線 TDX");
    noFetch.code = "no_fetch";
    return Promise.reject(noFetch);
  }
  var body = "grant_type=client_credentials"
    + "&client_id=" + encodeURIComponent(creds.clientId)
    + "&client_secret=" + encodeURIComponent(creds.clientSecret);
  tdxTokenCache.promise = fetchImpl(TDX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body,
  }).then(function (res) {
    if (!res || !res.ok) {
      var status = res ? res.status : 0;
      var err = new Error("TDX 換 token 失敗（HTTP " + status + "）");
      err.code = (status === 400 || status === 401 || status === 403) ? "auth_failed" : "http_error";
      err.httpStatus = status;
      throw err;
    }
    return res.json();
  }).then(function (data) {
    var token = data && data.access_token;
    if (!token) {
      var bad = new Error("TDX token 回傳缺少 access_token");
      bad.code = "http_error";
      throw bad;
    }
    var expiresIn = Number((data && data.expires_in) || 86400);
    if (!(expiresIn > 0)) expiresIn = 86400;
    tdxTokenCache.token = token;
    tdxTokenCache.expiresAt = Date.now() + expiresIn * 1000;
    tdxTokenCache.promise = null;
    return token;
  }).catch(function (err) {
    tdxTokenCache.promise = null;
    if (tdxIsCorsLikeError(err)) {
      var cors = new Error("TDX 不支援瀏覽器直連（疑似 CORS／網路被擋）");
      cors.code = "cors_blocked";
      cors.cause = err;
      throw cors;
    }
    throw err;
  });
  return tdxTokenCache.promise;
}

/* ---------------- 縣市對映 ---------------- */

function tdxCityForRegion(region, address) {
  var text = String(region || "") + String(address || "");
  if (!text) return "";
  var i;
  for (i = 0; i < TDX_CITY_BY_PREFIX.length; i++) {
    if (text.indexOf(TDX_CITY_BY_PREFIX[i][0]) === 0
      || text.indexOf(TDX_CITY_BY_PREFIX[i][0]) !== -1) {
      return TDX_CITY_BY_PREFIX[i][1];
    }
  }
  return "";
}

/* ---------------- 站名相似度（正規化＋Dice bigram） ---------------- */

function tdxNormalizeName(name) {
  return String(name || "")
    .replace(/臺/g, "台")
    .replace(/[\s　・·\-_,，。()（）\[\]【】「」""''']/g, "")
    .replace(/(超充站|快充站|充電站|充電樁|站)$/, "")
    .toLowerCase();
}

function tdxNameSimilarity(a, b) {
  var na = tdxNormalizeName(a);
  var nb = tdxNormalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.indexOf(nb) !== -1 || nb.indexOf(na) !== -1) return 1;
  if (na.length < 2 || nb.length < 2) return 0;
  var bigrams = function (s) {
    var out = {};
    var i;
    for (i = 0; i < s.length - 1; i++) {
      var g = s.slice(i, i + 2);
      out[g] = (out[g] || 0) + 1;
    }
    return out;
  };
  var ba = bigrams(na);
  var bb = bigrams(nb);
  var common = 0;
  var k;
  for (k in bb) {
    if (ba[k]) common += Math.min(ba[k], bb[k]);
  }
  return (2 * common) / ((na.length - 1) + (nb.length - 1));
}

/* ---------------- TDX 回傳整理 ---------------- */

/* TDX StationName 為 {Zh_tw, En}；取繁中，缺了才取英文。 */
function tdxStationName(station) {
  if (!station) return "";
  var n = station.StationName;
  if (n && typeof n === "object") return String(n.Zh_tw || n.En || "");
  return String(station.StationName || station.name || "");
}

function tdxStationId(station) {
  if (!station) return "";
  return String(station.StationID || station.StationId || station.stationId || "");
}

var TDX_CONNECTOR_STATUS_LABEL = { 1: "available", 2: "in_use", 3: "fault" };
var TDX_CONNECTOR_TYPE_LABEL = {
  1: "CCS1", 2: "CCS2", 3: "CHAdeMO", 4: "Tesla_TPC",
  5: "J1772", 6: "Mennekes_Type2", 254: "其他", 255: "未知",
};

function summarizeLiveStatus(rows) {
  var out = { total: 0, available: 0, inUse: 0, fault: 0, unknown: 0, updatedAt: "" };
  var latest = "";
  (rows || []).forEach(function (r) {
    if (!r) return;
    out.total += 1;
    var s = Number(r.ConnectorStatus);
    if (s === 1) out.available += 1;
    else if (s === 2) out.inUse += 1;
    else if (s === 3) out.fault += 1;
    else out.unknown += 1;
    var t = String(r.LastUpdateTime || "");
    if (t && (!latest || t > latest)) latest = t;
  });
  out.updatedAt = latest;
  if (out.available > 0) out.status = "available";
  else if (out.inUse > 0) out.status = "in_use";
  else if (out.fault > 0) out.status = "fault";
  else out.status = "unknown";
  return out;
}

/* 站名＋座標對上本地充電站。規則（最佳努力，寧可不配也不要亂配）：
   - 座標距離 < 1 km（opts.maxDistanceKm 可調，預設 1）；
   - 站名相似度 >= 0.4（opts.minNameScore 可調），或一方包含另一方；
   - 一座 TDX 站最多配一座本地站，取綜合分數最高者
     （分數 = 相似度 * 0.7 + (1 - 距離 km) * 0.3）。 */
function matchTdxStations(chargers, tdxStations, opts) {
  var maxDist = (opts && Number(opts.maxDistanceKm) > 0) ? Number(opts.maxDistanceKm) : 1;
  var minScore = (opts && Number(opts.minNameScore) >= 0) ? Number(opts.minNameScore) : 0.4;
  var pairs = [];
  (chargers || []).forEach(function (c, ci) {
    if (!c || !(Number(c.lat) >= -90) || !(Number(c.lng) >= -180)) return;
    (tdxStations || []).forEach(function (s, si) {
      var slat = Number(s.PositionLat);
      var slng = Number(s.PositionLon);
      if (!(slat >= -90) || !(slng >= -180)) return;
      var dist = tdxHaversineKm(Number(c.lat), Number(c.lng), slat, slng);
      if (dist >= maxDist) return;
      var sim = tdxNameSimilarity(c.name, tdxStationName(s));
      if (sim < minScore) return;
      pairs.push({ ci: ci, si: si, distKm: dist, nameScore: sim, score: sim * 0.7 + (1 - dist) * 0.3 });
    });
  });
  pairs.sort(function (a, b) { return b.score - a.score; });
  var usedCharger = {};
  var usedStation = {};
  var byCharger = {};
  pairs.forEach(function (p) {
    if (usedCharger[p.ci] || usedStation[p.si]) return;
    usedCharger[p.ci] = true;
    usedStation[p.si] = true;
    byCharger[p.ci] = p;
  });
  return (chargers || []).map(function (c, ci) {
    var p = byCharger[ci];
    if (!p) return { charger: c, station: null, distanceKm: null, nameScore: 0, matched: false };
    return {
      charger: c,
      station: tdxStations[p.si],
      distanceKm: p.distKm,
      nameScore: p.nameScore,
      matched: true,
    };
  });
}

/* 把 LiveStatus 列連到 TDX Station：
   1) Station 本身有 StationID：直接對。
   2) 否則以 ChargingPoint 橋接：ChargingPoint 列有 StationID＋ChargingPointID，
      LiveStatus 列有 ChargingPointID；再以 ChargingPoint 座標（若有）對 Station
      座標 < 0.2 km，或以 ChargingPoint 的 StationID 對 Station 的同名座標。
   3) 橋接失敗：該站回傳空列，狀態標「未知」，原因 tdx_station_no_live_link。 */
function linkLiveToStations(stations, liveRows, chargingPoints) {
  var byStationId = {};
  var i, r, sid;
  (liveRows || []).forEach(function (row) {
    if (!row) return;
    sid = String(row.StationID || row.StationId || "");
    if (!sid) return;
    (byStationId[sid] = byStationId[sid] || []).push(row);
  });
  /* 橋接表：ChargingPointID -> StationID；StationID -> 代表座標（若有）。 */
  var cpToStation = {};
  var stationCoordById = {};
  (chargingPoints || []).forEach(function (cp) {
    if (!cp) return;
    var cpId = String(cp.ChargingPointID || cp.ChargingPointId || "");
    var sId = String(cp.StationID || cp.StationId || "");
    if (cpId && sId) cpToStation[cpId] = sId;
    var lat = Number(cp.PositionLat);
    var lng = Number(cp.PositionLon);
    if (sId && lat >= -90 && lng >= -180 && !stationCoordById[sId]) {
      stationCoordById[sId] = { lat: lat, lng: lng };
    }
  });
  var out = [];
  for (i = 0; i < (stations || []).length; i++) {
    var st = stations[i];
    var id = tdxStationId(st);
    var rows = [];
    if (id && byStationId[id]) {
      rows = byStationId[id];
    } else if (id && stationCoordById[id]) {
      /* StationID 已知但 LiveStatus 無此 ID：可能為空站，維持空列。 */
      rows = [];
    } else {
      /* 無 StationID：找與本站座標 < 0.2 km 的 ChargingPoint 代表座標，
         再以其 StationID 取 LiveStatus；找不到就空列（未知，不亂配）。 */
      var slat = Number(st.PositionLat);
      var slng = Number(st.PositionLon);
      var bridgedId = "";
      if (slat >= -90 && slng >= -180) {
        var candId;
        for (candId in stationCoordById) {
          var cc = stationCoordById[candId];
          if (tdxHaversineKm(slat, slng, cc.lat, cc.lng) < 0.2) { bridgedId = candId; break; }
        }
      }
      if (bridgedId && byStationId[bridgedId]) rows = byStationId[bridgedId];
      /* 最後一招：LiveStatus 若無 StationID 但有 ChargingPointID 且
         ChargingPoint 表可對到本站座標相近的樁，上面橋接已涵蓋；其餘不猜。 */
      void cpToStation;
    }
    out.push({ station: st, stationId: id, liveRows: rows });
  }
  return out;
}

/* ---------------- TDX 取資料（單一縣市／國道服務區） ---------------- */

function tdxGetJson(url, token, fetchImpl) {
  return fetchImpl(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  }).then(function (res) {
    if (!res) {
      var empty = new Error("TDX 無回應");
      empty.code = "http_error";
      throw empty;
    }
    if (res.status === 304) return {};
    if (!res.ok) {
      var err = new Error("TDX 查詢失敗（HTTP " + res.status + "）");
      err.code = (res.status === 401 || res.status === 403) ? "auth_failed"
        : (res.status === 429) ? "rate_limited" : "http_error";
      err.httpStatus = res.status;
      throw err;
    }
    return res.json();
  }).catch(function (err) {
    if (err && err.code) throw err;
    if (tdxIsCorsLikeError(err)) {
      var cors = new Error("TDX 不支援瀏覽器直連（疑似 CORS／網路被擋）");
      cors.code = "cors_blocked";
      cors.cause = err;
      throw cors;
    }
    throw err;
  });
}

function tdxCityQuery(city, kind, token, fetchImpl, top) {
  var path = kind === "station"
    ? "/v1/EV/Station/City/" + encodeURIComponent(city)
    : "/v1/EV/ConnectorLiveStatus/City/" + encodeURIComponent(city);
  var url = TDX_API_BASE + path + "?$format=JSON&$top=" + (top || 1000);
  return tdxGetJson(url, token, fetchImpl);
}

function tdxFreewayQuery(kind, token, fetchImpl, top) {
  var path = kind === "station"
    ? "/v1/EV/Station/Freeway/ServiceArea"
    : "/v1/EV/ConnectorLiveStatus/Freeway/ServiceArea";
  var url = TDX_API_BASE + path + "?$format=JSON&$top=" + (top || 1000);
  return tdxGetJson(url, token, fetchImpl);
}

function tdxChargingPointQuery(city, token, fetchImpl, top) {
  var url = TDX_API_BASE + "/v1/EV/ChargingPoint/City/" + encodeURIComponent(city)
    + "?$format=JSON&$top=" + (top || 1000);
  return tdxGetJson(url, token, fetchImpl);
}

/* 60 秒記憶體快取：key 為縣市＋國道旗標，避免 renderTrip 重繪時狂打 TDX。 */
var tdxLiveCache = {};

function tdxCacheGet(key) {
  var hit = tdxLiveCache[key];
  if (!hit) return null;
  if (Date.now() - hit.at > TDX_LIVE_CACHE_MS) { delete tdxLiveCache[key]; return null; }
  return hit.data;
}

function tdxCacheSet(key, data) {
  tdxLiveCache[key] = { at: Date.now(), data: data };
}

/* ---------------- 主入口：查一批充電站的即時狀態 ----------------
 * 絕不拋錯（程式錯誤以外的失敗都包成 status 物件回傳，UI 據此顯示＋重試）：
 * 回傳：
 * {
 *   ok, status: ok | no_credentials | auth_failed | cors_blocked |
 *               rate_limited | http_error | network_error | no_fetch | empty,
 *   message, detail, source, updatedAt, updatedAtText, citiesQueried[],
 *   results: [{ charger, matched, tdxStationName, tdxStationId, distanceKm,
 *     nameScore, status: available | in_use | fault | unknown | not_in_tdx,
 *     available, inUse, fault, total, updatedAt, text, reason }]
 * }
 * status 單站語意：available 可用、in_use 使用中、fault 故障、
 * unknown 未知（含未設定 Key／查不到對應／TDX 無即時資料）、
 * not_in_tdx TDX 無此站（基本資料就對不上，非即時狀態問題）。 */
function fetchTdxLiveStatus(chargers, opts) {
  opts = opts || {};
  var list = Array.isArray(chargers) ? chargers : [];
  var fetchImpl = tdxFetchImpl(opts);
  var top = Number(opts.top) > 0 ? Number(opts.top) : 1000;

  var base = function (status, message, detail, results) {
    return {
      ok: status === "ok",
      status: status,
      message: message,
      detail: detail || "",
      source: TDX_SOURCE_LABEL,
      updatedAt: "",
      updatedAtText: "",
      citiesQueried: [],
      results: results || [],
    };
  };
  var unknownResults = function (reason, text) {
    return list.map(function (c) {
      return {
        charger: c, matched: false, tdxStationName: "", tdxStationId: "",
        distanceKm: null, nameScore: 0, status: "unknown",
        available: 0, inUse: 0, fault: 0, total: 0,
        updatedAt: "", text: text, reason: reason,
      };
    });
  };

  if (!list.length) {
    return Promise.resolve(base("empty", "沒有要查詢的充電站", "", []));
  }
  if (!fetchImpl) {
    return Promise.resolve(base("no_fetch", "此環境不支援 fetch，無法連線 TDX",
      "請改用一般瀏覽器開啟本頁。", unknownResults("no_fetch", "無法連線 TDX")));
  }
  if (!hasTdxCredentials()) {
    return Promise.resolve(base("no_credentials", "未設定 TDX Key",
      "請先到 TDX 平台註冊會員並建立 API Key（Client Id／Client Secret），"
      + "再到「電動車」分頁輸入。註冊：" + TDX_REGISTER_URL,
      unknownResults("no_credentials", "未設定 TDX Key")));
  }

  /* 依 region 分縣市；對不上縣市的站不查詢，原因 no_city_mapping。 */
  var cityOf = {};
  var cities = [];
  var citySeen = {};
  list.forEach(function (c, idx) {
    var city = tdxCityForRegion((c && c.region) || "", (c && c.address) || "");
    cityOf[idx] = city;
    if (city && !citySeen[city]) { citySeen[city] = true; cities.push(city); }
  });
  var wantFreeway = !!opts.includeFreeway || list.some(function (c) {
    return !!(c && (c.highway || /服務區|休息站/.test(String(c.name || ""))));
  });
  var cacheKey = cities.slice().sort().join(",") + "|fw:" + (wantFreeway ? "1" : "0");
  var cached = tdxCacheGet(cacheKey);

  var runQueries = function (token) {
    var jobs = cities.map(function (city) {
      return Promise.all([
        tdxCityQuery(city, "station", token, fetchImpl, top),
        tdxCityQuery(city, "live", token, fetchImpl, top),
      ]).then(function (pair) {
        return { city: city, stations: pair[0], live: pair[1] };
      });
    });
    if (wantFreeway) {
      jobs.push(Promise.all([
        tdxFreewayQuery("station", token, fetchImpl, top),
        tdxFreewayQuery("live", token, fetchImpl, top),
      ]).then(function (pair) {
        return { city: "Freeway", stations: pair[0], live: pair[1] };
      }));
    }
    return Promise.all(jobs);
  };

  var buildResults = function (cityDataList) {
    var allStations = [];
    var allLive = [];
    var allChargingPoints = [];
    var latestUpdate = "";
    cityDataList.forEach(function (cd) {
      var stations = (cd.stations && cd.stations.Stations) || [];
      var live = (cd.live && cd.live.LiveStatuses) || [];
      allStations = allStations.concat(stations);
      allLive = allLive.concat(live);
      [cd.stations, cd.live].forEach(function (w) {
        var t = String((w && (w.SrcUpdateTime || w.UpdateTime)) || "");
        if (t && (!latestUpdate || t > latestUpdate)) latestUpdate = t;
      });
      live.forEach(function (r) {
        var t = String((r && r.LastUpdateTime) || "");
        if (t && (!latestUpdate || t > latestUpdate)) latestUpdate = t;
      });
    });
    /* 只有當任一 Station 缺 StationID 時，才補打 ChargingPoint 橋接。
       （橋接查詢走同一 token；失敗不致命，降級為未知。） */
    var needBridge = allStations.some(function (s) { return !tdxStationId(s); });
    var bridgeStep = Promise.resolve([]);
    if (needBridge && cities.length) {
      bridgeStep = Promise.all(cities.map(function (city) {
        return tdxChargingPointQuery(city, tdxTokenCache.token, fetchImpl, top)
          .then(function (w) { return (w && w.ChargingPoints) || []; })
          .catch(function () { return []; });
      })).then(function (parts) {
        var out = [];
        parts.forEach(function (p) { out = out.concat(p); });
        return out;
      });
    }
    return bridgeStep.then(function (cps) {
      allChargingPoints = cps;
      var linked = linkLiveToStations(allStations, allLive, allChargingPoints);
      var linkedStations = linked.map(function (l) { return l.station; });
      var liveByStation = {};
      linked.forEach(function (l) {
        liveByStation[linkedStations.indexOf(l.station)] = l.liveRows;
      });
      var matched = matchTdxStations(list, linkedStations, opts);
      var results = matched.map(function (m, idx) {
        var city = cityOf[idx];
        if (!city && !wantFreeway) {
          return {
            charger: m.charger, matched: false, tdxStationName: "", tdxStationId: "",
            distanceKm: null, nameScore: 0, status: "unknown",
            available: 0, inUse: 0, fault: 0, total: 0, updatedAt: "",
            text: "此站所在縣市無法對應 TDX 縣市，無法查詢",
            reason: "no_city_mapping",
          };
        }
        if (!m.matched) {
          return {
            charger: m.charger, matched: false, tdxStationName: "", tdxStationId: "",
            distanceKm: null, nameScore: 0, status: "not_in_tdx",
            available: 0, inUse: 0, fault: 0, total: 0, updatedAt: "",
            text: "TDX 無此站",
            reason: "not_in_tdx",
          };
        }
        var si = linkedStations.indexOf(m.station);
        var rows = liveByStation[si] || [];
        var sum = summarizeLiveStatus(rows);
        var stationId = tdxStationId(m.station);
        var name = tdxStationName(m.station);
        if (!rows.length) {
          return {
            charger: m.charger, matched: true, tdxStationName: name,
            tdxStationId: stationId, distanceKm: m.distanceKm, nameScore: m.nameScore,
            status: "unknown", available: 0, inUse: 0, fault: 0, total: 0,
            updatedAt: "", text: "TDX 有此站，但無即時槍態可對應",
            reason: "tdx_station_no_live_link",
          };
        }
        var text = tdxStatusTextForSummary(sum);
        return {
          charger: m.charger, matched: true, tdxStationName: name,
          tdxStationId: stationId, distanceKm: m.distanceKm, nameScore: m.nameScore,
          status: sum.status, available: sum.available, inUse: sum.inUse,
          fault: sum.fault, total: sum.total, updatedAt: sum.updatedAt,
          text: text, reason: "",
        };
      });
      var out = base("ok", "即時狀態更新完成", "", results);
      out.updatedAt = latestUpdate;
      out.updatedAtText = tdxFormatTime(latestUpdate);
      out.citiesQueried = cities.slice();
      if (wantFreeway) out.citiesQueried.push("Freeway");
      return out;
    });
  };

  var fetchAll = function () {
    if (cached) return Promise.resolve(cached);
    return getTdxToken(opts).then(function (token) {
      return runQueries(token);
    }).then(function (cityDataList) {
      return buildResults(cityDataList);
    }).then(function (out) {
      if (out.ok) tdxCacheSet(cacheKey, out);
      return out;
    });
  };

  return fetchAll().catch(function (err) {
    var code = (err && err.code) || "http_error";
    if (code === "no_credentials") {
      return base("no_credentials", "未設定 TDX Key",
        "請先到 TDX 平台註冊會員並建立 API Key，再到「電動車」分頁輸入。註冊：" + TDX_REGISTER_URL,
        unknownResults("no_credentials", "未設定 TDX Key"));
    }
    if (code === "auth_failed") {
      return base("auth_failed", "TDX 憑證錯誤",
        "Client Id／Client Secret 不正確或已失效，請到「電動車」分頁重新輸入。"
        + "金鑰頁面：" + TDX_KEYS_URL,
        unknownResults("auth_failed", "TDX 憑證錯誤，請重新輸入 Key"));
    }
    if (code === "cors_blocked") {
      return base("cors_blocked", "TDX 不支援瀏覽器直連",
        "瀏覽器直連請求被擋（疑似 CORS／網路問題），無法直接顯示即時狀態。"
        + "請改到 TDX 查詢，或改走後端代理。TDX：" + TDX_SWAGGER_URL,
        unknownResults("cors_blocked", "TDX 不支援瀏覽器直連"));
    }
    if (code === "rate_limited") {
      return base("rate_limited", "TDX 查詢太頻繁，請稍後再試",
        "已達 TDX 頻率限制，請等候 1 分鐘後按重試。",
        unknownResults("rate_limited", "TDX 查詢太頻繁，請稍後再試"));
    }
    if (code === "no_fetch") {
      return base("no_fetch", "此環境不支援 fetch，無法連線 TDX", "",
        unknownResults("no_fetch", "無法連線 TDX"));
    }
    return base("http_error", "TDX 查詢失敗，請重試",
      (err && err.message) ? String(err.message) : "",
      unknownResults("http_error", "TDX 查詢失敗，請重試"));
  });
}

/* ---------------- 顯示文字／HTML（繁體中文，一律標來源與更新時間） ---------------- */

var TDX_STATUS_LABEL = {
  available: "可用", in_use: "使用中", fault: "故障",
  unknown: "未知", not_in_tdx: "TDX 無此站",
};

function tdxStatusTextForSummary(sum) {
  if (!sum || !sum.total) return "即時狀態未知";
  var label = TDX_STATUS_LABEL[sum.status] || "未知";
  if (sum.status === "available") {
    return "可用 " + sum.available + " 槍／共 " + sum.total + " 槍"
      + (sum.inUse ? " · 使用中 " + sum.inUse + " 槍" : "")
      + (sum.fault ? " · 故障 " + sum.fault + " 槍" : "");
  }
  if (sum.status === "in_use") {
    return "使用中 " + sum.inUse + " 槍／共 " + sum.total + " 槍（暫無空槍）";
  }
  if (sum.status === "fault") {
    return "故障 " + sum.fault + " 槍／共 " + sum.total + " 槍";
  }
  return label + "（共 " + sum.total + " 槍）";
}

function tdxStatusText(result) {
  if (!result || !result.charger) return "";
  if (result.status === "not_in_tdx") return "TDX 無此站";
  if (result.reason === "no_credentials") return "未設定 TDX Key";
  if (result.reason === "cors_blocked") return "TDX 不支援瀏覽器直連";
  if (result.reason === "auth_failed") return "TDX 憑證錯誤";
  if (result.reason === "no_city_mapping") return "此站無法對應 TDX 縣市";
  if (!result.matched || !result.total) return result.text || "即時狀態未知";
  var text = tdxStatusTextForSummary(result);
  var time = result.updatedAt ? " · " + tdxFormatTime(result.updatedAt) : "";
  return text + " · 來源 TDX" + time;
}

/* 單站即時狀態 HTML（接線端直接 innerHTML 插入；內含重試按鈕 data-tdx-retry）。
   失敗時顯示原因＋重試，不留白；成功時標來源與更新時間。 */
function tdxStatusHtml(result, opts) {
  opts = opts || {};
  if (!result) return "";
  var tone = result.status === "available" ? "ok"
    : result.status === "fault" ? "error"
    : result.status === "in_use" ? "warn" : "";
  var text = tdxEsc(tdxStatusText(result));
  var liveFor = (result.charger && result.charger.id)
    ? ' data-tdx-live-for="' + tdxEsc(result.charger.id) + '"' : "";
  var retry = (opts.showRetry !== false
    && (result.status === "unknown" || result.status === "not_in_tdx" || result.reason))
    ? ' <button type="button" class="mini-btn" data-tdx-retry="1">重試</button>' : "";
  var tdxLink = ' <a href="' + TDX_SWAGGER_URL + '" target="_blank" rel="noopener">TDX 查詢</a>';
  var extra = "";
  if (result.reason === "cors_blocked" || result.reason === "no_credentials") extra = tdxLink;
  return '<span class="live-status tdx-live" data-tone="' + tone + '"' + liveFor + '>'
    + "⚡ 即時：" + text + extra + "</span>" + retry;
}

/* 整批查詢的狀態列 HTML（放在充電計畫／目的地周邊清單上方）。 */
function tdxBatchStatusHtml(batch, opts) {
  opts = opts || {};
  if (!batch) return "";
  var tone = batch.ok ? "ok" : (batch.status === "no_credentials" ? "warn" : "error");
  var text = tdxEsc(batch.message || "");
  var time = batch.updatedAtText ? "（" + tdxEsc(batch.updatedAtText) + " · 來源 TDX）" : "（來源 TDX）";
  var retry = batch.ok ? "" : ' <button type="button" class="mini-btn" data-tdx-retry="1">重試</button>';
  var link = (batch.status === "cors_blocked" || batch.status === "no_credentials")
    ? ' <a href="' + TDX_SWAGGER_URL + '" target="_blank" rel="noopener">TDX 查詢</a>' : "";
  return '<div class="live-status tdx-batch" data-tone="' + tone + '" data-tdx-batch="1">'
    + "⚡ 充電站即時狀態：" + text + time + link + retry + "</div>";
}

/* ---------------- 營地訂位深連結 ----------------
 * camp 為 CAMP_POIS／CAR_POIS 物件（id、name、cat、region、lat、lng）。
 * 兩平台皆無穩定的「站名關鍵字」查詢 URL（查證見檔頭），故回傳平台入口連結，
 * 請使用者在站內搜尋營地名稱；絕不編造「?keyword=站名」這類未驗證的參數。
 * 若資料日後補上 camp.icampingCode（愛露營店家代碼，如 "ms737"），
 * 才回傳個別營區深連結 https://m.icamping.app/store/<代碼>；
 * camp.easycampUrl 若有填，也直接採用。
 * 車宿點（cat === "car"）多為停車場，未必有訂位頁，文案會註明僅供找附近營區。 */
function campBookingLinks(camp) {
  if (!camp) return [];
  var name = String(camp.name || "");
  var isCar = camp.cat === "car";
  var icampingUrl = CAMP_BOOKING_PLATFORMS.icampingSearchUrl;
  var icampingNote = name
    ? "站內搜尋「" + name + "」"
    : "站內搜尋營地名稱";
  if (camp.icampingCode) {
    icampingUrl = "https://m.icamping.app/store/" + encodeURIComponent(String(camp.icampingCode));
    icampingNote = "直接開啟「" + (name || "此營地") + "」的愛露營訂位頁";
  }
  var easycampUrl = camp.easycampUrl || CAMP_BOOKING_PLATFORMS.easycampReserveUrl;
  var easycampNote = name
    ? "查訂空位頁可依日期與區域找營位；搜尋「" + name + "」"
    : "查訂空位頁可依日期與區域找營位";
  var carNote = isCar ? "車宿點多為停車場，未必有訂位頁，僅供找附近營區參考。" : "";
  return [
    {
      platform: "icamping",
      label: "愛露營搜尋",
      url: icampingUrl,
      note: icampingNote + "。即時空位無公開 API，點進訂位頁確認。" + carNote,
    },
    {
      platform: "easycamp",
      label: "露營樂查訂空位",
      url: easycampUrl,
      note: easycampNote + "。即時空位無公開 API，點進訂位頁確認。" + carNote,
    },
  ];
}

/* 營地詳情卡用的 HTML（接線端直接插入 renderDetail 的營地／車宿分支）。 */
function campBookingHtml(camp) {
  var links = campBookingLinks(camp);
  if (!links.length) return "";
  var items = links.map(function (l) {
    return '<a class="mini-btn" href="' + tdxEsc(l.url) + '" target="_blank" rel="noopener">'
      + tdxEsc(l.label) + "</a>";
  }).join(" ");
  return '<div class="pc-access"><div class="pc-access-title">訂位</div>'
    + "<p>" + items + "</p>"
    + '<p class="pc-note">' + tdxEsc(links[0].note) + "</p></div>";
}

/* Node 測試用（瀏覽器下 module 不存在，不影響）。 */
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    TDX_API_BASE: TDX_API_BASE,
    TDX_TOKEN_URL: TDX_TOKEN_URL,
    TDX_REGISTER_URL: TDX_REGISTER_URL,
    TDX_KEYS_URL: TDX_KEYS_URL,
    TDX_SWAGGER_URL: TDX_SWAGGER_URL,
    TDX_STORAGE_KEY: TDX_STORAGE_KEY,
    TDX_CITIES: TDX_CITIES,
    getTdxCredentials: getTdxCredentials,
    hasTdxCredentials: hasTdxCredentials,
    saveTdxCredentials: saveTdxCredentials,
    clearTdxCredentials: clearTdxCredentials,
    getTdxToken: getTdxToken,
    tdxCityForRegion: tdxCityForRegion,
    tdxNormalizeName: tdxNormalizeName,
    tdxNameSimilarity: tdxNameSimilarity,
    tdxHaversineKm: tdxHaversineKm,
    tdxStationName: tdxStationName,
    summarizeLiveStatus: summarizeLiveStatus,
    matchTdxStations: matchTdxStations,
    linkLiveToStations: linkLiveToStations,
    fetchTdxLiveStatus: fetchTdxLiveStatus,
    tdxStatusText: tdxStatusText,
    tdxStatusHtml: tdxStatusHtml,
    tdxBatchStatusHtml: tdxBatchStatusHtml,
    campBookingLinks: campBookingLinks,
    campBookingHtml: campBookingHtml,
  };
}
