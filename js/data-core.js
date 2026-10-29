/* =========================================================
   野電計畫 WildVolt — 核心設定與示範資料
   ---------------------------------------------------------
   座標、營業時間與充電樁資訊皆為「概略示範值」，
   僅供原型展示，出發前請以官方網站 / Google Maps /
   PlugShare / 充電商 App 再次確認。
   ========================================================= */

const CATEGORIES = {
  camp: { label: "露營", icon: "tent", color: "#2f7d4f" },
  car:  { label: "車露", icon: "van",  color: "#166f8c" },
  hike: { label: "登山", icon: "peak", color: "#b4641f" },
  spot: { label: "景點", icon: "pin",  color: "#7c52a5" },
  food: { label: "美食", icon: "bowl", color: "#c8455c" },
};

const FOOD_KINDS = ["小吃", "麵飯", "海鮮", "合菜", "咖啡甜點", "冰品", "原民料理"];

/* ---------- 出發起點 ---------- */
const STARTS = [
  { id: "taipei",    name: "台北車站",   lat: 25.0478, lng: 121.5170, alt: 10 },
  { id: "taoyuan",   name: "桃園高鐵站", lat: 25.0130, lng: 121.2140, alt: 130 },
  { id: "hsinchu",   name: "新竹車站",   lat: 24.8015, lng: 120.9710, alt: 30 },
  { id: "taichung",  name: "台中車站",   lat: 24.1370, lng: 120.6850, alt: 80 },
  { id: "yunlin",    name: "雲林斗南",   lat: 23.6799, lng: 120.4785, alt: 35 },
  { id: "chiayi",    name: "嘉義車站",   lat: 23.4790, lng: 120.4410, alt: 30 },
  { id: "tainan",    name: "台南車站",   lat: 22.9970, lng: 120.2120, alt: 10 },
  { id: "kaohsiung", name: "高雄車站",   lat: 22.6390, lng: 120.3020, alt: 10 },
  { id: "pingtung",  name: "屏東車站",   lat: 22.6690, lng: 120.4860, alt: 20 },
  { id: "taitung",   name: "台東車站",   lat: 22.7930, lng: 121.1120, alt: 40 },
  { id: "hualien",   name: "花蓮車站",   lat: 23.9930, lng: 121.6010, alt: 20 },
  { id: "yilan",     name: "宜蘭車站",   lat: 24.7540, lng: 121.7580, alt: 15 },
];

/* ---------- 車款預設（n⁷ 均為 CCS1） ----------
   每個車款記錄：電池容量（kWh）、可行駛總里程（km），
   以及一般道路／高速／爬坡三種路況的「每度電跑幾公里」。
   里程與能耗都是理想條件，實際會再乘上氣溫、空調、載重與天候係數。 */
const VEHICLE_PRESETS = {
  "n7-short": {
    name: "Luxgen n⁷（57度自訂預設）",
    sub: "100% = 57 kWh · 平路 6.7／高速 3.1／爬坡 2.9 km/kWh",
    capacity: 57,
    range: 382,
    road: 6.7,
    highway: 3.1,
    climb: 2.9,
    connector: "CCS1",
    note: "100% 滿電 57 度電：平路每度 6.7 km（滿電約 382 km）、高速每度 3.1 km（滿電約 177 km）、爬坡每度 2.9 km（滿電約 165 km）。",
  },
  "n7-std": {
    name: "n⁷ 標準版",
    sub: "57.3 kWh · NEDC 438 km 打折",
    capacity: 57.3,
    range: 350,
    road: 6.1,
    highway: 5.0,
    climb: 3.2,
    connector: "CCS1",
    note: "以 NEDC 438 km 打八折估算。",
  },
  "n7-long": {
    name: "n⁷ 長程版",
    sub: "66.4 kWh · 大電池版本",
    capacity: 66.4,
    range: 420,
    road: 6.7,
    highway: 4.5,
    climb: 3.3,
    connector: "CCS1",
    note: "大電池版本長途較有餘裕。",
  },
};

/* 車庫預設清單（電動車分頁的「我的車」可自行新增／編輯／刪除，會存到瀏覽器）。 */
const DEFAULT_VEHICLES = [
  {
    id: "veh-n7s",
    name: "Luxgen n⁷（57度預設）",
    capacity: 57,
    range: 382,
    road: 6.7,
    highway: 3.1,
    climb: 2.9,
    connector: "CCS1",
  },
  {
    id: "veh-n7std",
    name: "Luxgen n⁷ 標準版（5人亮點）",
    capacity: 57.3,
    range: 350,
    road: 6.1,
    highway: 5.0,
    climb: 3.2,
    connector: "CCS1",
  },
  {
    id: "veh-n7lr",
    name: "Luxgen n⁷ LR 長程版",
    capacity: 66.4,
    range: 420,
    road: 6.7,
    highway: 4.5,
    climb: 3.3,
    connector: "CCS1",
  },
];

/* 舊版欄位相容（部分程式與舊存檔仍會讀到） */
const EV_PRESETS = VEHICLE_PRESETS;

/* ---------- 快速範例行程 ---------- */
const SAMPLE_TRIPS = [
  {
    id: "xiding",
    name: "雲林→隙頂車宿",
    meta: "雲林出發 · 高山車宿 · 山下先補電",
    startId: "yunlin",
    stops: ["car-xiding"],
    destReserve: 30,
    baseChargeMode: "auto",
  },
  {
    id: "yunlin-pengji",
    name: "雲林→棚集山",
    meta: "雲林出發 · 國道三號南下 · 丹林登山口",
    startId: "yunlin",
    stops: ["hike-pengjishan"],
    destReserve: 20,
    baseChargeMode: "auto",
    routeMode: "nh3",
  },
  {
    id: "yunlin-pengji-2d",
    name: "雲林→棚集山 2 日＋回程",
    meta: "雲林出發 · 第 1 天丹林車露過夜 · 第 2 天登棚集山後回程",
    startId: "yunlin",
    stops: ["partner-879", "hike-pengjishan"],
    destReserve: 20,
    baseChargeMode: "auto",
    routeMode: "nh3",
    tripDays: 2,
    returnTrip: true,
    overnightMode: "camp-ac",
    stopDays: { "partner-879": 1, "hike-pengjishan": 2 },
  },
  {
    id: "pengji",
    name: "棚集山＋丹林車露順遊",
    meta: "屏東來義 · 山下2處車露＋潮州運動公園",
    startId: "kaohsiung",
    stops: ["partner-879", "hike-pengjishan", "spot-linhou", "spot-chaozhou-park"],
    destReserve: 30,
    baseChargeMode: "auto",
  },
  {
    id: "hehuan",
    name: "合歡山星空車泊",
    meta: "台北出發 · 2 日 · 高山",
    stops: ["camp-cingjing", "car-wuling", "hike-hehuan-main", "camp-yans"],
  },
  {
    id: "wuling",
    name: "武陵露營＋雪山",
    meta: "台北出發 · 3 日 · 高山",
    stops: ["camp-wuling", "hike-xueshan", "food-lishan", "camp-cingjing"],
  },
  {
    id: "kenting",
    name: "墾丁車泊追海",
    meta: "台中出發 · 3 日 · 海線",
    startId: "taichung",
    stops: ["camp-baishawan", "car-longpan", "hike-alangyi", "food-houbi"],
  },
  {
    id: "alishan",
    name: "阿里山眠月線",
    meta: "台北出發 · 2 日 · 中海拔",
    stops: ["camp-xitou", "camp-alishan", "hike-mianyue", "food-fenqihu"],
  },
];
