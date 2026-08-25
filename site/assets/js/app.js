const SECTION_KEYS = ["headlines", "ai", "tech", "finance", "economy", "education", "internet", "life"];
const COL_TITLES = {
  headlines: "每日要闻汇总",
  ai: "AI · 大模型动态",
  tech: "科技硬核",
  finance: "财经 · 市场",
  economy: "宏观经济",
  education: "教育",
  internet: "互联网大厂",
  life: "生活 · 消费"
};

let archiveDates = [];
let currentEditions = [];   // 当前日期的版次列表 [{dateKey, slot, label}]
let currentSlot = null;     // 当前正在看的版次 "08" or "18"

async function loadJSON(path) {
  const r = await fetch(path, { cache: "no-store" });
  if (!r.ok) throw new Error("加载失败: " + path);
  return r.json();
}

function fmt(v) { return Number(v).toLocaleString("zh-CN"); }

function changeClass(p) {
  if (p === null || p === undefined) return "flat";
  return p > 0 ? "up" : (p < 0 ? "down" : "flat");
}
function changeText(p) {
  if (p === null || p === undefined) return "";
  return (p > 0 ? "+" : "") + p.toFixed(2) + "%";
}

function sparkline(series, color) {
  if (!series || series.length === 0) return '<span class="wnote">历史数据积累中</span>';
  const w = 200, h = 46, pad = 4;
  const vals = series.map(d => d.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1;
  const n = series.length;
  const pts = series.map((d, i) => {
    const x = n === 1 ? w / 2 : pad + i * (w - 2 * pad) / (n - 1);
    const y = h - pad - ((d.value - min) / span) * (h - 2 * pad);
    return [x, y];
  });
  if (n === 1) {
    return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
      <circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="3" fill="${color}"/>
      <text x="${w / 2}" y="${h - 2}" text-anchor="middle" font-size="9" fill="#9aa6b2">仅 1 期 · 积累中</text>
    </svg>`;
  }
  const path = pts.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = path + ` L ${pts[n - 1][0].toFixed(1)} ${h} L ${pts[0][0].toFixed(1)} ${h} Z`;
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <path d="${area}" fill="${color}" opacity="0.10"/>
    <path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>
    <circle cx="${pts[n - 1][0].toFixed(1)}" cy="${pts[n - 1][1]}" r="3" fill="${color}"/>
  </svg>`;
}

function renderWatch(group, seriesAll, color) {
  return group.map(item => {
    const s = (seriesAll && seriesAll[item.id]) ? seriesAll[item.id] : [];
    const chg = changeText(item.changePct);
    const chgCls = changeClass(item.changePct);
    const ytd = (item.ytd !== null && item.ytd !== undefined)
      ? ` · <span class="${item.ytd >= 0 ? 'up' : 'down'}">年内 ${(item.ytd > 0 ? '+' : '')}${item.ytd}%</span>` : "";
    return `<div class="wcard">
      <div class="wname">${item.name}<span class="wcode">${item.code || ""}</span></div>
      <div class="wval">${fmt(item.value)}<span class="wunit">${item.unit}</span></div>
      <div class="wchg ${chgCls}">${chg}${ytd}</div>
      ${sparkline(s, color)}
      <div class="wnote">${item.note || ""}</div>
    </div>`;
  }).join("");
}

function renderNews(sections) {
  let html = "";
  SECTION_KEYS.forEach(key => {
    const sec = sections[key];
    if (!sec) return;
    const label = sec.label || COL_TITLES[key];
    html += `<h3 class="col-title">${label}</h3>`;
    html += '<div class="news-grid">';
    html += sec.items.map(it => {
      const tag = it.tag ? `<span class="ntag">${it.tag}</span>` : "";
      const src = it.source ? `<span>${it.source}</span>` : "<span></span>";
      const link = it.url ? `<a href="${it.url}" target="_blank" rel="noopener">查看来源 ↗</a>` : "<span></span>";
      return `<div class="ncard">${tag}<h3>${it.title}</h3><p>${it.summary}</p><div class="nmeta">${src}${link}</div></div>`;
    }).join("");
    html += '</div>';
  });
  return html;
}

function renderAll(data, stocksSeries, fundsSeries) {
  document.getElementById("siteName").textContent = data.siteName || "每日前沿简报";
  // 日期+版次显示
  const editionTag = data.edition ? ` · ${data.edition}` : "";
  document.getElementById("dateLabel").textContent = "更新于 " + (data.date || "") + editionTag;
  const watch = data.watchlist || {};
  const grid = document.getElementById("watchGrid");
  grid.innerHTML =
    renderWatch(watch.stocks || [], stocksSeries, "#2f6bff") +
    renderWatch(watch.funds || [], fundsSeries, "#9a5bff");
  document.getElementById("news").innerHTML = renderNews(data.sections);
}

// 渲染版次切换按钮
function renderEditionTabs(dateStr) {
  const container = document.getElementById("editionTabs");
  if (!currentEditions.length) {
    container.innerHTML = "";
    container.style.display = "none";
    return;
  }
  if (currentEditions.length === 1) {
    // 只有一个版次，简单显示标签
    container.innerHTML = `<span class="edition-label">${currentEditions[0].label}</span>`;
    container.style.display = "flex";
    return;
  }
  // 多个版次：显示切换按钮
  container.innerHTML = currentEditions.map(ed => {
    const active = ed.slot === currentSlot ? " active" : "";
    return `<button class="edition-btn${active}" data-slot="${ed.slot}">${ed.label}</button>`;
  }).join("");
  container.style.display = "flex";
  // 绑定点击
  container.querySelectorAll(".edition-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const slot = btn.dataset.slot;
      if (slot === currentSlot) return;
      currentSlot = slot;
      renderEditionTabs(dateStr);
      await loadEdition(dateStr, slot);
    });
  });
}

// 加载指定版次
async function loadEdition(dateStr, slot) {
  const status = document.getElementById("dateStatus");
  try {
    const dateKey = dateStr + "-" + slot;
    const data = await loadJSON("data/digest-" + dateKey + ".json");
    status.textContent = "";
    const stocks = await loadJSON("data/history/stocks.json").catch(() => ({ series: {} }));
    const funds = await loadJSON("data/history/funds.json").catch(() => ({ series: {} }));
    renderAll(data, stocks.series, funds.series);
  } catch (e) {
    status.textContent = "加载版次失败";
  }
}

async function setDate(dateStr) {
  const status = document.getElementById("dateStatus");
  try {
    // 先查该日有哪些版次
    const edInfo = await loadJSON("data/editions/" + dateStr + ".json").catch(() => null);
    currentEditions = edInfo ? edInfo.editions || [] : [];

    if (currentEditions.length === 0) {
      // 旧格式兼容：直接尝试加载
      try {
        const data = await loadJSON("data/digest-" + dateStr + ".json");
        currentSlot = data.slot || null;
        currentEditions = currentSlot ? [{ dateKey: dateStr + "-" + currentSlot, slot: currentSlot, label: data.edition || currentSlot }] : [];
        status.textContent = "";
        const stocks = await loadJSON("data/history/stocks.json").catch(() => ({ series: {} }));
        const funds = await loadJSON("data/history/funds.json").catch(() => ({ series: {} }));
        renderAll(data, stocks.series, funds.series);
        renderEditionTabs(dateStr);
        return;
      } catch (e2) {
        // 完全没数据
      }
      status.textContent = "该日期暂无内容";
      document.getElementById("news").innerHTML =
        '<p style="color:#6b7785">所选日期（' + dateStr + '）暂无简报。本网站自 2026-08-19 起每日自动生成，请选择该日期之后的日子。</p>';
      renderEditionTabs(dateStr);
      return;
    }

    // 默认加载最新版次（列表最后一个）
    const latest = currentEditions[currentEditions.length - 1];
    currentSlot = latest.slot;
    renderEditionTabs(dateStr);
    await loadEdition(dateStr, currentSlot);
  } catch (e) {
    status.textContent = "加载失败: " + e.message;
  }
}

(async () => {
  try {
    try {
      const arch = await loadJSON("data/archive.json");
      archiveDates = (arch.dates || []).slice().sort().reverse();
    } catch (e) { archiveDates = []; }

    const input = document.getElementById("dateInput");
    const list = document.getElementById("archiveList");

    // 始终先拿最新一期
    const latest = await loadJSON("data/digest-latest.json");
    const latestDate = latest.date || new Date().toISOString().slice(0, 10);
    currentSlot = latest.slot || null;

    // 日期下拉 = 归档日期 ∪ 最新日期（去重、倒序）
    const allDates = Array.from(new Set([...archiveDates, latestDate])).sort().reverse();
    if (allDates.length) {
      list.innerHTML = allDates.map(d => `<option value="${d}"></option>`).join("");
      input.min = allDates[allDates.length - 1];
      input.max = allDates[0];
      input.value = latestDate;
    } else {
      input.value = latestDate;
      input.max = latestDate;
    }

    // "最新"按钮：总是重新拉取最新一期
    document.getElementById("latestBtn").addEventListener("click", async () => {
      const data = await loadJSON("data/digest-latest.json");
      input.value = data.date || latestDate;
      currentSlot = data.slot || null;
      document.getElementById("dateStatus").textContent = "";
      const stocks = await loadJSON("data/history/stocks.json").catch(() => ({ series: {} }));
      const funds = await loadJSON("data/history/funds.json").catch(() => ({ series: {} }));
      renderAll(data, stocks.series, funds.series);
      // 加载版次信息
      const edInfo = await loadJSON("data/editions/" + data.date + ".json").catch(() => null);
      currentEditions = edInfo ? edInfo.editions || [] : [];
      if (currentEditions.length <= 1 && currentSlot) {
        currentEditions = [{ dateKey: data.date + "-" + currentSlot, slot: currentSlot, label: data.edition || currentSlot }];
      }
      renderEditionTabs(data.date);
    });

    input.addEventListener("change", () => { if (input.value) setDate(input.value); });

    // 默认展示最新一期
    const stocks = await loadJSON("data/history/stocks.json").catch(() => ({ series: {} }));
    const funds = await loadJSON("data/history/funds.json").catch(() => ({ series: {} }));
    renderAll(latest, stocks.series, funds.series);

    // 加载当前日期的版次信息
    const edInfo = await loadJSON("data/editions/" + latestDate + ".json").catch(() => null);
    currentEditions = edInfo ? edInfo.editions || [] : [];
    if (currentEditions.length === 0 && currentSlot) {
      currentEditions = [{ dateKey: latestDate + "-" + currentSlot, slot: currentSlot, label: latest.edition || currentSlot }];
    }
    renderEditionTabs(latestDate);
  } catch (e) {
    document.getElementById("news").innerHTML =
      '<p style="color:#e23b3b">加载失败：' + e.message + '。</p>';
  }
})();
