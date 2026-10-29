/* ===== 充電站示範資料（N7 使用 CCS1） =====
   注意：站點位置、功率與營業狀態為概略示範值，
   出發前請以 U-Power / EVALUE / iCharging / PlugShare 確認。 */

const CHARGER_STATS = {};

const CURATED_CHARGERS = [
  { id: "ch-neihu", name: "U-Power 內湖民權站", network: "U-Power", lat: 25.0680, lng: 121.5740, alt: 10, power: 360, type: "DC", region: "台北內湖", note: "CCS1 ×2，24 小時" },
  { id: "ch-zhonghe", name: "U-Power 中和建一站", network: "U-Power", lat: 24.9980, lng: 121.4870, alt: 20, power: 360, type: "DC", region: "新北中和", note: "CCS1 ×2，24 小時" },
  { id: "ch-zhongli", name: "U-Power 中壢環中站", network: "U-Power", lat: 24.9550, lng: 121.2200, alt: 130, power: 360, type: "DC", region: "桃園中壢", note: "CCS1 ×2，24 小時" },
  { id: "ch-zhubei", name: "U-Power 竹北光明站", network: "U-Power", lat: 24.8260, lng: 121.0150, alt: 40, power: 360, type: "DC", region: "新竹竹北", note: "CCS1 ×2，24 小時" },
  { id: "ch-gongguan", name: "U-Power 苗栗公館站", network: "U-Power", lat: 24.5480, lng: 120.8230, alt: 100, power: 180, type: "DC", region: "苗栗公館", note: "CCS1 ×2" },
  { id: "ch-wuri", name: "U-Power 台中烏日站", network: "U-Power", lat: 24.1040, lng: 120.6200, alt: 40, power: 360, type: "DC", region: "台中南屯", note: "CCS1 ×4，近國道 1" },
  { id: "ch-yuanlin", name: "U-Power 員林站", network: "U-Power", lat: 23.9600, lng: 120.5750, alt: 30, power: 180, type: "DC", region: "彰化員林", note: "CCS1 ×2" },
  { id: "ch-caotun", name: "U-Power 草屯站", network: "U-Power", lat: 23.9770, lng: 120.6870, alt: 110, power: 180, type: "DC", region: "南投草屯", note: "CCS1 ×2，往埔里／清境" },
  { id: "ch-puli", name: "U-Power 埔里站", network: "U-Power", lat: 23.9660, lng: 120.9640, alt: 450, power: 180, type: "DC", region: "南投埔里", note: "CCS1 ×2，往清境／日月潭" },
  { id: "ch-dounan", name: "U-Power 斗南站", network: "U-Power", lat: 23.6800, lng: 120.4800, alt: 35, power: 180, type: "DC", region: "雲林斗南", note: "CCS1 ×2" },
  { id: "ch-zhongpu", name: "U-Power 嘉義中埔站", network: "U-Power", lat: 23.4300, lng: 120.5200, alt: 70, power: 180, type: "DC", region: "嘉義中埔", note: "CCS1 ×2，近國道 3" },
  { id: "ch-rende", name: "U-Power 台南仁德站", network: "U-Power", lat: 22.9350, lng: 120.2450, alt: 20, power: 360, type: "DC", region: "台南仁德", note: "CCS1 ×4" },
  { id: "ch-nanzi", name: "U-Power 高雄楠梓站", network: "U-Power", lat: 22.7280, lng: 120.3300, alt: 30, power: 360, type: "DC", region: "高雄楠梓", note: "CCS1 ×4" },
  { id: "ch-fangliao", name: "U-Power 枋寮站", network: "U-Power", lat: 22.3670, lng: 120.5920, alt: 15, power: 180, type: "DC", region: "屏東枋寮", note: "CCS1 ×2，往墾丁／台東" },
  { id: "ch-taimali", name: "U-Power 太麻里站", network: "U-Power", lat: 22.6110, lng: 120.9900, alt: 30, power: 120, type: "DC", region: "台東太麻里", note: "CCS1 ×2，南迴入口" },
  { id: "ch-taitung", name: "U-Power 台東更生站", network: "U-Power", lat: 22.7580, lng: 121.1400, alt: 25, power: 180, type: "DC", region: "台東市", note: "CCS1 ×2" },
  { id: "ch-yuli", name: "U-Power 花蓮玉里站", network: "U-Power", lat: 23.3350, lng: 121.3120, alt: 140, power: 120, type: "DC", region: "花蓮玉里", note: "CCS1 ×2，縱谷中繼" },
  { id: "ch-hualien", name: "U-Power 花蓮中央站", network: "U-Power", lat: 23.9900, lng: 121.6050, alt: 20, power: 180, type: "DC", region: "花蓮市", note: "CCS1 ×2" },
  { id: "ch-jiaoxi", name: "U-Power 礁溪站", network: "U-Power", lat: 24.8000, lng: 121.7700, alt: 25, power: 180, type: "DC", region: "宜蘭礁溪", note: "CCS1 ×2，雪隧前" },
  { id: "ch-suao", name: "蘇澳服務區 iCharging", network: "iCharging", lat: 24.5940, lng: 121.8330, alt: 20, power: 200, type: "DC", region: "宜蘭蘇澳", note: "CCS1 ×2，國道 5 終點" },
  { id: "ch-hukou", name: "湖口服務區充電站", network: "國道服務區", lat: 24.8700, lng: 121.0200, alt: 90, power: 200, type: "DC", region: "新竹湖口", note: "CCS1 快充，國道一號服務區", highway: "nh1", highwayKm: 86 },
  { id: "ch-qingshui", name: "清水服務區充電站", network: "國道服務區", lat: 24.2800, lng: 120.5900, alt: 60, power: 200, type: "DC", region: "台中清水", note: "CCS1 快充，國道三號服務區", highway: "nh3", highwayKm: 172 },
  { id: "ch-dongshan", name: "東山服務區充電站", network: "國道服務區", lat: 23.3200, lng: 120.4300, alt: 60, power: 200, type: "DC", region: "台南東山", note: "CCS1 快充，國道三號服務區", highway: "nh3", highwayKm: 322 },
  { id: "ch-guanxi", name: "關西服務區充電站", network: "國道服務區", lat: 24.7900, lng: 121.1700, alt: 150, power: 200, type: "DC", region: "新竹關西", note: "CCS1 快充，國道三號服務區", highway: "nh3", highwayKm: 79 },
  { id: "ch-xihu", name: "西湖服務區充電站", network: "國道服務區", lat: 24.5600, lng: 120.7400, alt: 80, power: 200, type: "DC", region: "苗栗西湖", note: "CCS1 快充，國道三號服務區", highway: "nh3", highwayKm: 141 },
  { id: "ch-xiangshan", name: "U-Power 新竹香山站", network: "U-Power", lat: 24.7800, lng: 120.9200, alt: 30, power: 180, type: "DC", region: "新竹香山", note: "CCS1 ×2，台 61 線" },
  { id: "ch-qingjing", name: "清境統一渡假村 AC", network: "目的地充電", lat: 24.0570, lng: 121.1600, alt: 1740, power: 7, type: "AC", region: "南投仁愛", note: "CCS1／J1772，住宿客優先，建議自備線" },
  { id: "ch-wuling", name: "武陵農場旅客中心 AC", network: "目的地充電", lat: 24.3500, lng: 121.3100, alt: 1750, power: 7, type: "AC", region: "台中和平", note: "慢充，需向場方確認使用方式" },
  { id: "ch-alishan", name: "阿里山遊客中心 AC", network: "目的地充電", lat: 23.5100, lng: 120.8030, alt: 2200, power: 7, type: "AC", region: "嘉義阿里山", note: "慢充，車位有限" },
  { id: "ch-sunmoon", name: "日月潭中興停車場", network: "EVALUE", lat: 23.8660, lng: 120.9110, alt: 750, power: 60, type: "DC", region: "南投魚池", note: "CCS1 ×2" },
  { id: "ch-kenting", name: "墾丁福華渡假飯店 AC", network: "目的地充電", lat: 21.9450, lng: 120.7480, alt: 10, power: 7, type: "AC", region: "屏東恆春", note: "慢充，住宿客優先" },
  { id: "ch-tamsui", name: "U-Power 淡水站", network: "U-Power", lat: 25.1800, lng: 121.4400, alt: 20, power: 180, type: "DC", region: "新北淡水", note: "CCS1 ×2" },
  { id: "ch-sa-zhongli", name: "中壢服務區充電站", network: "國道服務區", lat: 25.0041, lng: 121.2518, alt: 100, power: 200, type: "DC", region: "桃園中壢", note: "CCS1 快充，國道一號服務區", highway: "nh1", highwayKm: 55 },
  { id: "ch-sa-yangmei", name: "楊梅休息站充電站", network: "國道休息站", lat: 24.9200, lng: 121.1350, alt: 130, power: 120, type: "DC", region: "桃園楊梅", note: "CCS1 快充，國道一號休息站", highway: "nh1", highwayKm: 71 },
  { id: "ch-sa-taian", name: "泰安服務區充電站", network: "國道服務區", lat: 24.3274, lng: 120.7155, alt: 110, power: 200, type: "DC", region: "台中后里", note: "CCS1 快充，國道一號服務區", highway: "nh1", highwayKm: 159 },
  { id: "ch-sa-xiluo", name: "西螺服務區充電站", network: "國道服務區", lat: 23.7950, lng: 120.4550, alt: 35, power: 200, type: "DC", region: "雲林西螺", note: "CCS1 快充，國道一號服務區", highway: "nh1", highwayKm: 230 },
  { id: "ch-sa-xinying", name: "新營服務區充電站", network: "國道服務區", lat: 23.3390, lng: 120.3124, alt: 25, power: 200, type: "DC", region: "台南後壁", note: "CCS1 快充，國道一號服務區", highway: "nh1", highwayKm: 284 },
  { id: "ch-sa-rende", name: "仁德服務區充電站", network: "國道服務區", lat: 22.9103, lng: 120.2542, alt: 20, power: 200, type: "DC", region: "台南仁德", note: "CCS1 快充，國道一號服務區", highway: "nh1", highwayKm: 330 },
  { id: "ch-sa-baoshan", name: "寶山休息站充電站", network: "國道休息站", lat: 24.7580, lng: 121.0050, alt: 120, power: 120, type: "DC", region: "新竹寶山", note: "CCS1 快充，國道三號休息站", highway: "nh3", highwayKm: 100 },
  { id: "ch-sa-muzha", name: "木柵休息站充電站", network: "國道休息站", lat: 24.9850, lng: 121.5840, alt: 120, power: 200, type: "DC", region: "台北木柵", note: "CCS1 快充，國道三號休息站", highway: "nh3", highwayKm: 25 },
  { id: "ch-sa-shiding", name: "石碇服務區充電站", network: "國道服務區", lat: 25.0068, lng: 121.6352, alt: 200, power: 200, type: "DC", region: "新北石碇", note: "CCS1 快充，國道五號服務區", highway: "nh5", highwayKm: 4 },
  { id: "ch-suao", name: "蘇澳服務區充電站", network: "國道服務區", lat: 24.6145, lng: 121.8258, alt: 30, power: 200, type: "DC", region: "宜蘭蘇澳", note: "CCS1 快充，國道五號服務區", highway: "nh5", highwayKm: 54 },
  { id: "ch-sa-nantou", name: "南投服務區充電站", network: "國道服務區", lat: 23.9120, lng: 120.6870, alt: 110, power: 200, type: "DC", region: "南投南投", note: "CCS1 快充，國道三號服務區", highway: "nh3", highwayKm: 235 },
  { id: "ch-sa-gukeng", name: "古坑服務區充電站", network: "國道服務區", lat: 23.6088, lng: 120.5448, alt: 90, power: 200, type: "DC", region: "雲林古坑", note: "CCS1 快充，國道三號服務區", highway: "nh3", highwayKm: 270 },
  { id: "ch-sa-guanmiao", name: "關廟服務區充電站", network: "國道服務區", lat: 22.9288, lng: 120.3531, alt: 60, power: 200, type: "DC", region: "台南龍崎", note: "CCS1 快充，國道三號服務區", highway: "nh3", highwayKm: 363 },
  { id: "ch-jinshan", name: "U-Power 金山站", network: "U-Power", lat: 25.2200, lng: 121.6300, alt: 15, power: 120, type: "DC", region: "新北金山", note: "CCS1 ×2，北海岸" },
];

/* ===== 合併充電站：策展站點（功率準確）＋ LuxClub（全台涵蓋） =====
   同一個站點只留一筆：座標 4 位小數相同或相距 < 250 m 視為同一站，
   並保留策展資料的功率與備註（verified: true）。 */
function chargerKey(c) {
  return Number(c.lat).toFixed(4) + "," + Number(c.lng).toFixed(4);
}

function inferChargerAlt(c) {
  if (Number(c.alt) > 0) return Number(c.alt);
  const text = `${c.region || ""} ${c.name || ""} ${c.address || ""}`;
  if (/武嶺|合歡/.test(text)) return 3100;
  if (/阿里山/.test(text)) return 2200;
  if (/清境|仁愛|武陵|梨山/.test(text)) return 1750;
  if (/杉林溪/.test(text)) return 1600;
  if (/隙頂|石棹|奮起湖/.test(text)) return 1250;
  if (/溪頭/.test(text)) return 1150;
  if (/魚池|日月潭|邵月/.test(text)) return 740;
  if (/埔里/.test(text)) return 450;
  if (/竹山|鹿谷/.test(text)) return 160;
  if (/中埔|番路|觸口|吳鳳/.test(text)) return 85;
  return 30;
}

const CHARGERS = (() => {
  const out = [];
  const seen = new Set();
  const lux = typeof LUX_CHARGERS !== "undefined" ? LUX_CHARGERS : [];
  const rows = CURATED_CHARGERS.length + lux.length;
  for (const c of CURATED_CHARGERS) {
    const defaultConn = c.type === "AC" ? "J1772" : "CCS1";
    out.push({
      ...c,
      alt: inferChargerAlt(c),
      connectors: c.connectors || defaultConn,
      verified: true,
      n7: true,
    });
    seen.add(chargerKey(c));
  }
  // 只跟「策展站點」比對距離，避免把 LuxClub 同區域的不同站點吃掉
  const nearCurated = (c) =>
    CURATED_CHARGERS.some(
      (o) =>
        Math.abs(Number(o.lat) - Number(c.lat)) < 0.0025 &&
        Math.abs(Number(o.lng) - Number(c.lng)) < 0.0025
    );
  for (const c of lux) {
    const key = chargerKey(c);
    if (seen.has(key)) continue;
    if (nearCurated(c)) continue;
    out.push({
      ...c,
      alt: inferChargerAlt(c),
    });
    seen.add(key);
  }
  const dc = out.filter((c) => c.type === "DC").length;
  CHARGER_STATS.source = rows;
  CHARGER_STATS.total = out.length;
  CHARGER_STATS.dc = dc;
  CHARGER_STATS.ac = out.length - dc;
  CHARGER_STATS.merged = rows - out.length;
  return out;
})();

/* 全部據點（美食與順遊景點也納入，才能做距離搜尋與加入行程） */
const POIS = [
  ...CAMP_POIS,
  ...CAR_POIS,
  ...HIKE_POIS,
  ...(typeof SPOT_POIS !== "undefined" ? SPOT_POIS : []),
  ...FOOD_POIS,
];

const DATA_DISCLAIMER =
  "示範資料：座標、營業時間、價位與充電樁狀態為概略值，出發前請再次確認。";
