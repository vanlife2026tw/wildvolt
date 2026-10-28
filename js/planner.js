/* =========================================================
   野電計畫 WildVolt — 行程、電動車與儲存行程介面
   ========================================================= */

"use strict";

const SEGMENTS = {
  ac: {
    label: "空調強度",
    hint: "夏季山區午後仍會開冷氣",
    options: [["off", "關閉"], ["low", "弱"], ["mid", "中等"], ["high", "強"]],
  },
  load: {
    label: "載重",
    hint: "含乘客、裝備與車頂箱",
    options: [["solo", "1 人"], ["duo", "2 人"], ["full", "3–4 人＋裝備"], ["gear", "滿載＋車頂箱"]],
  },
  drive: {
    label: "行車型態",
    hint: "混合會自動依距離分配高速與一般道路",
    options: [["city", "一般道路為主"], ["mixed", "智能混合"], ["highway", "高速為主"], ["mountain", "山路爬坡"]],
  },
  weather: {
    label: "天候",
    hint: "風雨會明顯增加能耗",
    options: [["sunny", "晴"], ["rain", "雨"], ["wind", "強風"]],
  },
};

function fmtChargeTime(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m >= 90) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return `${h} 小時${rest ? ` ${rest} 分` : ""}`;
  }
  return `${m} 分鐘`;
}

function fmtRoadBreakdown(detail) {
  if (!detail) return "";
  const parts = [];
  if (detail.roadKm >= 0.3) parts.push(`平常道路 ${detail.roadKm.toFixed(1)} km（${detail.roadKwh.toFixed(1)} 度）`);
  if (detail.highwayKm >= 0.3) parts.push(`高速 ${detail.highwayKm.toFixed(1)} km（${detail.highwayKwh.toFixed(1)} 度）`);
  if (detail.climbKm >= 0.3) parts.push(`爬坡 ${detail.climbKm.toFixed(1)} km（${detail.climbKwh.toFixed(1)} 度）`);
  return parts.join(" ＋ ");
}

/* ---------------- 行程 ---------------- */
function renderTrip() {
  const p = plan();
  const list = stops();
  const start = startPoint();
  const calc = p.calc;
  const reserve = Number(state.ev.reserve) || 0;

  /* 終點預留電量（行程面板直接詢問與調整） */
  const destRange = $("#destReserveRange");
  if (destRange) {
    const destR = clamp(Number(state.ev.destReserve) || 30, 10, 60);
    destRange.value = destR;
    destRange.style.setProperty("--p", `${((destR - 10) / 50) * 100}%`);
    const destVal = $("#destReserveVal");
    if (destVal) destVal.textContent = `${destR}%`;
    const modeSel = $("#baseModeSelect");
    if (modeSel) modeSel.value = state.ev.baseChargeMode || "auto";
    const hint = $("#destReserveHint");
    if (hint) {
      const last = list[list.length - 1];
      if (!last) {
        hint.innerHTML = "加入車宿或露營點時，系統會先詢問預計留在車宿點的電量，並自動規劃在山下（如嘉義中埔）補完電再上山。";
      } else {
        const suggested = typeof suggestedDestReserve === "function"
          ? suggestedDestReserve(last) : 30;
        const overnight = last.cat === "camp" || last.cat === "car";
        const high = (Number(last.alt) || 0) >= 550;
        if (overnight && high && destR < suggested) {
          hint.innerHTML = `⚠ 終點「<b>${esc(last.name)}</b>」（海拔 ${fmtKm(last.alt)} m）是高山車宿／露營點且山上無 N7 快充，建議至少留 <b>${suggested}%</b>（過夜冷暖氣／V2L＋隔天回程），目前僅設 ${destR}%。 <button type="button" class="link-btn" data-open-reserve="1">點此開啟智能留電試算</button>`;
        } else if (overnight && high) {
          hint.innerHTML = `✓ 終點「<b>${esc(last.name)}</b>」（海拔 ${fmtKm(last.alt)} m）已設定預留 <b>${destR}%</b> 電量（約 ${((destR / 100) * calc.capacity).toFixed(1)} 度電），系統已自動以「預留 ${destR}% ＋ 上山爬坡耗電」規劃山下補電。 <button type="button" class="link-btn" data-open-reserve="1">智能留電試算</button>`;
        } else {
          hint.innerHTML = `終點「<b>${esc(last.name)}</b>」目前設定預留 <b>${destR}%</b>（約 ${((destR / 100) * calc.capacity).toFixed(1)} 度電）。 <button type="button" class="link-btn" data-open-reserve="1">調整留電與補電策略</button>`;
        }
      }
    }
    $$("#destReserveBlock [data-dest]").forEach((btn) => {
      btn.classList.toggle("is-on", Number(btn.dataset.dest) === clamp(Number(state.ev.destReserve) || 30, 10, 60));
    });
  }

  /* 出遊天數與回程控制同步 */
  const daysSel = $("#tripDaysSelect");
  if (daysSel) daysSel.value = String(clamp(Number(state.ev.tripDays) || 1, 1, 7));
  const retCheck = $("#returnTripCheck");
  if (retCheck) retCheck.checked = !!state.ev.returnTrip;

  /* 走法選擇＋路線比較＋沿途服務區（國道走法才列服務區） */
  const routeBlock = $("#routeModeBlock");
  if (routeBlock) {
    const mode = state.ev.routeMode || "auto";
    $$("#routeModeBlock [data-route]").forEach((btn) => {
      btn.classList.toggle("is-on", btn.dataset.route === mode);
    });
    const note = $("#routeModeNote");
    if (note) {
      note.textContent = mode === "auto"
        ? "自動估算：以 OSRM 實測或直線加道路係數估算"
        : mode === "local"
          ? "一般道路：不走國道，能量只用一般道路 km/kWh 計算"
          : `走${ROUTE_MODE_LABELS[mode] || mode}：里程改按國道折線估算，地圖上的路線仍為示意直線`;
    }
    const compareEl = $("#routeCompare");
    if (compareEl) {
      if (!list.length) {
        compareEl.innerHTML = `<div class="route-compare-hint">加入站點後，這裡會比較自動／國一／國三／一般道路四種走法的里程、時間、耗電與抵達電量。</div>`;
      } else {
        const modes = ["auto", "nh1", "nh3", "local"];
        const rows = modes.map((m) => {
          let cp = null;
          try {
            cp = buildTripPlan({
              start, stops: list,
              ev: { ...state.ev, routeMode: m, highwayChargeId: "" },
              chargers: CHARGERS,
            });
          } catch (err) { cp = null; }
          return { m, cp };
        });
        compareEl.innerHTML = `<div class="route-compare-head">路線比較（點一下就切換走法）</div>` + rows.map(({ m, cp }) => {
          if (!cp) return `<button type="button" class="route-card" data-route="${m}"><b>${ROUTE_MODE_LABELS[m] || m}</b><span>無法估算</span></button>`;
          const isOn = m === mode;
          const warn = cp.finalSoc < cp.destReserve ? " · ⚠ 抵達低於預留" : "";
          return `<button type="button" class="route-card${isOn ? " is-on" : ""}" data-route="${m}">
            <b>${ROUTE_MODE_LABELS[m] || m}${isOn ? "（目前）" : ""}</b>
            <span>${fmtKm(cp.totalKm, 1)} km · ${fmtDuration(cp.totalMinutes / 60)} · 耗電 ${cp.totalEnergy.toFixed(1)} 度</span>
            <span>抵達約 ${fmtSoc(cp.finalSoc)}${warn} · 補電 ${cp.charges.length} 次</span>
          </button>`;
        }).join("");
      }
    }
    const hwWrap = $("#highwayStopsWrap");
    if (hwWrap) {
      if ((mode !== "nh1" && mode !== "nh3") || !p.highwayStops || !p.highwayStops.length) {
        hwWrap.innerHTML = (mode === "nh1" || mode === "nh3")
          ? `<div class="route-compare-hint">這段行程沒有經過該國道的服務區（起訖點可能不在國道沿線），請改用自動估算或另一條國道。</div>`
          : "";
      } else {
        const pickedId = state.ev.highwayChargeId || "";
        hwWrap.innerHTML = `<div class="route-compare-head">沿途服務區快充（${ROUTE_MODE_LABELS[mode]} · 點「在這裡充」就會排入充電計畫）</div>` + p.highwayStops.map((hs, idx) => {
          const leg = p.legs[hs.legIndex];
          let socAt = null;
          if (leg && leg.highwayCharge && leg.highwayCharge.charger.id === hs.charger.id) {
            socAt = leg.highwayCharge.from;
          } else if (leg) {
            socAt = leg.departSoc - (legEnergy(hs.kmFromStart, 0, p.calc.kmPerKwh, "highway") / p.calc.capacity) * 100;
          }
          const isPicked = hs.charger.id === pickedId;
          return `<div class="highway-stop${isPicked ? " is-picked" : ""}">
            <div class="highway-stop-main">
              <b>${idx + 1}. ${esc(hs.charger.name)}</b>
              <span>${esc(hs.charger.network)} · ${hs.charger.power} kW DC（${esc(hs.charger.connectors || "CCS1")}）${hs.charger.highwayKm ? ` · 約 ${hs.charger.highwayKm}K` : ""}</span>
              <span>第 ${hs.legIndex + 1} 段 · 全程約 ${hs.kmFromTripStart.toFixed(1)} km${socAt !== null ? ` · 到站約剩 ${Math.round(socAt)}%` : ""}${isPicked && !(leg && leg.highwayCharge && leg.highwayCharge.charger.id === hs.charger.id) ? " · 已選，但到站電量已夠，不需補電" : ""}</span>
            </div>
            <button type="button" class="mini-btn${isPicked ? " is-on" : ""}" data-pick-highway="${hs.charger.id}">${isPicked ? "已選 · 點此取消" : "在這裡充"}</button>
          </div>`;
        }).join("") + `<p class="route-compare-hint">服務區快充功率與營運以現場／高公局 1968 App 為準；出發前請確認該站接頭與是否需預約。</p>`;
      }
    }
  }

  /* 上山前檢查卡片：有做山下檢查的每一段都顯示，並可切換同區 N7 山下快充站 */
  const baseWrap = $("#baseCheckWrap");
  if (baseWrap) {
    if (!p.basePlans || !p.basePlans.length) {
      baseWrap.innerHTML = `<div class="base-check is-none">目前行程沒有高海拔上山車宿／露營段，不需額外執行山下補電檢查。若沿途電量低於保留值，系統仍會自動安排 N7（${esc(calc.vehicle.connector)}）快充站。</div>`;
    } else {
      baseWrap.innerHTML = p.basePlans.map((bp) => {
        const tone = bp.socAtBase < 0 ? "is-danger" : bp.needed ? "is-warn" : "is-ok";
        const head = bp.socAtBase < 0
          ? `⚠ 出發電量不足以抵達山下「${esc(bp.charger.name)}」`
          : bp.needed
            ? `⛰ 智能規劃：先在山下「${esc(bp.charger.name)}」補完電再上山`
            : `✓ 上山前檢查通過：經山下「${esc(bp.charger.name)}」電量充裕可直接上山`;

        const stageInfo = bp.stage1 && bp.stage2
          ? `<div class="base-stage-grid">
              <div class="base-stage-box">
                <span>階段 1 · 平地／高速往山下補電站</span>
                <strong>${esc(start.name)} → ${esc(bp.charger.name)}</strong>
                <small>${bp.km1.toFixed(1)} km · ${fmtRoadBreakdown(bp.stage1)} · 耗電 ${bp.e1.toFixed(1)} 度 · 抵達山下剩 <b>${Math.round(bp.socAtBase)}%</b></small>
              </div>
              <div class="base-stage-box">
                <span>階段 2 · 補電後爬坡上山往車宿點</span>
                <strong>${esc(bp.charger.name)} → ${esc(bp.at.name)}</strong>
                <small>上山 ${bp.km2.toFixed(1)} km（爬升 ↑${fmtKm(bp.climb2)} m）· ${fmtRoadBreakdown(bp.stage2)} · 爬坡耗電 ${bp.e2.toFixed(1)} 度（約 ${Math.round(bp.climbPct)}%）</small>
              </div>
            </div>`
          : "";

        const altBtns = (bp.alternatives && bp.alternatives.length)
          ? `<div class="base-alt-row">
              <span>同區山下其他 N7 快充：</span>
              ${bp.alternatives.map((a) =>
                `<button type="button" class="mini-btn" data-pick-base="${a.charger.id}" title="${esc(a.charger.network)} · ${a.charger.power}kW · ${esc(a.charger.address || "")}">${esc(a.charger.name)}（${a.charger.power}kW）</button>`
              ).join("")}
              ${state.ev.baseChargerId ? `<button type="button" class="mini-btn" data-pick-base="">恢復自動最佳</button>` : ""}
            </div>`
          : "";

        const body = bp.socAtBase < 0
          ? `到山下站時估計會少 ${Math.round(-bp.socAtBase)}%，請先調高出發電量，或在更前面的國道服務區／交流道快充補電。`
          : bp.needed
            ? `為了在「<b>${esc(bp.at.name)}</b>」保留 <b>${p.destReserve}%</b> 電量（且山上無快充），建議在山下「<b>${esc(bp.charger.name)}</b>」（${esc(bp.charger.network)} · ${bp.charger.power} kW ${bp.charger.type} · ${esc(bp.charger.connectors || calc.vehicle.connector)}）將電量從 <b>${bp.from}% 補至 ${bp.to}%</b>（約 <b>${fmtChargeTime(bp.minutes)}</b>，補充約 ${(((bp.to - bp.from) / 100) * calc.capacity).toFixed(1)} 度電）。補完上山抵達「${esc(bp.at.name)}」預計剩餘 <b>${Math.round(bp.arriveIfCharged)}%</b>（若不在山下補電直接上山僅剩 ${Math.round(bp.arriveIfNotCharged)}%）。`
            : `到山下「${esc(bp.charger.name)}」時約剩 <b>${bp.from}%</b>，直接爬坡上山到「${esc(bp.at.name)}」預計仍剩 <b>${Math.round(bp.arriveIfNotCharged)}%</b>，高於預計留電 ${p.destReserve}%。若仍想在山下補滿再上山，可將上方策略改為「強制山下補電」。`;

        return `<div class="base-check ${tone}">
          <strong>${head}</strong>
          <p>${body}</p>
          ${stageInfo}
          ${altBtns}
        </div>`;
      }).join("");
    }
  }

  $("#stopCount").textContent = `${list.length} 站`;
  $("#chargeCount").textContent = `${p.charges.length} 次`;

  /* 統計（有回程時最終抵達的是出發地，目標改用一般保留值） */
  const lastNeed = list.length ? (p.returnTrip ? reserve : p.destReserve) : reserve;
  const socTone = p.finalSoc < lastNeed ? "is-warn" : "";
  $("#tripStats").innerHTML = `
    <div class="stat"><span>總里程</span><strong>${fmtKm(p.totalKm, 1)}<em>km</em></strong></div>
    <div class="stat"><span>行車時間</span><strong>${fmtDuration(p.totalMinutes / 60)}</strong></div>
    <div class="stat"><span>累積爬升</span><strong>${fmtKm(p.totalClimb)}<em>m</em></strong></div>
    <div class="stat"><span>行車耗電</span><strong>${p.totalEnergy.toFixed(1)}<em>度 kWh</em></strong></div>
    <div class="stat ${socTone}"><span>抵達終點電量</span><strong>${fmtSoc(p.finalSoc)}</strong></div>
    <div class="stat"><span>補電次數</span><strong>${p.charges.length}<em>次</em></strong></div>
  `;

  /* 電量條 */
  const fill = clamp(p.finalSoc, 0, 100);
  const fillStyle = p.finalSoc < lastNeed
    ? "background:linear-gradient(90deg,#ff8f6b,#f0b429)"
    : "";
  $("#batteryCard").innerHTML = `
    <div class="battery-head">
      <span>${esc(calc.vehicle.name)} · 終點預留目標 ${lastNeed}%</span>
      <b>出發 ${Math.round(state.ev.startSoc)}% → 抵達 ${fmtSoc(p.finalSoc)}</b>
    </div>
    <div class="battery-track">
      <div class="battery-fill" style="width:${fill}%;${fillStyle}"></div>
      <i class="battery-reserve" style="left:${lastNeed}%" title="終點預留電量 ${lastNeed}%"></i>
    </div>
    <div class="battery-legend">
      <span>滿電可用 <b>${Math.round(calc.usableRange)} km</b></span>
      <span>${p.charges.length ? `途中／山下補電 <b>${fmtChargeTime(p.chargeMinutes)}</b>` : "免中途補電"}</span>
      <span class="${p.finalSoc < lastNeed ? "is-over" : "is-ok"}">${p.finalSoc < lastNeed ? `低於預留 ${lastNeed}%` : `符合預留 ${lastNeed}%`}</span>
    </div>
  `;

  /* 站點 */
  const stopList = $("#stopList");
  let stopHtml = `
    <li class="stop-item is-start">
      <span class="stop-num">起</span>
      <div class="stop-body">
        <strong>${esc(start.name)}</strong>
        <span>出發地${start.alt ? ` · 海拔 ${fmtKm(start.alt)} m` : ""} · 出發電量 ${Math.round(state.ev.startSoc)}%</span>
      </div>
      <div class="stop-tools">
        <button type="button" class="tool-btn" data-tool="focus" data-id="${start.id || ""}" title="在地圖上查看" aria-label="在地圖上查看出發地">${svgIcon("pin")}</button>
      </div>
    </li>
  `;

  if (!list.length) {
    stopHtml += `<li class="empty-state" style="list-style:none"><strong>還沒有安排站點</strong>到「探索」挑選營地、車泊點或登山口，或點上方「雲林→隙頂車宿」快速範例。<br><button type="button" class="link-btn" data-goto="explore" style="margin-top:8px">去找地方 →</button></li>`;
  } else {
    list.forEach((s, i) => {
      const bp = p.legs[i]?.baseCharge;
      if (bp) {
        stopHtml += `
          <li class="stop-item is-charge-stop" style="--c:var(--charge)">
            <span class="stop-num">⚡</span>
            <div class="stop-body">
              <strong>山下補電：${esc(bp.charger.name)}</strong>
              <span>${esc(bp.charger.network)} · ${bp.charger.power} kW ${bp.charger.type}（${esc(bp.charger.connectors || "CCS1")}）· ${bp.from}% → ${bp.to}%（約 ${fmtChargeTime(bp.minutes)}）後再上山</span>
            </div>
          </li>
        `;
      }
      const stopDay = p.legs[i] ? p.legs[i].day : 1;
      const dayOpts = Array.from({ length: clamp(Number(state.ev.tripDays) || 1, 1, 7) }, (_, d) => d + 1)
        .map((d) => `<option value="${d}"${d === stopDay ? " selected" : ""}>第 ${d} 天</option>`).join("");
      stopHtml += `
        <li class="stop-item" style="--c:${catVar(s.cat)}">
          <span class="stop-num">${i + 1}</span>
          <div class="stop-body">
            <strong>${esc(s.name)}</strong>
            <span>${catLabel(s.cat)} · ${esc(s.region)}${s.alt ? ` · 海拔 ${fmtKm(s.alt)} m` : ""}${i === list.length - 1 && !p.returnTrip ? ` · 預計留電 ${p.destReserve}%` : ""}</span>
          </div>
          <label class="day-select" title="這站是第幾天到達"><select data-day-select="${s.id}" aria-label="${esc(s.name)}第幾天到達">${dayOpts}</select></label>
          <div class="stop-tools">
            <button type="button" class="tool-btn" data-tool="up" data-id="${s.id}" title="往上移" aria-label="往上移" ${i === 0 ? "disabled" : ""}>${svgIcon("up")}</button>
            <button type="button" class="tool-btn" data-tool="down" data-id="${s.id}" title="往下移" aria-label="往下移" ${i === list.length - 1 ? "disabled" : ""}>${svgIcon("down")}</button>
            <button type="button" class="tool-btn is-danger" data-tool="remove" data-id="${s.id}" title="移除" aria-label="移除">${svgIcon("trash")}</button>
          </div>
        </li>
      `;
    });
  }
  stopList.innerHTML = stopHtml;

  /* 山頭附近可車露點 ＆ 行程順遊景點（運動公園、森林園區、熱門景點） */
  renderTripNearby(list);

  /* 分段 */
  if (!p.legs.length) {
    $("#legList").innerHTML = `<div class="empty-state">加入站點後，這裡會依您的車款（平常道路／高速／爬坡每度電公里數）顯示每一段的里程、爬升與抵達電量。</div>`;
  } else {
    $("#legList").innerHTML = p.legs.map((leg, i) => {
      const low = leg.arriveSoc < leg.need;
      const empty = leg.arriveSoc <= 2;
      const badgeCls = empty ? "is-empty" : low ? "is-low" : "";
      const roadBreakdown = leg.detail ? `<div class="leg-meta"><span>路況耗電拆解：${fmtRoadBreakdown(leg.detail)}</span></div>` : "";
      const chargeNote = leg.highwayCharge
        ? `<div class="leg-meta"><span style="color:var(--charge);font-weight:700">⚡ 國道補電（已選）：先開 ${leg.highwayCharge.km1.toFixed(1)} km 到「${esc(leg.highwayCharge.charger.name)}」剩 ${Math.round(leg.highwayCharge.from)}% → 補至 ${Math.round(leg.highwayCharge.to)}%（${fmtChargeTime(leg.highwayCharge.minutes)}），再開 ${leg.highwayCharge.km2.toFixed(1)} km 抵達剩 ${Math.round(leg.arriveSoc)}%（預留目標 ${leg.need}%）</span></div>`
        : leg.baseCharge
        ? `<div class="leg-meta"><span style="color:var(--charge);font-weight:700">⚡ 山下補電二階段：先開 ${leg.baseCharge.km1.toFixed(1)} km 到「${esc(leg.baseCharge.charger.name)}」剩 ${Math.round(leg.baseCharge.from)}% → 補至 ${Math.round(leg.baseCharge.to)}%（${fmtChargeTime(leg.baseCharge.minutes)}），再爬坡 ${leg.baseCharge.km2.toFixed(1)} km 上山抵達剩 ${Math.round(leg.arriveSoc)}%（預留目標 ${leg.need}%）</span></div>`
        : leg.charge
          ? `<div class="leg-meta"><span style="color:var(--charge)">⚡ 抵達後補電（${esc(leg.charge.charger.name)}）${Math.round(leg.charge.from)}% → ${Math.round(leg.charge.to)}% · ${fmtChargeTime(leg.charge.minutes)}</span></div>`
          : leg.inRouteCharge
            ? `<div class="leg-meta"><span style="color:var(--charge)">⚡ 途中補電（${esc(leg.inRouteCharge.charger.name)}）${Math.round(leg.inRouteCharge.from)}% → ${Math.round(leg.inRouteCharge.to)}% · ${fmtChargeTime(leg.inRouteCharge.minutes)}</span></div>`
            : "";
      return `<div class="leg-row">
        <div class="leg-index">${String(i + 1).padStart(2, "0")}</div>
        <div class="leg-main">
          <div class="leg-route"><b>${esc(leg.from.name)}</b><span class="arrow">→</span><b>${esc(leg.to.name)}</b></div>
          <div class="leg-meta">
            <span>共 ${fmtKm(leg.km, 1)} km</span>
            ${leg.climb ? `<span class="up">↑ 爬升 ${fmtKm(leg.climb)} m</span>` : ""}
            <span>${fmtDuration(leg.minutes / 60)}</span>
            <span>耗電 ${leg.energy.toFixed(1)} 度 (kWh)</span>
            <span>${leg.estimated ? "路線估算" : "OSRM 實測"}</span>
          </div>
          ${roadBreakdown}
          ${chargeNote}
        </div>
        <div class="soc-badge ${badgeCls}">${fmtSoc(leg.arriveSoc)}<small>抵達剩餘</small></div>
      </div>`;
    }).join("");
  }

  /* 補電建議 */
  if (!p.charges.length) {
    $("#chargePlan").innerHTML = `<div class="charge-none">${list.length
      ? `目前設定下不需要中途補電，抵達終點仍保留約 ${Math.round(p.finalSoc)}% 電量（高於預留目標 ${p.destReserve}%）。若要在上山前先補滿，可於上方將策略設為「強制山下補電」。`
      : "加入站點後，系統會以 N7（CCS1／J1772）為主列出建議的山下與沿途補電站點。"}</div>`;
  } else {
    $("#chargePlan").innerHTML = p.charges.map((c) => {
      const isAC = c.charger.type === "AC" || c.charger.power < 22;
      const title = c.where === "highway"
        ? `第 ${c.legIndex + 1} 段 · 國道服務區補電（往「${esc(c.at.name)}」）`
        : c.where === "base"
        ? `第 ${c.legIndex + 1} 段 · 山下補完電再上山（往「${esc(c.at.name)}」）`
        : c.where === "dest"
          ? `第 ${c.legIndex + 1} 段 · 抵達「${esc(c.at.name)}」後補電`
          : `第 ${c.legIndex + 1} 段 · 途中順路補電（往「${esc(c.at.name)}」）`;
      const addrText = c.charger.address ? `<br><small style="color:var(--muted)">地址：${esc(c.charger.address)}${c.charger.price ? ` · ${esc(c.charger.price)}` : ""}</small>` : "";
      return `<div class="charge-item">
        <span class="charge-bolt">${svgIcon("bolt")}</span>
        <div class="charge-body">
          <strong>${title}</strong>
          <p><b>${esc(c.charger.name)}</b> · ${esc(c.charger.network)} · ${c.charger.power} kW ${isAC ? "AC 慢充" : "DC 快充"}（${esc(c.charger.connectors || "CCS1")}）${isAC ? "" : ` · 距山上目的地約 ${c.dist.toFixed(1)} km`}${addrText}</p>
          <p class="charge-meta">抵達充電站約 ${Math.round(c.from)}% → 建議充至 <b>${Math.round(c.to)}%</b> · 約需 <b>${fmtChargeTime(c.minutes)}</b>${isAC ? "（建議過夜慢充）" : ""} · <a href="https://www.google.com/maps/dir/?api=1&destination=${c.charger.lat},${c.charger.lng}&travelmode=driving" target="_blank" rel="noopener" style="color:var(--charge);text-decoration:underline">導航至此充電站</a></p>
        </div>
      </div>`;
    }).join("");
  }

  /* 分日行程 */
  const dayWrap = $("#dayPlanWrap");
  if (dayWrap) {
    if (!p.days || !p.days.length || !list.length) {
      dayWrap.innerHTML = `<div class="empty-state">加入站點並設定天數後，這裡會按天分組顯示每天去哪、住哪、補幾次電。</div>`;
    } else {
      dayWrap.innerHTML = p.days.map((d) => {
        const routeText = d.legs.length
          ? d.legs.map((l) => `${esc(l.from.name)} → ${esc(l.to.name)}（${fmtKm(l.km, 1)} km，抵達 ${fmtSoc(l.arriveSoc)}）`).join("<br>")
          : "（這天沒有安排行程，可再加入站點）";
        const nightText = d.overnight
          ? `夜宿：${esc(d.overnight.name)}`
          : d.isReturnDay
            ? "回程日：回到出發地"
            : "當天不夜宿";
        const chargeText = d.charges.length
          ? d.charges.map((c) => `在「${esc(c.charger.name)}」${Math.round(c.from)}% → ${Math.round(c.to)}%（${fmtChargeTime(c.minutes)}）`).join("；")
          : "免補電";
        return `<div class="day-card">
          <div class="day-card-head"><b>第 ${d.day} 天</b><span>${nightText}</span></div>
          <div class="day-card-route">${routeText}</div>
          <div class="day-card-meta">里程 ${fmtKm(d.km, 1)} km · 耗電 ${d.energy.toFixed(1)} 度 · 行車 ${fmtDuration(d.minutes / 60)}${d.startSoc !== null ? ` · 出發 ${fmtSoc(d.startSoc)} → 收尾 ${fmtSoc(d.endSoc)}` : ""}</div>
          <div class="day-card-meta">補電：${chargeText}</div>
        </div>`;
      }).join("");
    }
  }

  /* 提醒 */
  $("#tripWarnings").innerHTML = p.warnings.map((w) => `
    <div class="warn-item ${w.tone === "danger" ? "is-danger" : ""}">
      ${svgIcon("warn")}
      <div>${esc(w.text)}</div>
    </div>
  `).join("");

  /* 列印大字表（螢幕隱藏、列印時顯示）：分段里程＋充電計畫 */
  const sheet = $("#printSheet");
  if (sheet) {
    if (!list.length) {
      sheet.innerHTML = "";
    } else {
      const today = new Date().toLocaleDateString("zh-TW", { year: "numeric", month: "long", day: "numeric", weekday: "long" });
      const modeLabel = ROUTE_MODE_LABELS[state.ev.routeMode || "auto"] || "自動估算";
      const legRows = p.legs.map((leg, i) => {
        const chargeText = leg.highwayCharge
          ? `在「${esc(leg.highwayCharge.charger.name)}」補電 ${Math.round(leg.highwayCharge.from)}% → ${Math.round(leg.highwayCharge.to)}%（${fmtChargeTime(leg.highwayCharge.minutes)}）`
          : leg.baseCharge
            ? `在「${esc(leg.baseCharge.charger.name)}」補電 ${Math.round(leg.baseCharge.from)}% → ${Math.round(leg.baseCharge.to)}%（${fmtChargeTime(leg.baseCharge.minutes)}）`
            : leg.inRouteCharge
              ? `在「${esc(leg.inRouteCharge.charger.name)}」補電 ${Math.round(leg.inRouteCharge.from)}% → ${Math.round(leg.inRouteCharge.to)}%（${fmtChargeTime(leg.inRouteCharge.minutes)}）`
              : leg.charge
                ? `抵達後在「${esc(leg.charge.charger.name)}」補電至 ${Math.round(leg.charge.to)}%（${fmtChargeTime(leg.charge.minutes)}）`
                : "免補電";
        return `<tr>
          <td>${i + 1}</td>
          <td><b>${esc(leg.from.name)}</b><br>→ <b>${esc(leg.to.name)}</b></td>
          <td>${fmtKm(leg.km, 1)} km</td>
          <td>${leg.climb ? `↑ ${fmtKm(leg.climb)} m` : "—"}</td>
          <td>${fmtDuration(leg.minutes / 60)}</td>
          <td>${leg.energy.toFixed(1)} 度</td>
          <td><b>${fmtSoc(leg.arriveSoc)}</b></td>
          <td>${chargeText}</td>
        </tr>`;
      }).join("");
      const chargeRows = p.charges.length
        ? p.charges.map((c, i) => `<tr>
            <td>${i + 1}</td>
            <td><b>${esc(c.charger.name)}</b><br>${esc(c.charger.network)} · ${c.charger.power} kW ${c.charger.type}</td>
            <td>${Math.round(c.from)}% → <b>${Math.round(c.to)}%</b></td>
            <td>${fmtChargeTime(c.minutes)}</td>
            <td>${(((c.to - c.from) / 100) * p.calc.capacity).toFixed(1)} 度</td>
            <td>${esc(c.charger.address || "（地址請以導航為準）")}</td>
          </tr>`).join("")
        : `<tr><td colspan="6">本次行程不需中途補電。</td></tr>`;
      const hwRows = (p.highwayStops && p.highwayStops.length)
        ? p.highwayStops.map((hs, i) => `<tr><td>${i + 1}</td><td><b>${esc(hs.charger.name)}</b></td><td>${hs.charger.highwayKm ? `約 ${hs.charger.highwayKm}K` : "—"}</td><td>距出發約 ${hs.kmFromStart.toFixed(1)} km</td><td>${hs.charger.id === (state.ev.highwayChargeId || "") ? "<b>★ 已選補電點</b>" : "經過"}</td></tr>`).join("")
        : "";
      const warnRows = p.warnings.length
        ? p.warnings.map((w) => `<li>${esc(w.text)}</li>`).join("")
        : "<li>無特別提醒。</li>";
      sheet.innerHTML = `
        <div class="print-sheet-head">
          <strong>野電計畫 WildVolt · 行程表</strong>
          <span>${today}</span>
        </div>
        <div class="print-sheet-route">${esc(start.name)} → ${list.map((s) => esc(s.name)).join(" → ")}</div>
        <div class="print-sheet-meta">車款：${esc(calc.vehicle.name)} · 走法：${modeLabel} · 出發電量 ${Math.round(state.ev.startSoc)}% · 終點預留 ${p.destReserve}% · 總里程 ${fmtKm(p.totalKm, 1)} km · 行車 ${fmtDuration(p.totalMinutes / 60)} · 耗電 ${p.totalEnergy.toFixed(1)} 度 · 抵達 ${fmtSoc(p.finalSoc)} · 補電 ${p.charges.length} 次（約 ${fmtChargeTime(p.chargeMinutes)}）</div>
        <h3>分日行程</h3>
        <table class="print-table">
          <thead><tr><th>天</th><th>當天行程</th><th>里程</th><th>耗電</th><th>補電</th><th>夜宿／回程</th></tr></thead>
          <tbody>${p.days.map((d) => `<tr><td>第 ${d.day} 天</td><td>${d.legs.length ? d.legs.map((l) => `${esc(l.from.name)} → ${esc(l.to.name)}`).join("；") : "（無行程）"}</td><td>${fmtKm(d.km, 1)} km</td><td>${d.energy.toFixed(1)} 度</td><td>${d.charges.length ? d.charges.map((c) => `${esc(c.charger.name)} ${Math.round(c.from)}% → ${Math.round(c.to)}%`).join("；") : "免補電"}</td><td>${d.overnight ? `夜宿 ${esc(d.overnight.name)}` : d.isReturnDay ? "回到出發地" : "不夜宿"}</td></tr>`).join("")}</tbody>
        </table>
        <h3>分段里程</h3>
        <table class="print-table">
          <thead><tr><th>段</th><th>起訖</th><th>里程</th><th>爬升</th><th>時間</th><th>耗電</th><th>抵達電量</th><th>補電安排</th></tr></thead>
          <tbody>${legRows}</tbody>
        </table>
        <h3>充電計畫</h3>
        <table class="print-table">
          <thead><tr><th>#</th><th>充電站</th><th>電量</th><th>時間</th><th>補充</th><th>地址／備註</th></tr></thead>
          <tbody>${chargeRows}</tbody>
        </table>
        ${hwRows ? `<h3>沿途服務區</h3><table class="print-table"><thead><tr><th>#</th><th>服務區</th><th>國道里程</th><th>位置</th><th>狀態</th></tr></thead><tbody>${hwRows}</tbody></table>` : ""}
        <h3>提醒</h3>
        <ul class="print-warns">${warnRows}</ul>
        <p class="print-foot">里程與電量為估算值（不計下坡回充），服務區快充功率與營運以現場／高公局 1968 App 為準；出發前請再次確認充電站接頭與營業狀態。</p>`;
    }
  }

  renderSaved();
}

/**
 * 行程面板：自動推薦
 * 1) 行程中若有「山頭／登山口」（畢竟不是每個山頭都能直接車宿，例如棚集山旁有天際驛站與丹林桃心木），列出登山口周邊最近的可車露／車宿點。
 * 2) 行程站點周邊 18 km 內的「順遊景點（運動公園、森林園區、吊橋、熱門景點）」，可一鍵「＋ 順遊加入」或導航。
 */
function renderTripNearby(list) {
  const wrap = $("#tripNearbyWrap");
  if (!wrap) return;
  if (!list || !list.length) {
    wrap.innerHTML = `<div class="trip-nearby-empty">加入山頭或車宿點後，這裡會自動帶出<b>山頭附近可車露地點</b>（例如搜棚集山帶出丹林兩處車泊點）以及<b>周邊運動公園、森林園區與熱門景點</b>。</div>`;
    return;
  }

  const hikeStops = list.filter((s) => s.cat === "hike");
  let hikeCarBlocks = "";
  if (hikeStops.length && typeof nearbyCarSpots === "function") {
    hikeCarBlocks = hikeStops.map((h) => {
      const cars = nearbyCarSpots(h, 12, typeof partnerPOIs === "function" ? partnerPOIs() : []).slice(0, 4);
      if (!cars.length) return "";
      const hasCarInTrip = cars.some((c) => state.itinerary.includes(c.id));
      return `
        <div class="tn-group tn-group--car">
          <div class="tn-group-head">
            <span>🚐 「${esc(h.name)}」附近可車露／車宿地點</span>
            <small>${hasCarInTrip ? "✓ 已將附近車露點排入行程" : "山頭本身不見得能車宿，建議搭配以下鄰近車泊點過夜"}</small>
          </div>
          <div class="tn-car-list">
            ${cars.map((c) => {
              const added = state.itinerary.includes(c.id);
              const dTxt = c.dist < 1 ? `${Math.round(c.dist * 1000)} m` : `${c.dist.toFixed(1)} km`;
              return `<div class="tn-car-item">
                <div class="tn-car-info">
                  <strong>${esc(c.name)}</strong>
                  <span>距登山口 ${dTxt} · ${esc(c.address || c.region || "")}${c.price ? ` · ${esc(c.price)}` : ""}</span>
                </div>
                <div class="tn-car-acts">
                  <button type="button" class="mini-btn" data-tn-focus="${c.id}">地圖</button>
                  <button type="button" class="mini-btn ${added ? "" : "solid"}" data-tn-add="${c.id}" ${added ? "disabled" : ""}>${added ? "已在行程" : "＋ 加入車露"}</button>
                </div>
              </div>`;
            }).join("")}
          </div>
        </div>
      `;
    }).join("");
  }

  const spots = typeof nearbySpots === "function"
    ? nearbySpots(list, 18, state.liveSpots || []).slice(0, 8)
    : [];

  const spotBlock = spots.length
    ? `<div class="tn-group tn-group--spot">
        <div class="tn-group-head">
          <span>🎡 順遊附近景點（運動公園・森林園區・熱門景點）</span>
          <small>依目前行程站點方圓 18 km 自動推薦，可一鍵排入順遊</small>
        </div>
        <div class="tn-spot-grid">
          ${spots.map((s) => {
            const added = state.itinerary.includes(s.id);
            const dTxt = s.dist < 1 ? `${Math.round(s.dist * 1000)} m` : `${s.dist.toFixed(1)} km`;
            const isSportPark = /運動公園|森林|公園/.test(`${s.name} ${s.kind || ""}`);
            return `<div class="tn-spot-card ${isSportPark ? "is-park" : ""}">
              <div class="tn-spot-top">
                <span class="tn-spot-badge">${esc(s.kind || "熱門景點")}</span>
                <span class="tn-spot-dist">距「${esc(s.nearName)}」${dTxt}</span>
              </div>
              <strong class="tn-spot-name">${esc(s.name)}</strong>
              <p class="tn-spot-desc">${esc(s.desc || s.address || s.region || "")}</p>
              <div class="tn-spot-acts">
                <button type="button" class="mini-btn" data-tn-focus="${s.id}">看地圖</button>
                <a class="mini-btn" href="https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}&travelmode=driving" target="_blank" rel="noopener" style="text-align:center;line-height:24px">導航</a>
                <button type="button" class="mini-btn ${added ? "" : "solid"}" data-tn-add="${s.id}" ${added ? "disabled" : ""}>${added ? "已加入" : "＋ 順遊加入"}</button>
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>`
    : `<div class="trip-nearby-empty">目前站點方圓 18 km 內尚無內建順遊景點，可點右上角「<b>OSM 搜更多公園／景點</b>」即時搜尋附近的運動公園與熱門景點。</div>`;

  wrap.innerHTML = `${hikeCarBlocks}${spotBlock}`;
}

/**
 * 即時向 OpenStreetMap Overpass 查詢行程站點周邊的「運動公園、公園、熱門景點、觀景台」
 */
async function fetchLiveSpotsForTrip() {
  const list = stops();
  const anchor = list[list.length - 1] || list[0] || anchorPoint();
  if (!anchor) { toast("請先在行程加入至少一個站點"); return; }
  if (!navigator.onLine) { toast("目前離線，無法即時搜尋景點"); return; }
  const btn = $("#liveSpotBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "搜尋中…";
  }
  try {
    const rMeters = 15000;
    const q = `[out:json][timeout:12];(
      node["leisure"~"park|sports_centre|stadium|pitch"]["name"](around:${rMeters},${anchor.lat},${anchor.lng});
      way["leisure"~"park|sports_centre|stadium"]["name"](around:${rMeters},${anchor.lat},${anchor.lng});
      node["tourism"~"attraction|viewpoint|museum|theme_park"]["name"](around:${rMeters},${anchor.lat},${anchor.lng});
      way["tourism"~"attraction|viewpoint|museum|theme_park"]["name"](around:${rMeters},${anchor.lat},${anchor.lng});
    );out center 25;`;
    const res = await fetch("https://overpass-api.de/api/interpreter", {
      method: "POST",
      body: `data=${encodeURIComponent(q)}`,
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const found = [];
    for (const el of data.elements || []) {
      const name = String(el.tags?.["name:zh"] || el.tags?.name || "").trim();
      const lat = Number(el.lat ?? el.center?.lat);
      const lng = Number(el.lon ?? el.center?.lon);
      if (!name || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      const leisure = el.tags?.leisure || "";
      const tourism = el.tags?.tourism || "";
      const kind = /運動|體育|sports|stadium/.test(name + leisure)
        ? "運動公園"
        : leisure === "park"
          ? "公園綠地"
          : tourism === "viewpoint"
            ? "觀景平台"
            : "熱門景點";
      const item = {
        id: `spot-osm-${el.type}-${el.id}`,
        name,
        cat: "spot",
        region: anchor.region || "周邊順遊",
        lat,
        lng,
        alt: anchor.alt ? Math.max(20, Math.round(anchor.alt * 0.4)) : 50,
        rating: 4.5,
        kind,
        price: "免費／依現場公告",
        tags: [kind, "OSM 即時景點"],
        desc: `${anchor.name}周邊 ${kind}（OpenStreetMap 即時搜尋）`,
      };
      found.push(item);
      if (!getPOI(item.id)) state.custom.push(item);
    }
    state.liveSpots = [...(state.liveSpots || []), ...found];
    persist();
    renderTrip();
    renderMarkers();
    toast(found.length ? `已找到 ${found.length} 處附近運動公園／景點` : "周邊未查到更多 OSM 景點");
  } catch (err) {
    toast("OSM 景點查詢忙碌中，已顯示內建精選運動公園與景點");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "OSM 搜更多公園／景點";
    }
  }
}

/* ---------------- 車宿／露營點預留電量智能詢問視窗 ---------------- */
function openReserveModal(stopId) {
  const modal = $("#reserveModal");
  if (!modal) return;
  const list = stops();
  const targetStop = (stopId && getPOI(stopId)) || list[list.length - 1];
  if (!targetStop) return;

  const isMountain = (Number(targetStop.alt) || 0) >= 550;
  const isCarCamp = targetStop.cat === "car" || targetStop.cat === "camp";
  const suggested = typeof suggestedDestReserve === "function" ? suggestedDestReserve(targetStop) : 30;
  if (!state.ev.destReserve || state.ev.destReserve < 20) {
    state.ev.destReserve = suggested;
  }

  $("#reserveModalKicker").textContent = isMountain
    ? `MOUNTAIN SMART CHARGE · 高山${targetStop.cat === "car" ? "車宿" : "露營"}智能補電規劃`
    : `TRIP RESERVE PLANNER · 目的地預留電量設定`;
  $("#reserveModalTitle").textContent = `預計在「${targetStop.name}」要留多少電？`;
  $("#reserveModalDesc").innerHTML = isMountain && isCarCamp
    ? `「<b>${esc(targetStop.name)}</b>」位於<b>${esc(targetStop.region)}（海拔約 ${fmtKm(targetStop.alt)} m）</b>，山上沒有 N7 高功率快充站。正常上山車宿應先在<b>山下最後快充站補飽電後再上山</b>，以確保車宿過夜（冷暖氣／露營模式／V2L）與隔天回程安全無虞。`
    : `請設定抵達「<b>${esc(targetStop.name)}</b>」時預計要保留的電量百分比，系統將依您的車款能耗自動計算是否需要先補電。`;

  updateReserveModalPreview(targetStop);
  modal.hidden = false;
}

function updateReserveModalPreview(targetStop) {
  const list = stops();
  const stop = targetStop || list[list.length - 1];
  if (!stop) return;
  const destR = clamp(Number(state.ev.destReserve) || 30, 10, 60);
  const rangeEl = $("#modalReserveRange");
  if (rangeEl) {
    rangeEl.value = destR;
    rangeEl.style.setProperty("--p", `${((destR - 10) / 50) * 100}%`);
  }
  const valEl = $("#modalReserveVal");
  if (valEl) valEl.textContent = `${destR}%`;
  const modeEl = $("#modalBaseModeSelect");
  if (modeEl) modeEl.value = state.ev.baseChargeMode || "auto";
  $$("#modalReserveBtns [data-modal-dest]").forEach((btn) => {
    btn.classList.toggle("is-on", Number(btn.dataset.modalDest) === destR);
  });

  const p = plan();
  const calc = p.calc;
  const bp = (p.basePlans && p.basePlans[p.basePlans.length - 1]) || null;
  const preview = $("#reserveModalPreview");
  if (!preview) return;

  if (bp) {
    const reserveKwh = ((destR / 100) * calc.capacity).toFixed(1);
    const arriveSoc = bp.needed ? Math.round(bp.arriveIfCharged) : Math.round(bp.arriveIfNotCharged);
    preview.innerHTML = `
      <div class="rm-card ${bp.needed ? "is-charge" : "is-direct"}">
        <div class="rm-head">
          <strong>${bp.needed ? `⚡ 建議在山下「${esc(bp.charger.name)}」補完電再上山` : `✓ 電量充裕，經山下「${esc(bp.charger.name)}」可直接上山`}</strong>
          <span>車款：${esc(calc.vehicle.name)}（平路 ${calc.vehicle.road}／高速 ${calc.vehicle.highway}／爬坡 ${calc.vehicle.climb} km/kWh）</span>
        </div>
        <ol class="rm-steps">
          <li><b>1. 出發至山下：</b>從「${esc(p.start.name)}」（出發電量 ${Math.round(state.ev.startSoc)}%）行駛 ${bp.km1.toFixed(1)} km 至山下「<b>${esc(bp.charger.name)}</b>」，耗電約 ${bp.e1.toFixed(1)} 度，抵達山下剩 <b>${bp.from}%</b>。</li>
          ${bp.needed
            ? `<li><b>2. 山下快充補電：</b>在「<b>${esc(bp.charger.name)}</b>」（${esc(bp.charger.network)} · ${bp.charger.power} kW · ${esc(bp.charger.connectors || "CCS1")}）由 <b>${bp.from}% 補電至 ${bp.to}%</b>（約需 <b>${fmtChargeTime(bp.minutes)}</b>）。</li>`
            : `<li><b>2. 山下檢查：</b>抵達山下仍有 ${bp.from}%，無須補電即可滿足山上預留 ${destR}%（若想補滿可切換為「強制山下補電」）。</li>`}
          <li><b>3. 爬坡上山車宿：</b>從山下爬坡 ${bp.km2.toFixed(1)} km（爬升 ↑${fmtKm(bp.climb2)} m）至「<b>${esc(stop.name)}</b>」，依爬坡每度電 ${calc.kmPerKwh.climb.toFixed(1)} km 計算需耗電 <b>${bp.e2.toFixed(1)} 度（約 ${Math.round(bp.climbPct)}%）</b>。</li>
          <li><b>4. 抵達車宿點電量：</b>抵達「<b>${esc(stop.name)}</b>」預計剩餘 <b>${arriveSoc}%</b>（約 ${((arriveSoc / 100) * calc.capacity).toFixed(1)} 度電），達成您設定的預留 <b>${destR}%（${reserveKwh} 度電）</b>！</li>
        </ol>
      </div>
    `;
  } else {
    preview.innerHTML = `
      <div class="rm-card is-direct">
        <div class="rm-head">
          <strong>行程電量試算（${esc(calc.vehicle.name)}）</strong>
          <span>預計留在「${esc(stop.name)}」：${destR}%（約 ${((destR / 100) * calc.capacity).toFixed(1)} 度電）</span>
        </div>
        <p style="margin:6px 0 0;font-size:11.5px;line-height:1.6">全程約 ${fmtKm(p.totalKm, 1)} km，總耗電約 ${p.totalEnergy.toFixed(1)} 度，預計抵達終點剩餘 <b>${fmtSoc(p.finalSoc)}</b>${p.charges.length ? `（含沿途補電 ${p.charges.length} 次）` : "（免中途補電）"}。</p>
      </div>
    `;
  }
}

function closeReserveModal() {
  const modal = $("#reserveModal");
  if (modal) modal.hidden = true;
}

/* ---------------- 已儲存行程 ---------------- */
function renderSaved() {
  const list = readSaved();
  const wrap = $("#savedWrap");
  if (!wrap) return;
  if (!list.length) {
    wrap.innerHTML = `<div class="saved-empty">按下右上角的書籤圖示，就能把這趟行程存在瀏覽器裡。</div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="section-head">
      <h3>已儲存行程</h3>
      <span class="section-count">${list.length} 筆</span>
    </div>
    <div class="saved-list">
      ${list.map((item) => {
        const date = item.createdAt ? new Date(item.createdAt) : null;
        const dateText = date && !Number.isNaN(date.getTime())
          ? `${date.getMonth() + 1}/${date.getDate()}`
          : "";
        return `<div class="saved-row">
          <div class="saved-main">
            <strong>${esc(item.name)}</strong>
            <span>${esc(dateText)} · ${(item.itinerary || []).length} 站</span>
          </div>
          <div class="saved-tools">
            <button type="button" class="mini-btn" data-load="${item.id}">載入</button>
            <button type="button" class="tool-btn is-danger" data-del="${item.id}" title="刪除" aria-label="刪除儲存行程">${svgIcon("trash")}</button>
          </div>
        </div>`;
      }).join("")}
    </div>
  `;
}

/* ---------------- 電動車面板 ---------------- */
function renderEvPanel() {
  const wrap = $("#evPanel");
  if (!wrap) return;
  const segHtml = Object.entries(SEGMENTS).map(([group, cfg]) => `
    <div class="seg-group" data-group="${group}">
      <div class="seg-label">${cfg.label}<span>${cfg.hint}</span></div>
      <div class="seg">
        ${cfg.options.map(([value, label]) =>
          `<button type="button" data-seg="${group}" data-value="${value}">${label}</button>`
        ).join("")}
      </div>
    </div>
  `).join("");

  const vehicles = vehicleList(state.ev);
  const active = activeVehicle(state.ev);
  wrap.innerHTML = `
    <div class="garage-head">
      <h3>我的車庫與能耗設定</h3>
      <span>以車子型號、可行駛總里程、平常道路／高速／爬坡每度電幾公里，精算行程耗電與是否需要補電</span>
    </div>
    <label class="select-wrap select-block" for="vehicleSelect">
      <span>目前選用車輛</span>
      <select id="vehicleSelect">
        ${vehicles.map((v) => `<option value="${v.id}" ${v.id === active.id ? "selected" : ""}>${esc(v.name)} · 100%=${v.capacity}度 · 平路${v.road}／高速${v.highway}／爬坡${v.climb} km/度（滿電約 ${v.range} km）</option>`).join("")}
      </select>
    </label>
    <div class="ev-note" id="evNote"></div>
    <div class="ev-result" id="evResult"></div>

    <div class="garage-form" id="vehicleForm">
      <div class="garage-form-header">
        <p class="garage-form-title">新增／修改車子資料 <span>預設已填入：100%＝57 度電、平路 6.7、高速 3.1、爬坡 2.9 km/kWh</span></p>
        <div class="garage-presets">
          <button type="button" class="mini-btn" data-veh-preset="n7-short">帶入預設 (57度·平6.7/高3.1/爬2.9)</button>
          <button type="button" class="mini-btn" data-veh-preset="n7-std">帶入 n⁷ 均衡設定</button>
          <button type="button" class="mini-btn" data-veh-preset="n7-long">帶入 n⁷ 長程 (82度)</button>
          <button type="button" class="mini-btn" data-veh-preset="blank">清空填新車</button>
        </div>
      </div>
      <label class="text-field" style="grid-column: 1 / -1">
        <span>1. 車子型號 *</span>
        <input type="text" id="vehName" value="${esc(active.name)}" placeholder="例如：2024 Luxgen n⁷ 5人純粹版（57度電）" />
      </label>
      <label class="text-field">
        <span>2. 100% 滿電電池容量（度電 kWh）*</span>
        <input type="number" id="vehCapacity" value="${active.capacity}" min="10" max="200" step="0.5" placeholder="例如：57" />
      </label>
      <label class="text-field">
        <span>3. 平常道路每度電幾公里（km/kWh）*</span>
        <input type="number" id="vehRoad" value="${active.road}" min="1.5" max="15" step="0.1" placeholder="例如：6.7" />
      </label>
      <label class="text-field">
        <span>4. 高速每度電幾公里（km/kWh）*</span>
        <input type="number" id="vehHighway" value="${active.highway}" min="1.5" max="15" step="0.1" placeholder="例如：3.1" />
      </label>
      <label class="text-field">
        <span>5. 爬坡每度電幾公里（km/kWh）*</span>
        <input type="number" id="vehClimb" value="${active.climb}" min="1.2" max="15" step="0.1" placeholder="例如：2.9" />
      </label>
      <label class="text-field">
        <span>6. 平路 100% 可行駛總里程（km，由度數×平路自動換算）</span>
        <input type="number" id="vehRange" value="${active.range}" min="50" max="1000" step="1" placeholder="例如：382" />
      </label>
      <label class="text-field">
        <span>充電接頭（預設以 N7 CCS1 為主）</span>
        <select id="vehConnector">
          ${["CCS1", "J1772", "CCS2", "CHAdeMO", "GB/T"].map((c) => `<option value="${c}" ${active.connector === c ? "selected" : ""}>${c}${c === "CCS1" ? "（Luxgen n⁷ 快充標準）" : ""}</option>`).join("")}
        </select>
      </label>
      <div class="veh-conversion-box" id="vehConversionBox" style="grid-column: 1 / -1"></div>
      <p class="garage-form-note">系統會把每段行程拆成「<b>平常道路</b>」、「<b>高速</b>」、「<b>爬坡</b>」三種里程，分別除以您填的每度電公里數（km/kWh）算出耗電度數，並對照「<b>可行駛總里程</b>」判斷是否需要補電。</p>
      <div class="garage-actions">
        <button type="button" class="primary-btn" data-vehicle-act="add">＋ 新增為一台車</button>
        <button type="button" class="ghost-btn" data-vehicle-act="update">儲存修改目前這台</button>
        <button type="button" class="ghost-btn" data-vehicle-act="delete" ${vehicles.length <= 1 ? "disabled" : ""}>刪除這台</button>
      </div>
    </div>

    <div class="ev-form">
      <label class="range-field" for="evStartSoc">
        <span class="range-head">出發電量 <b id="evStartVal">90<em>%</em></b></span>
        <input type="range" id="evStartSoc" data-ev="startSoc" min="30" max="100" step="5" />
      </label>
      <label class="range-field" for="evReserve">
        <span class="range-head">途中最低保留電量 <b id="evReserveVal">10<em>%</em></b></span>
        <input type="range" id="evReserve" data-ev="reserve" min="5" max="40" step="5" />
      </label>
      <label class="range-field" for="evTemp">
        <span class="range-head">環境氣溫 <b id="evTempVal">24<em>°C</em></b></span>
        <input type="range" id="evTemp" data-ev="temp" min="-5" max="40" step="1" />
      </label>

      ${segHtml}
    </div>

    <div class="factor-list" id="evFactors"></div>
    <p class="factor-foot">各項環境係數為相乘關係；爬升耗電直接依您設定的「爬坡每度電幾公里（km/kWh）」計算，不計下坡回充，屬安全保守估算。車宿點的預留電量請在「行程」分頁設定（高山車宿建議留 30%～40%）。</p>
    <div class="ev-note" style="margin-top:12px">
      <span>ⓘ</span>
      <span>補電點已整合 <b>LuxClub N7 充電地圖（全台超過 700 座 CCS1／J1772 站點）</b> 與精選高功率快充站。出發前請以充電商 App 確認即時空位。</span>
    </div>
  `;

  renderEvOutputs();
}

function updateVehConversionBox() {
  const box = $("#vehConversionBox");
  if (!box) return;
  const cap = Math.max(10, Number($("#vehCapacity")?.value) || 57);
  const road = Math.max(1, Number($("#vehRoad")?.value) || 6.7);
  const hw = Math.max(1, Number($("#vehHighway")?.value) || 3.1);
  const climb = Math.max(1, Number($("#vehClimb")?.value) || 2.9);
  const roadKm = (cap * road).toFixed(1);
  const hwKm = (cap * hw).toFixed(1);
  const climbKm = (cap * climb).toFixed(1);
  box.innerHTML = `
    <div class="veh-conv-head">⚡ 100% 滿電（<b>${cap} 度電</b>）三種路況里程自動換算：</div>
    <div class="veh-conv-grid">
      <div class="veh-conv-item">
        <span>平路行駛（${road} km/度）</span>
        <strong>${Math.round(cap * road)} km <small>（精算 ${roadKm} km · 每 1% 約 ${(cap * road / 100).toFixed(2)} km）</small></strong>
      </div>
      <div class="veh-conv-item">
        <span>高速行駛（${hw} km/度）</span>
        <strong>${Math.round(cap * hw)} km <small>（精算 ${hwKm} km · 每 1% 約 ${(cap * hw / 100).toFixed(2)} km）</small></strong>
      </div>
      <div class="veh-conv-item">
        <span>爬坡山路（${climb} km/度）</span>
        <strong>${Math.round(cap * climb)} km <small>（精算 ${climbKm} km · 每 1% 約 ${(cap * climb / 100).toFixed(2)} km）</small></strong>
      </div>
    </div>
  `;
}

function syncEvOutputs() {
  const ev = state.ev;
  const calc = computeEv(ev);
  const vehicle = calc.vehicle;

  const sel = $("#vehicleSelect");
  if (sel) sel.value = vehicle.id;

  const note = $("#evNote");
  if (note) {
    note.innerHTML = `<span>ⓘ</span><span>目前使用：<b>${esc(vehicle.name)}</b> · 100% 滿電 <b>${calc.capacity} 度電 (kWh)</b><br>每度電可跑：平路 <b>${vehicle.road} km</b>（滿電 <b>${Math.round(calc.idealRanges.road)} km</b>） ／ 高速 <b>${vehicle.highway} km</b>（滿電 <b>${Math.round(calc.idealRanges.highway)} km</b>） ／ 爬坡 <b>${vehicle.climb} km</b>（滿電 <b>${Math.round(calc.idealRanges.climb)} km</b>） · 接頭 <b>${esc(vehicle.connector)}</b></span>`;
  }

  updateVehConversionBox();

  const inputs = [
    ["#evStartSoc", "#evStartVal", "startSoc", "%", 0],
    ["#evReserve", "#evReserveVal", "reserve", "%", 0],
    ["#evTemp", "#evTempVal", "temp", "°C", 0],
  ];
  inputs.forEach(([inputSel, labelId, key, unit, digits]) => {
    const input = $(inputSel);
    const label = $(labelId);
    if (!input || !label) return;
    const value = Number(ev[key]);
    input.value = value;
    const min = Number(input.min);
    const max = Number(input.max);
    input.style.setProperty("--p", `${((value - min) / (max - min)) * 100}%`);
    label.innerHTML = `${Number(value).toFixed(digits)}<em>${unit}</em>`;
  });

  Object.entries(SEGMENTS).forEach(([group, cfg]) => {
    $$(`[data-seg="${group}"]`).forEach((btn) => {
      btn.classList.toggle("is-on", btn.dataset.value === ev[group]);
    });
  });

  const result = $("#evResult");
  if (result) {
    result.innerHTML = `
      <div class="ev-result-top">
        <div>
          <span>單趟可用里程（${ev.startSoc}%→${ev.reserve}% · 可用 ${calc.usableKwh.toFixed(1)} 度）</span>
          <strong>平路 ${Math.round(calc.usableRanges.road)}<em>km</em></strong>
        </div>
        <div>
          <span>100% 滿電（${calc.capacity} 度）基準／環境修正里程</span>
          <strong>${Math.round(calc.idealRanges.road)} / ${Math.round(calc.fullRanges.road)} km</strong>
        </div>
      </div>
      <p>100%（${calc.capacity} 度電）標準換算：平路 <b>${calc.idealRanges.road.toFixed(1)} km</b>（${vehicle.road} km/度） · 高速 <b>${calc.idealRanges.highway.toFixed(1)} km</b>（${vehicle.highway} km/度） · 爬坡 <b>${calc.idealRanges.climb.toFixed(1)} km</b>（${vehicle.climb} km/度）<br>納入氣溫／空調／載重（×${calc.mult.toFixed(2)}）後實際電耗：平路 <b>${calc.kmPerKwh.road.toFixed(1)}</b> · 高速 <b>${calc.kmPerKwh.highway.toFixed(1)}</b> · 爬坡 <b>${calc.kmPerKwh.climb.toFixed(1)}</b> km/度（高速可用 <b>${Math.round(calc.usableRanges.highway)} km</b> ／ 爬坡可用 <b>${Math.round(calc.usableRanges.climb)} km</b>）</p>
    `;
  }

  const factors = $("#evFactors");
  if (factors) {
    const rows = [
      ["氣溫", `${ev.temp}°C`, calc.factors.temp],
      ["空調", SEGMENTS.ac.options.find((o) => o[0] === ev.ac)?.[1] || "—", calc.factors.ac],
      ["載重", SEGMENTS.load.options.find((o) => o[0] === ev.load)?.[1] || "—", calc.factors.load],
      ["天候", SEGMENTS.weather.options.find((o) => o[0] === ev.weather)?.[1] || "—", calc.factors.weather],
    ];
    factors.innerHTML = rows.map(([label, text, value]) => {
      const width = clamp(value * 100, 35, 100);
      return `<div class="factor-item ${value < 0.95 ? "is-neg" : ""}">
        <span>${label} <small style="color:var(--muted-2)">${esc(text)}</small></span>
        <span class="factor-bar"><i style="width:${width}%"></i></span>
        <b>×${value.toFixed(2)}</b>
      </div>`;
    }).join("");
  }

  if (state.view === "ev" && typeof updateRangeRing === "function") updateRangeRing();
  updateTop();
}

function renderEvOutputs() {
  syncEvOutputs();
}

/* ---------------- 車庫操作 ---------------- */
function readVehicleForm() {
  const range = Number($("#vehRange")?.value);
  const road = Number($("#vehRoad")?.value);
  const derivedCap = (range > 0 && road > 0) ? Math.round((range / road) * 10) / 10 : 57.3;
  const rawCap = Number($("#vehCapacity")?.value);
  return {
    name: ($("#vehName")?.value || "").trim(),
    range,
    road,
    highway: Number($("#vehHighway")?.value),
    climb: Number($("#vehClimb")?.value),
    capacity: Number.isFinite(rawCap) && rawCap > 0 ? rawCap : derivedCap,
    connector: $("#vehConnector")?.value || "CCS1",
  };
}

function fillVehiclePreset(presetKey) {
  if (presetKey === "blank") {
    if ($("#vehName")) $("#vehName").value = "";
    if ($("#vehCapacity")) $("#vehCapacity").value = 57;
    if ($("#vehRoad")) $("#vehRoad").value = 6.7;
    if ($("#vehHighway")) $("#vehHighway").value = 3.1;
    if ($("#vehClimb")) $("#vehClimb").value = 2.9;
    if ($("#vehRange")) $("#vehRange").value = 382;
    if ($("#vehConnector")) $("#vehConnector").value = "CCS1";
    updateVehConversionBox();
    $("#vehName")?.focus();
    toast("已清空車名並帶入 57 度電（6.7 / 3.1 / 2.9）預設值");
    return;
  }
  const p = typeof VEHICLE_PRESETS !== "undefined" ? VEHICLE_PRESETS[presetKey] : null;
  if (!p) return;
  if ($("#vehName")) $("#vehName").value = p.name;
  if ($("#vehRange")) $("#vehRange").value = p.range;
  if ($("#vehRoad")) $("#vehRoad").value = p.road;
  if ($("#vehHighway")) $("#vehHighway").value = p.highway;
  if ($("#vehClimb")) $("#vehClimb").value = p.climb;
  if ($("#vehCapacity")) $("#vehCapacity").value = p.capacity;
  if ($("#vehConnector")) $("#vehConnector").value = p.connector || "CCS1";
  updateVehConversionBox();
  toast(`已帶入「${p.name}」參數，可按「＋ 新增為一台車」或「儲存修改目前這台」`);
}

function saveVehicleForm(act) {
  const raw = readVehicleForm();
  if (!raw.name) { toast("請先填寫車子型號"); $("#vehName")?.focus(); return; }
  if (![raw.capacity, raw.road, raw.highway, raw.climb].every((n) => Number.isFinite(n) && n > 0)) {
    toast("100% 電池容量與平常道路／高速／爬坡每度電公里數都要填大於 0 的數字");
    return;
  }
  raw.range = Math.round(raw.capacity * raw.road);
  const vehicles = vehicleList(state.ev);
  const active = activeVehicle(state.ev);
  if (act === "add") {
    const v = normalizeVehicle({ ...raw, id: `veh-${Date.now()}` });
    vehicles.push(v);
    state.ev.vehicles = vehicles;
    state.ev.vehicleId = v.id;
    toast(`已新增「${v.name}」（100%=${v.capacity}度，平路滿電 ${v.range} km），並切換為目前用車`);
  } else if (act === "update") {
    state.ev.vehicles = vehicles.map((v) => v.id === active.id ? normalizeVehicle({ ...raw, id: v.id }) : v);
    toast(`已更新「${raw.name}」的車輛參數與里程計算`);
  } else if (act === "delete") {
    if (vehicles.length <= 1) { toast("車庫至少要保留一台車"); return; }
    if (!window.confirm(`確定刪除「${active.name}」？`)) return;
    state.ev.vehicles = vehicles.filter((v) => v.id !== active.id);
    state.ev.vehicleId = state.ev.vehicles[0].id;
    toast("已刪除，切換為車庫第一台車");
  }
  persist();
  renderEvPanel();
  renderTrip();
}

function wirePlanner() {
  const evPanel = $("#evPanel");
  evPanel?.addEventListener("input", (e) => {
    // 當修改 100% 電池容量、平路／高速／爬坡 km/kWh 或總里程時，自動同步換算
    if (["vehCapacity", "vehRoad", "vehHighway", "vehClimb", "vehRange"].includes(e.target.id)) {
      const cap = Number($("#vehCapacity")?.value);
      const road = Number($("#vehRoad")?.value);
      const r = Number($("#vehRange")?.value);
      if (e.target.id === "vehRange" && r > 0 && road > 0 && $("#vehCapacity")) {
        $("#vehCapacity").value = (Math.round((r / road) * 10) / 10).toFixed(1);
      } else if (cap > 0 && road > 0 && $("#vehRange")) {
        $("#vehRange").value = Math.round(cap * road);
      }
      updateVehConversionBox();
      return;
    }
    const input = e.target.closest("[data-ev]");
    if (!input) return;
    const key = input.dataset.ev;
    state.ev[key] = Number(input.value);
    persist();
    syncEvOutputs();
    renderTrip();
  });

  evPanel?.addEventListener("change", (e) => {
    const sel = e.target.closest("#vehicleSelect");
    if (!sel) return;
    state.ev.vehicleId = sel.value;
    persist();
    renderEvPanel();
    renderTrip();
    toast(`已切換用車：${activeVehicle(state.ev).name}`);
  });

  evPanel?.addEventListener("click", (e) => {
    const presetBtn = e.target.closest("[data-veh-preset]");
    if (presetBtn) { fillVehiclePreset(presetBtn.dataset.vehPreset); return; }
    const actBtn = e.target.closest("[data-vehicle-act]");
    if (actBtn) { saveVehicleForm(actBtn.dataset.vehicleAct); return; }
    const seg = e.target.closest("[data-seg]");
    if (!seg) return;
    state.ev[seg.dataset.seg] = seg.dataset.value;
    persist();
    syncEvOutputs();
    renderTrip();
  });

  /* 行程面板：終點預留電量＋山下補電模式 */
  const destRange = $("#destReserveRange");
  destRange?.addEventListener("input", (e) => {
    state.ev.destReserve = clamp(Number(e.target.value) || 30, 10, 60);
    persist();
    renderTrip();
  });
  $("#destReserveBlock")?.addEventListener("click", (e) => {
    const openBtn = e.target.closest("[data-open-reserve]");
    if (openBtn) { openReserveModal(); return; }
    const btn = e.target.closest("[data-dest]");
    if (!btn) return;
    state.ev.destReserve = clamp(Number(btn.dataset.dest) || 30, 10, 60);
    persist();
    renderTrip();
  });
  $("#baseModeSelect")?.addEventListener("change", (e) => {
    state.ev.baseChargeMode = e.target.value || "auto";
    persist();
    renderTrip();
  });

  /* 走法切換（走法按鈕與路線比較卡共用） */
  $("#routeModeBlock")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-route]");
    if (btn) {
      state.ev.routeMode = btn.dataset.route || "auto";
      state.ev.highwayChargeId = "";
      persist();
      renderTrip();
      return;
    }
    const pick = e.target.closest("[data-pick-highway]");
    if (pick) {
      const id = pick.dataset.pickHighway || "";
      state.ev.highwayChargeId = state.ev.highwayChargeId === id ? "" : id;
      persist();
      renderTrip();
      toast(state.ev.highwayChargeId ? "已選定國道服務區補電點" : "已取消國道服務區補電點，改回自動補電");
    }
  });

  /* 出遊天數與回程 */
  $("#tripDaysSelect")?.addEventListener("change", (e) => {
    state.ev.tripDays = clamp(Number(e.target.value) || 1, 1, 7);
    persist();
    renderTrip();
  });
  $("#returnTripCheck")?.addEventListener("change", (e) => {
    state.ev.returnTrip = !!e.target.checked;
    persist();
    renderTrip();
  });
  $("#stopList")?.addEventListener("change", (e) => {
    const sel = e.target.closest("[data-day-select]");
    if (!sel) return;
    state.stopDays[sel.dataset.daySelect] = clamp(Number(sel.value) || 1, 1, 7);
    persist();
    renderTrip();
  });

  /* 山下補電卡片：切換同區其他 N7 快充站 */
  $("#baseCheckWrap")?.addEventListener("click", (e) => {
    const pickBtn = e.target.closest("[data-pick-base]");
    if (!pickBtn) return;
    state.ev.baseChargerId = pickBtn.dataset.pickBase || "";
    persist();
    renderTrip();
    renderMarkers();
    toast(state.ev.baseChargerId ? "已切換山下補電站" : "已恢復自動挑選最佳山下快充站");
  });

  /* 車宿留電詢問 Modal 事件 */
  $("#modalReserveRange")?.addEventListener("input", (e) => {
    state.ev.destReserve = clamp(Number(e.target.value) || 30, 10, 60);
    persist();
    updateReserveModalPreview();
    renderTrip();
  });
  $("#modalReserveBtns")?.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-modal-dest]");
    if (!btn) return;
    state.ev.destReserve = clamp(Number(btn.dataset.modalDest) || 30, 10, 60);
    persist();
    updateReserveModalPreview();
    renderTrip();
  });
  $("#modalBaseModeSelect")?.addEventListener("change", (e) => {
    state.ev.baseChargeMode = e.target.value || "auto";
    persist();
    updateReserveModalPreview();
    renderTrip();
  });
  $("#reserveModalClose")?.addEventListener("click", closeReserveModal);
  $("#reserveModalSkip")?.addEventListener("click", closeReserveModal);
  $("#reserveModalConfirm")?.addEventListener("click", () => {
    closeReserveModal();
    switchView("trip");
  });
  $("#reserveModal")?.addEventListener("click", (e) => {
    if (e.target === $("#reserveModal")) closeReserveModal();
  });

  $("#stopList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-goto]");
    if (btn) switchView(btn.dataset.goto);
  });

  $("#tripNearbyWrap")?.addEventListener("click", (e) => {
    const addBtn = e.target.closest("[data-tn-add]");
    if (addBtn) {
      addStop(addBtn.dataset.tnAdd);
      return;
    }
    const focusBtn = e.target.closest("[data-tn-focus]");
    if (focusBtn) {
      selectPOI(focusBtn.dataset.tnFocus);
    }
  });

  $("#liveSpotBtn")?.addEventListener("click", fetchLiveSpotsForTrip);

  $("#savedWrap").addEventListener("click", (e) => {
    const load = e.target.closest("[data-load]");
    if (load) { loadSaved(load.dataset.load); return; }
    const del = e.target.closest("[data-del]");
    if (del) {
      if (window.confirm("刪除這筆儲存行程？")) deleteSaved(del.dataset.del);
    }
  });
}

document.addEventListener("DOMContentLoaded", wirePlanner);
