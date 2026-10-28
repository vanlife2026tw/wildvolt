/* =========================================================
   野電計畫 WildVolt — 國道走法資料
   國道一號（中山高）／國道三號（福爾摩沙高速）走法線形與沿途服務區。
   - waypoints：國道大致線形（北→南），用來估算走國道時的里程，
     不是逐交流道精確路徑；最終里程仍以 OSRM 實測或現場為準。
   - serviceAreaIds：北→南順序。國一、國三共 14 處服務區／休息站，
     高公局已說明 15 處服務區＋東草屯休息站皆設有快充，
     以下站點皆列為 DC 快充（實際功率與營運以現場／1968 App 為準）。
   - highwayKm：該站在國道上的約略里程（K），僅供畫面排序與顯示。
   ========================================================= */

"use strict";

const HIGHWAY_ROUTES = [
  {
    id: "nh1",
    name: "國道一號",
    short: "國一",
    waypoints: [
      { name: "台北", lat: 25.047, lng: 121.567 },
      { name: "中壢服務區", lat: 25.004, lng: 121.252, km: 55 },
      { name: "楊梅休息站", lat: 24.920, lng: 121.135, km: 71 },
      { name: "湖口服務區", lat: 24.870, lng: 121.020, km: 86 },
      { name: "新竹", lat: 24.800, lng: 120.970 },
      { name: "苗栗", lat: 24.550, lng: 120.800 },
      { name: "泰安服務區", lat: 24.327, lng: 120.715, km: 159 },
      { name: "台中烏日", lat: 24.140, lng: 120.620 },
      { name: "員林", lat: 23.960, lng: 120.575 },
      { name: "西螺服務區", lat: 23.795, lng: 120.455, km: 230 },
      { name: "斗南交流道", lat: 23.680, lng: 120.450 },
      { name: "嘉義", lat: 23.480, lng: 120.440 },
      { name: "新營服務區", lat: 23.339, lng: 120.312, km: 284 },
      { name: "仁德服務區", lat: 22.910, lng: 120.254, km: 330 },
      { name: "高雄端", lat: 22.640, lng: 120.302 },
    ],
    serviceAreaIds: [
      "ch-sa-zhongli", "ch-sa-yangmei", "ch-hukou",
      "ch-sa-taian", "ch-sa-xiluo", "ch-sa-xinying", "ch-sa-rende",
    ],
  },
  {
    id: "nh3",
    name: "國道三號",
    short: "國三",
    waypoints: [
      { name: "台北木柵", lat: 25.050, lng: 121.580 },
      { name: "關西服務區", lat: 24.790, lng: 121.170, km: 79 },
      { name: "寶山休息站", lat: 24.758, lng: 121.005, km: 100 },
      { name: "西湖服務區", lat: 24.560, lng: 120.740, km: 141 },
      { name: "清水服務區", lat: 24.280, lng: 120.590, km: 172 },
      { name: "南投服務區", lat: 23.912, lng: 120.687, km: 235 },
      { name: "古坑服務區", lat: 23.609, lng: 120.545, km: 270 },
      { name: "中埔交流道", lat: 23.430, lng: 120.520 },
      { name: "東山服務區", lat: 23.320, lng: 120.430, km: 322 },
      { name: "關廟服務區", lat: 22.929, lng: 120.353, km: 363 },
      { name: "燕巢系統", lat: 22.780, lng: 120.380 },
      { name: "屏東九如", lat: 22.650, lng: 120.450 },
      { name: "麟洛", lat: 22.520, lng: 120.500 },
      { name: "大鵬灣端", lat: 22.430, lng: 120.600 },
    ],
    serviceAreaIds: [
      "ch-guanxi", "ch-sa-baoshan", "ch-xihu", "ch-qingshui",
      "ch-sa-nantou", "ch-sa-gukeng", "ch-dongshan", "ch-sa-guanmiao",
    ],
  },
];

const ROUTE_MODE_LABELS = {
  auto: "自動估算",
  nh1: "國道一號",
  nh3: "國道三號",
  local: "一般道路",
};

function highwayRouteById(id) {
  return HIGHWAY_ROUTES.find((r) => r.id === id) || null;
}
