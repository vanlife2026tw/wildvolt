/* =========================================================
   野電計畫 WildVolt — 多日行程過夜充電排程與費用估算
   （Phase 3 功能 4，純前端、只讀 buildTripPlan 的回傳值再加工）

   不改 engine.js / 不改 buildTripPlan / 不改既有充電計畫數字。
   本檔只讀 plan.overnightStays / plan.legs / plan.charges /
   plan.days / plan.calc.capacity 的既有數字推算過夜充電，
   不重算里程、不重算耗電。

   過夜模式（與 engine.js EV_DEFAULTS.overnightMode 一致）：
   - camp-ac：車宿開冷暖氣／露營模式，每晚耗電約 10%（引擎已扣）。
     本檔依隔日行程需求（plan.legs 既有 energy、plan.charges
     既有途中補電）推算早上出發要夠用的 %，只補不足的部分。
   - no-drain：純休息不耗電，不排充電（回傳空陣列＋附註說明）。
   - camp-charge：營地接電慢充補到 95%（引擎已按 95% 計入隔日
     出發電量）。本檔算的是該晚要補幾度、約幾分鐘、約多少錢；
     「營地接電」本身是營地自有供電，不一定是公共充電站，
     附近公共充電站只用來取費率／當備援，找不到也不編造。

   費率規則（見 parsePrice）：
   - 站點 price 文字解析得到才用該站費率；解析不到一律用預設
     費率並標 rateEstimated: true，絕不編造費率。
   - 過夜充電發生在夜間，有尖峰／離峰雙費率時取「離峰」價。
   - 預設費率 NT$10/度只是估計預設值（見 DEFAULT_RATE 註解），
     使用者可用 renderRateEditor() 改，存在 localStorage。
   ========================================================= */

"use strict";

/* 預設費率：每度 NT$10。
   這是「估計預設值」：只有在充電站 price 文字解析不到費率時才用，
   不是任何業者的真實牌價；使用者可透過費率編輯器手動改。 */
const OVERNIGHT_DEFAULT_RATE = 10;
const OVERNIGHT_RATE_KEY = "wildvolt_default_rate";
/* 過夜充電站搜尋半徑（km），與 engine.js nearestCharger 預設 25 km 一致 */
const OVERNIGHT_CHARGER_RADIUS_KM = 25;
/* 過夜充電目標上限：不充到 100%，留緩衝 */
const OVERNIGHT_TARGET_CAP = 95;
/* camp-charge 的營地接電功率假設（kW）：只有在附近找不到公共
   充電站、需要估算「約幾分鐘」時才用，並會在 note 寫明是假設。 */
const OVERNIGHT_CAMPSITE_AC_KW = 7;
const OVERNIGHT_VIRTUAL_AC = { type: "AC", power: OVERNIGHT_CAMPSITE_AC_KW };

/** 預設費率（NT$/度）：讀 localStorage，非法值退回 10 */
function getDefaultRate() {
  try {
    const raw = typeof localStorage !== "undefined"
      ? localStorage.getItem(OVERNIGHT_RATE_KEY)
      : null;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 60) return n;
  } catch (err) { /* localStorage 不可用時用預設值 */ }
  return OVERNIGHT_DEFAULT_RATE;
}

/** 設定預設費率（NT$/度，接受 0–60）；非法值不寫入，回傳目前值 */
function setDefaultRate(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0 || v > 60) return getDefaultRate();
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(OVERNIGHT_RATE_KEY, String(v));
    }
  } catch (err) { /* 寫入失敗時只影響本次，不拋錯 */ }
  return v;
}

/* ---------- 內部小工具 ---------- */

function overnightNum(x, fallback) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

/** 全形數字／全形標點轉半形（price 文字常見 ／ ： 等全形符號） */
function overnightNormalize(text) {
  return String(text || "")
    .replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/[／]/g, "/")
    .replace(/[：]/g, ":");
}

/** 由 price 文字中找出某個費率數字所屬分段（以 · 。 ； 分段）的時段標籤 */
function overnightRateLabel(text, idx) {
  let start = 0;
  for (const sep of ["·", "。", "；"]) {
    const i = text.lastIndexOf(sep, idx - 1);
    if (i >= start) start = i + 1;
  }
  start = Math.max(start, idx - 40);
  const windowText = text.slice(start, idx + 4);
  if (/離峰|深夜|夜貓|夜省|夜間/.test(windowText)) return "離峰";
  if (/尖峰/.test(windowText)) return "尖峰";
  if (/一般|全時段|全天/.test(windowText)) return "一般";
  if (/假日/.test(windowText)) return "假日";
  if (/平日/.test(windowText)) return "平日";
  return "";
}

/**
 * 從充電站 price 文字解析 NT$/度。
 *
 * 真實格式（js/data-chargers-lux.js，719 站，2026/06 快照）歸納：
 *  1. 單一費率：「充電費率: 11.0 元/度」「10.0 元/度」「費用 $11 /度」
 *     「充電費 6.5 元/ kWh」「○每度8.8元計算」「每度$10元」
 *     「充電費用: 全時段 8.8 元/度」「DC:11元/度」
 *     「00:00 - 15:00 $ 6.9元 · 15:00 - 21:00 $ 11.9元」（裸 $ 金額）、
 *     「採8.8元充電費率計算」（N元＋充電）、
 *     「平日費率(度): $ 6.2 / $ 14.2」（裸金額成對價）。
 *  2. 尖峰／離峰雙費率（358 站含尖峰或離峰字樣）：
 *     「尖峰時間: 13.5 元/度 · 離峰時間: 6.5 元/度」
 *     「一般費率 $11 /度 · 離峰費率(0000 - 1100) $8.4 /度」
 *     「離峰 6.9 元 /kWh · 尖峰 13.5 元/ kWh」。
 *     過夜充電在夜間，優先取「離峰」價；無離峰標籤時取「一般／全時段」，
 *     再無標籤時取多段費率中的最低價（夜間時段多為低價段）。
 *  3. 只有分計費（約 70 站）：「充電費 1.25 元/分」「7元/分鐘」。
 *     沒有功率無法換算成每度電價，不換算、不編造，回傳 null。
 *  4. 無費率（50 站 price 為空，另有「尖峰時段為周一至週日 ·
 *     11:00-21:59」這類只有時段、沒有金額的文字）：
 *     回傳 null，由呼叫端用預設費率並標「電價為估計」。
 *  5. 「免費停車 30 分鐘」是停車費優惠，不是充電免費，不當成 0 元；
 *     只有文字明寫「充電免費／免費充電」才算 0 元。
 *  6. 部分文字在來源 KML 即被截斷（例如星晴 93 站的長字串斷在
 *     「週一至週五1」），但第一個費率數字仍在，照常解析。
 *
 * 回傳 { rate, estimated, kind, label, rates }：
 *  - rate：NT$/度（數字），解析不到為 null。
 *  - estimated：true 表示 rate 是解析不到、呼叫端須用預設值估計。
 *  - kind：single（單一費率）／off-peak（取離峰價）／general
 *    （取一般／全時段價）／multi-min（多段取最低）／free（充電免費）
 *    ／per-minute（只有分計費）／unknown（無費率資訊）。
 *  - rates：解析到的全部費率 [{ rate, label }]，供 UI 備查。
 */
function parsePrice(priceText) {
  const raw = String(priceText || "").trim();
  const unknown = { rate: null, estimated: true, kind: "unknown", label: "", rates: [] };
  if (!raw) return unknown;
  const text = overnightNormalize(raw);
  if (/充電[^·。]*免費|免費充電|充電免費/.test(text)) {
    return { rate: 0, estimated: false, kind: "free", label: "充電免費", rates: [{ rate: 0, label: "充電免費" }] };
  }
  const found = [];
  const seen = new Set();
  const push = (rate, idx) => {
    const n = Number(rate);
    if (!Number.isFinite(n) || n < 0 || n > 60) return;
    const label = overnightRateLabel(text, idx);
    const key = `${n}|${label}|${Math.floor(idx / 8)}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ rate: n, label });
  };
  const patterns = [
    { re: /(\d+(?:\.\d+)?)\s*元\s*\/\s*(?:每)?度/g },
    { re: /(\d+(?:\.\d+)?)\s*元\s*\/\s*kWh/gi },
    { re: /每度\s*\$?\s*(\d+(?:\.\d+)?)\s*元?/g },
    { re: /(\d+(?:\.\d+)?)\s*\/\s*元\s*kWh/gi },
    { re: /\$\s*(\d+(?:\.\d+)?)\s*\/\s*度/g },
    { re: /(\d+(?:\.\d+)?)\s*\/\s*度/g },
    { re: /\$\s*(\d+(?:\.\d+)?)\s*元(?!\s*\/)/g },
    { re: /(\d+(?:\.\d+)?)\s*元(?=\s*充電)/g },
    // 「平日費率(度): $ 6.2 / $ 14.2」這類裸金額成對價：只有整段文字
    // 含「度／kWh／費率」時才採信，避免把停車費誤當電價。
    { re: /\$\s*(\d+(?:\.\d+)?)(?=\s*\/\s*\$|\s*·|\s*\(|\s*$)/g, needsContext: true },
  ];
  for (const { re, needsContext } of patterns) {
    re.lastIndex = 0;
    if (needsContext && !/度|kWh|費率/.test(text)) continue;
    let m;
    while ((m = re.exec(text)) !== null) {
      push(m[1], m.index);
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  if (!found.length) {
    if (/元\s*\/\s*分|元\s*\/\s*分鐘/.test(text)) {
      return { rate: null, estimated: true, kind: "per-minute", label: "", rates: [] };
    }
    return unknown;
  }
  const distinct = [...new Set(found.map((f) => f.rate))];
  const offPeak = found.filter((f) => f.label === "離峰");
  const general = found.filter((f) => f.label === "一般");
  let picked;
  let kind;
  if (offPeak.length) {
    picked = offPeak[0];
    kind = "off-peak";
  } else if (general.length) {
    picked = general[0];
    kind = "general";
  } else if (distinct.length === 1) {
    picked = found[0];
    kind = "single";
  } else {
    picked = found.slice().sort((a, b) => a.rate - b.rate)[0];
    kind = "multi-min";
  }
  return {
    rate: picked.rate,
    estimated: false,
    kind,
    label: picked.label || (kind === "multi-min" ? "未標時段（取最低）" : ""),
    rates: found,
  };
}

/** 充電分鐘數：優先用 engine.js 現成的 chargeMinutes()，沒有時才用同式備援 */
function overnightChargeMinutes(charger, fromSoc, toSoc, capacity) {
  if (typeof chargeMinutes === "function") return chargeMinutes(charger, fromSoc, toSoc, capacity);
  const delta = Math.max(0, toSoc - fromSoc);
  if (delta <= 0) return 0;
  const isAC = charger.type === "AC" || charger.power < 22;
  const avgKW = isAC ? Math.max(3.5, charger.power * 0.85) : Math.min(charger.power, 120) * 0.72;
  const hours = ((delta / 100) * capacity) / avgKW;
  return isAC
    ? Math.max(30, Math.round((hours * 60) / 15) * 15)
    : Math.max(5, Math.round((hours * 60) / 5) * 5);
}

function overnightDistKm(a, b) {
  if (typeof haversine === "function" && a && b
    && Number.isFinite(Number(a.lat)) && Number.isFinite(Number(b.lat))) {
    return haversine(a, b);
  }
  return null;
}

function overnightCompatible(charger, vehicle) {
  if (!charger) return false;
  if (typeof isVehicleCompatible === "function") return isVehicleCompatible(charger, vehicle);
  const conn = String(vehicle?.connector || "CCS1").toUpperCase();
  const text = String(charger.connectors || charger.note || "").toUpperCase();
  if (text.includes(conn)) return true;
  if (conn === "CCS1" && /J1772/.test(text)) return true;
  if (charger.n7 && conn === "CCS1") return true;
  return false;
}

/**
 * 找過夜點附近的充電站（25 km 內、接頭相容者）。
 * 過夜時間長，慢充（AC）優先：有 AC 就取最近的 AC；沒有 AC 才取
 * engine.js nearestCharger() 的結果（DC 優先）；都沒有回傳 null。
 */
function findOvernightCharger(stayPoint, chargers, vehicle) {
  const list = Array.isArray(chargers) && chargers.length
    ? chargers
    : (typeof CHARGERS !== "undefined" ? CHARGERS : []);
  if (!stayPoint || !Array.isArray(list) || !list.length) return null;
  const cands = [];
  for (const c of list) {
    if (!c || !Number.isFinite(Number(c.lat)) || !Number.isFinite(Number(c.lng))) continue;
    if (!overnightCompatible(c, vehicle)) continue;
    const dist = overnightDistKm(stayPoint, c);
    if (dist !== null && dist > OVERNIGHT_CHARGER_RADIUS_KM) continue;
    cands.push({ charger: c, distKm: dist });
  }
  if (!cands.length) return null;
  const byDist = (a, b) => (a.distKm ?? 0) - (b.distKm ?? 0);
  const ac = cands
    .filter((x) => x.charger.type === "AC" || Number(x.charger.power) < 22)
    .sort(byDist);
  if (ac.length) return ac[0];
  if (typeof nearestCharger === "function") {
    const near = nearestCharger(stayPoint, list, OVERNIGHT_CHARGER_RADIUS_KM, vehicle);
    if (near && near.charger) return { charger: near.charger, distKm: near.dist ?? overnightDistKm(stayPoint, near.charger) };
  }
  return cands.sort((a, b) => {
    const da = a.charger.type === "DC" ? 0 : 1;
    const db = b.charger.type === "DC" ? 0 : 1;
    return (da - db) || byDist(a, b);
  })[0];
}

/** 由站點 price 或預設費率決定該晚的計費費率（不編造費率） */
function overnightRateFor(charger) {
  if (charger) {
    const parsed = parsePrice(charger.price);
    if (parsed.rate !== null) {
      return {
        rate: parsed.rate, rateEstimated: false, rateSource: "station",
        rateLabel: parsed.label || parsed.kind, rateKind: parsed.kind,
        rateNote: parsed.kind === "off-peak" ? "取該站離峰價（夜間充電）" : "",
      };
    }
    return {
      rate: getDefaultRate(), rateEstimated: true, rateSource: "default",
      rateLabel: "", rateKind: parsed.kind,
      rateNote: parsed.kind === "per-minute"
        ? "該站只有分計費（元/分），無法換算每度電價，費用以預設電價估計"
        : "該站未標示每度電價，費用以預設電價估計",
    };
  }
  return {
    rate: getDefaultRate(), rateEstimated: true, rateSource: "default",
    rateLabel: "", rateKind: "no-station",
    rateNote: "過夜點 25 公里內無相容公共充電站，費用以預設電價估計",
  };
}

/**
 * 過夜充電排程：輸入 buildTripPlan(plan) 的回傳 plan，
 * 輸出每晚一筆的陣列。
 * 每筆：{ night, day, stayName, stayId, charger, targetSoc, fromSoc,
 *   kwh, minutes, cost, rate, rateEstimated, rateSource, rateLabel,
 *   rateNote, mode, note }
 *  - night／day：plan.overnightStays 的 night（＝過夜那天的天數）。
 *  - charger：{ id, name, power, type, network, distKm }，無合適站為 null
 *    （原因寫在 note，不編造站點）。
 *  - targetSoc：該晚要充到的 %；kwh：約補幾度；minutes：約幾分鐘
 *    （engine.js chargeMinutes() 算）；cost：約 NT$（四捨五入到元）。
 *  - rateEstimated 為 true 時，cost 是用預設費率估的，UI 須標「電價為估計」。
 *  - 不需補電的晚上也會列一筆（kwh 0、cost 0、charger null），並寫明原因，
 *    讓分日卡片每晚都有交代。
 * 特殊回傳：no-drain 模式、或 plan 沒有跨日過夜段時，回傳空陣列，
 * 並在陣列上附 .note（說明文字）與 .mode，供接線端顯示。
 */
function overnightSchedule(plan, chargers) {
  const mode = plan?.overnightMode || "camp-ac";
  const capacity = overnightNum(plan?.calc?.capacity, 57);
  const vehicle = plan?.calc?.vehicle || null;
  const empty = (note) => {
    const out = [];
    out.note = note;
    out.mode = mode;
    return out;
  };
  if (mode === "no-drain") {
    return empty("過夜模式為「純休息不耗電」，不安排過夜充電。");
  }
  const stays = Array.isArray(plan?.overnightStays) ? plan.overnightStays : [];
  if (!stays.length) {
    const days = overnightNum(plan?.tripDays, 1);
    return empty(days <= 1
      ? "單日行程，無過夜，不需排過夜充電。"
      : "本行程沒有跨日過夜段（或最後一晚無隔日行程），無可排的過夜充電。");
  }
  const legs = Array.isArray(plan?.legs) ? plan.legs : [];
  const charges = Array.isArray(plan?.charges) ? plan.charges : [];
  const out = [];
  out.mode = mode;
  out.note = "";

  for (const stay of stays) {
    const night = overnightNum(stay.night, overnightNum(stay.day, 1));
    const stayPoint = stay.at || null;
    const stayName = stayPoint?.name || "過夜點";
    const stayId = stayPoint?.id || "";
    const socBefore = overnightNum(stay.socBefore ?? stay.beforeSoc, NaN);
    const socAfter = overnightNum(stay.socAfter ?? stay.afterSoc, socBefore);
    const base = {
      night, day: night, stayName, stayId, mode,
      charger: null, targetSoc: null, fromSoc: null,
      kwh: 0, minutes: 0, cost: 0, rate: null, rateEstimated: false,
      rateSource: "none", rateLabel: "", rateNote: "", note: "",
    };

    if (mode === "camp-charge") {
      /* 營地接電慢充補到 95%：fromSoc 是抵達過夜點電量（socBefore），
         引擎已把 socAfter 計成 95%，這裡只算該晚補的度數與費用。 */
      const targetSoc = OVERNIGHT_TARGET_CAP;
      const deltaPct = Math.max(0, targetSoc - socBefore);
      const kwhRaw = (deltaPct / 100) * capacity;
      base.fromSoc = Math.round(socBefore);
      base.targetSoc = targetSoc;
      if (kwhRaw <= 0) {
        base.note = `抵達「${stayName}」時已有 ${Math.round(socBefore)}%，已達 ${targetSoc}%，不需再充。`;
        out.push(base);
        continue;
      }
      const found = findOvernightCharger(stayPoint, chargers, vehicle);
      const minuteCharger = found ? found.charger : OVERNIGHT_VIRTUAL_AC;
      const rateInfo = overnightRateFor(found ? found.charger : null);
      base.charger = found
        ? { id: found.charger.id, name: found.charger.name, power: found.charger.power, type: found.charger.type, network: found.charger.network || "", distKm: found.distKm === null ? null : Math.round(found.distKm * 10) / 10 }
        : null;
      base.kwh = Math.round(kwhRaw * 10) / 10;
      base.minutes = overnightChargeMinutes(minuteCharger, socBefore, targetSoc, capacity);
      base.rate = rateInfo.rate;
      base.rateEstimated = rateInfo.rateEstimated;
      base.rateSource = rateInfo.rateSource;
      base.rateLabel = rateInfo.rateLabel;
      base.rateNote = rateInfo.rateNote;
      base.cost = Math.round(kwhRaw * rateInfo.rate);
      base.note = `營地接電慢充：${Math.round(socBefore)}% → ${targetSoc}%（約 ${base.kwh.toFixed(1)} 度，約 ${base.minutes} 分鐘）`
        + (found
          ? `；附近公共充電站「${found.charger.name}」（約 ${base.charger.distKm === null ? "?" : base.charger.distKm} km）可備援`
          : `；過夜點 25 公里內無相容公共充電站，時間以營地自有供電 7 kW 慢充假設估算，出發前請向營地確認供電與收費`)
        + (rateInfo.rateEstimated ? "；電價為估計" : "")
        + "。引擎已按接電到 95% 計入隔日出發電量。";
      out.push(base);
      continue;
    }

    /* camp-ac：依隔日行程需求推算早上出發要夠用的 %。
       只用 plan 既有數字：隔日各腿 energy、隔日已排的 charges（to-from）、
       隔日最後一腿的 need（終點預留／一般保留）。
       target = max(隔日總耗電% − 隔日途中已排補電% ＋ 隔日收尾預留%,
                    到隔日第一個補電點為止的累計耗電%（保守：含該腿整段）)，
       無條件進位、上限 95%。低於過夜後電量就不排。 */
    const nextDay = overnightNum(stay.nextDay, night + 1);
    const nextLegs = legs.filter((l) => Number(l.day) === nextDay);
    base.fromSoc = Math.round(socAfter);
    if (!nextLegs.length) {
      base.targetSoc = Math.round(socAfter);
      base.note = `隔日（第 ${nextDay} 天）無行程，不需過夜補電；過夜後電量 ${Math.round(socAfter)}%。`;
      out.push(base);
      continue;
    }
    const nextLegIdx = new Set(nextLegs.map((l) => l.index));
    const totalEnergyPct = nextLegs.reduce((s, l) => s + (overnightNum(l.energy, 0) / capacity) * 100, 0);
    const topUpPct = charges
      .filter((c) => nextLegIdx.has(c.legIndex))
      .reduce((s, c) => s + Math.max(0, overnightNum(c.to, 0) - overnightNum(c.from, 0)), 0);
    const endNeed = overnightNum(nextLegs[nextLegs.length - 1].need, overnightNum(plan?.reserve, 10));
    let cumPct = 0;
    let prefixPct = 0;
    let foundCharge = false;
    for (const leg of nextLegs) {
      cumPct += (overnightNum(leg.energy, 0) / capacity) * 100;
      if (!foundCharge && charges.some((c) => c.legIndex === leg.index)) {
        prefixPct = cumPct;
        foundCharge = true;
      }
    }
    if (!foundCharge) prefixPct = cumPct;
    const targetRaw = Math.max(totalEnergyPct - topUpPct + endNeed, prefixPct);
    const targetSoc = Math.min(OVERNIGHT_TARGET_CAP, Math.ceil(targetRaw));
    base.targetSoc = targetSoc;
    if (targetSoc <= socAfter) {
      base.note = `過夜後電量 ${Math.round(socAfter)}% 已足夠隔日行程（隔日共耗約 ${totalEnergyPct.toFixed(1)}% 電量`
        + (topUpPct > 0 ? `，隔日途中已排補電 ${Math.round(topUpPct)}%` : "，隔日無途中補電")
        + `，收尾需留 ${Math.round(endNeed)}%），不需過夜補電。`;
      out.push(base);
      continue;
    }
    const deltaPct = targetSoc - socAfter;
    const kwhRaw = (deltaPct / 100) * capacity;
    const found = findOvernightCharger(stayPoint, chargers, vehicle);
    const minuteCharger = found ? found.charger : OVERNIGHT_VIRTUAL_AC;
    const rateInfo = overnightRateFor(found ? found.charger : null);
    base.charger = found
      ? { id: found.charger.id, name: found.charger.name, power: found.charger.power, type: found.charger.type, network: found.charger.network || "", distKm: found.distKm === null ? null : Math.round(found.distKm * 10) / 10 }
      : null;
    base.kwh = Math.round(kwhRaw * 10) / 10;
    base.minutes = overnightChargeMinutes(minuteCharger, socAfter, targetSoc, capacity);
    base.rate = rateInfo.rate;
    base.rateEstimated = rateInfo.rateEstimated;
    base.rateSource = rateInfo.rateSource;
    base.rateLabel = rateInfo.rateLabel;
    base.rateNote = rateInfo.rateNote;
    base.cost = Math.round(kwhRaw * rateInfo.rate);
    base.note = `過夜補電：早上出發 ${Math.round(socAfter)}% → ${targetSoc}%（約 ${base.kwh.toFixed(1)} 度，約 ${base.minutes} 分鐘），`
      + `隔日共耗約 ${totalEnergyPct.toFixed(1)}% 電量`
      + (topUpPct > 0 ? `（隔日途中已排補電 ${Math.round(topUpPct)}%）` : "（隔日無途中補電）")
      + `，收尾需留 ${Math.round(endNeed)}%`
      + (targetRaw > OVERNIGHT_TARGET_CAP ? "；即使充到 95%，隔日仍需依原充電計畫途中補電" : "")
      + (found
        ? `；在「${found.charger.name}」（約 ${base.charger.distKm === null ? "?" : base.charger.distKm} km）充電`
        : `；過夜點 25 公里內無相容公共充電站，時間以 7 kW 慢充假設估算，請先確認營地／附近充電站`)
      + (rateInfo.rateEstimated ? "；電價為估計" : "")
      + "。";
    out.push(base);
  }
  return out;
}

/** 過夜充電合計（供行程總表「充電總費用估算」）：只加總本排程 */
function overnightTotalCost(schedule) {
  const rows = Array.isArray(schedule) ? schedule : [];
  let totalKwh = 0;
  let totalMinutes = 0;
  let totalCost = 0;
  let estimatedCount = 0;
  let chargedNights = 0;
  for (const r of rows) {
    totalKwh += overnightNum(r?.kwh, 0);
    totalMinutes += overnightNum(r?.minutes, 0);
    totalCost += overnightNum(r?.cost, 0);
    if (r?.rateEstimated && overnightNum(r?.kwh, 0) > 0) estimatedCount++;
    if (overnightNum(r?.kwh, 0) > 0) chargedNights++;
  }
  return {
    totalKwh: Math.round(totalKwh * 10) / 10,
    totalMinutes,
    totalCost,
    estimatedCount,
    chargedNights,
    nights: rows.length,
  };
}

/**
 * 行程中充電（plan.charges，既有數字不改）的費用估算：
 * 每筆 kwh = (to − from)% × 電池容量，費率取該站 price 解析值，
 * 解析不到用預設費率並標 rateEstimated。
 * 回傳 { items, totalKwh, totalMinutes, totalCost, estimatedCount }。
 */
function tripChargesCost(plan, chargers) {
  const capacity = overnightNum(plan?.calc?.capacity, 57);
  const list = Array.isArray(plan?.charges) ? plan.charges : [];
  const items = list.map((c) => {
    const kwhRaw = (Math.max(0, overnightNum(c.to, 0) - overnightNum(c.from, 0)) / 100) * capacity;
    const parsed = parsePrice(c.charger?.price);
    const estimated = parsed.rate === null;
    const rate = estimated ? getDefaultRate() : parsed.rate;
    return {
      legIndex: c.legIndex,
      chargerId: c.charger?.id || "",
      chargerName: c.charger?.name || "",
      from: Math.round(overnightNum(c.from, 0)),
      to: Math.round(overnightNum(c.to, 0)),
      kwh: Math.round(kwhRaw * 10) / 10,
      minutes: overnightNum(c.minutes, 0),
      rate,
      rateEstimated: estimated,
      rateSource: estimated ? "default" : "station",
      cost: Math.round(kwhRaw * rate),
    };
  });
  return {
    items,
    totalKwh: Math.round(items.reduce((s, x) => s + x.kwh, 0) * 10) / 10,
    totalMinutes: items.reduce((s, x) => s + x.minutes, 0),
    totalCost: items.reduce((s, x) => s + x.cost, 0),
    estimatedCount: items.filter((x) => x.rateEstimated && x.kwh > 0).length,
  };
}

/**
 * 充電總費用估算（行程中充電＋過夜充電合計），供行程總表顯示。
 * 回傳 { trip, overnight, schedule, totalKwh, totalMinutes, totalCost,
 *   estimatedCount, estimated }；estimated 為 true 表示合計含估計電價。
 */
function totalChargingCost(plan, chargers) {
  const schedule = overnightSchedule(plan, chargers);
  const overnight = overnightTotalCost(schedule);
  const trip = tripChargesCost(plan, chargers);
  return {
    trip,
    overnight,
    schedule,
    totalKwh: Math.round((trip.totalKwh + overnight.totalKwh) * 10) / 10,
    totalMinutes: trip.totalMinutes + overnight.totalMinutes,
    totalCost: trip.totalCost + overnight.totalCost,
    estimatedCount: trip.estimatedCount + overnight.estimatedCount,
    estimated: (trip.estimatedCount + overnight.estimatedCount) > 0,
  };
}

/**
 * 費率手動改編輯器：純 HTML 字串（不綁事件、不寫入任何檔案）。
 * 接線端把字串插進頁面後，用 bindRateEditor() 綁定儲存鈕，
 * 或自行監聽 #overnightRateSaveBtn 呼叫 setDefaultRate() 再重算。
 * 數字輸入框 id="overnightRateInput"，儲存鈕 id="overnightRateSaveBtn"。
 */
function renderRateEditor(currentRate) {
  const v = overnightNum(currentRate, getDefaultRate());
  return `<label class="overnight-rate-editor">預設電價
    <input id="overnightRateInput" type="number" min="0" max="60" step="0.1" value="${v}" aria-label="預設電價（每度新台幣元）" />
    <span>元/度</span>
    <button id="overnightRateSaveBtn" type="button" class="mini-btn">儲存電價</button>
  </label>
  <span class="overnight-rate-hint">未標示費率的充電站，費用以此預設電價估算（預設 NT$10/度）；已解析到站點費率者不受影響。</span>`;
}

/**
 * 綁定 renderRateEditor() 產生的儲存鈕（選用）。
 * container 省略時用 document；儲存成功後呼叫 onSaved(rate)，
 * 接線端在 onSaved 內重算 renderTrip() 即可。
 * 回傳 true 表示綁定成功。
 */
function bindRateEditor(container, onSaved) {
  const root = container || (typeof document !== "undefined" ? document : null);
  if (!root || typeof root.querySelector !== "function") return false;
  const input = root.querySelector("#overnightRateInput");
  const btn = root.querySelector("#overnightRateSaveBtn");
  if (!input || !btn) return false;
  btn.addEventListener("click", () => {
    const rate = setDefaultRate(input.value);
    input.value = String(rate);
    if (typeof onSaved === "function") onSaved(rate);
  });
  return true;
}
