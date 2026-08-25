'use strict';
/**
 * 每日前沿简报 · 独立生成脚本（GitHub Actions / 本地均可运行）
 * - 抓取中文新闻源（RSS + JSON API）→ 调用大模型生成八板块简报 → 写入静态 JSON
 * - 输出目录结构（相对 DATA_DIR，默认 site/data）：
 *   digest-latest.json            最新一期
 *   digest-YYYY-MM-DD-HH.json     每期归档（HH=08/18）
 *   editions/YYYY-MM-DD.json      某日版次列表
 *   archive.json                  日期列表
 *   history/stocks.json           股票历史序列
 *   history/funds.json            基金历史序列
 *
 * 环境变量：
 *   LLM_BASE   大模型 base url（OpenAI 兼容），默认 https://api.deepseek.com/v1
 *   LLM_KEY    大模型 API Key（必填，GitHub Secrets 注入）
 *   LLM_MODEL  模型名，默认 deepseek-chat
 *   DATA_DIR   输出目录，默认 <脚本目录>/../site/data
 *   LIMIT      送入模型的最大素材条数，默认 60
 */

const fs = require('fs');
const path = require('path');

const LLM_BASE = (process.env.LLM_BASE || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const LLM_KEY = process.env.LLM_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'site', 'data'));
const LIMIT = parseInt(process.env.LIMIT || '60', 10) || 60;

// watchlist 默认值（随脚本打包，实时行情获取失败时回退用）
const WATCHLIST_DEFAULT = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.default.json'), 'utf8'));
  } catch (e) { return { stocks: [], funds: [] }; }
})();

// ---- 新闻源（中文、当日更新、多源容错；某源失效只记日志，不影响整体）----
const FETCH_TIMEOUT = 15000;
const LLM_TIMEOUT = 90000;
const NEWS_SOURCES = [
  { url: 'https://news-at.zhihu.com/api/4/news/latest', type: 'json', tag: 'headlines' },
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2510&num=30', type: 'json', tag: 'economy' },
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2511&num=30', type: 'json', tag: 'headlines' },
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2512&num=30', type: 'json', tag: 'life' },
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=30', type: 'json', tag: 'tech' },
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2518&num=30', type: 'json', tag: 'finance' },
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2523&num=30', type: 'json', tag: 'education' },
  { url: 'https://www.36kr.com/feed', type: 'rss', tag: 'tech' },
  { url: 'https://www.ithome.com/rss/', type: 'rss', tag: 'tech' },
  { url: 'https://www.geekpark.net/rss', type: 'rss', tag: 'ai' },
  { url: 'https://www.ifanr.com/feed', type: 'rss', tag: 'tech' },
  { url: 'https://www.huxiu.com/rss/0.xml', type: 'rss', tag: 'internet' },
  { url: 'https://sspai.com/feed', type: 'rss', tag: 'life' },
  { url: 'https://www.thepaper.cn/rss_news.xml', type: 'rss', tag: 'headlines' }
];

const SITE_NAME = '每日前沿简报';
const SECTIONS = ['headlines', 'ai', 'tech', 'finance', 'economy', 'education', 'internet', 'life'];
const SLOT_MORNING = '08';
const SLOT_EVENING = '18';

// ---- 北京时间工具 ----
const BEIJING_TZ = 'Asia/Shanghai';
function beijingDateStr(d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: BEIJING_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
  const g = k => { const x = p.find(t => t.type === k); return (x && x.value) || '00'; };
  return g('year') + '-' + g('month') + '-' + g('day');
}
function beijingHour(d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: BEIJING_TZ, hour: '2-digit', hour12: false }).formatToParts(d);
  const x = p.find(t => t.type === 'hour');
  return x ? parseInt(x.value, 10) : 12;
}
function beijingISO(d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: BEIJING_TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d);
  const g = k => { const x = p.find(t => t.type === k); return (x && x.value) || '00'; };
  return g('year') + '-' + g('month') + '-' + g('day') + 'T' + g('hour') + ':' + g('minute') + ':' + g('second') + '+08:00';
}

function log(...a) { console.log('[generate]', ...a); }

// ---- 文件读写 ----
function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}
function saveJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

// ---- 新闻抓取 ----
function cleanText(s) {
  return (s || '').toString().replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parsePubDate(raw) {
  if (!raw) return null;
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return beijingDateStr(d);
  } catch (e) {}
  const m1 = raw.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
  if (m1) return m1[1] + '-' + m1[2].padStart(2, '0') + '-' + m1[3].padStart(2, '0');
  return null;
}

function parseJsonNews(text, tag) {
  try {
    const data = JSON.parse(text);
    let list = [];
    if (Array.isArray(data.articles)) list = data.articles;
    else if (data.result && Array.isArray(data.result.data)) list = data.result.data;
    else if (Array.isArray(data.stories)) list = data.stories;
    else if (Array.isArray(data)) list = data;
    return list.map(a => {
      const title = cleanText(a.title || a.name || '');
      const url = cleanText(a.url || a.share_url || a.link || '');
      const summary = cleanText(a.intro || a.description || a.summary || a.content || a.hint || '').slice(0, 300);
      const source = cleanText(a.source || a.sourceName || a.siteName || '');
      const pubDateRaw = a.ctime || a.intime || a.pubDate || a.publishedAt || a.publish_time || a.created_at || a.date || '';
      const pubDate = parsePubDate(pubDateRaw);
      return { title, url, summary, source, tag, pubDate };
    }).filter(m => m.title && m.url && /^https?:/i.test(m.url));
  } catch (e) { return []; }
}

function parseRss(xml, tag) {
  const items = [];
  const channelTitle = (xml.match(/<channel>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const channelSource = cleanText(channelTitle);
  const blocks = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/g) || [];
  for (const b of blocks) {
    const pick = (t) => {
      const m = b.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)<\/' + t + '>', 'i'));
      return m ? cleanText(m[1]) : '';
    };
    const title = pick('title');
    let link = pick('link');
    if (!link) {
      const lm = b.match(/<link[^>]*href="([^"]+)"/i);
      if (lm) link = lm[1];
    }
    const desc = pick('description') || pick('summary') || pick('content');
    const pubDateRaw = pick('pubDate') || pick('published') || pick('date') || pick('updated') || '';
    const pubDate = parsePubDate(pubDateRaw);
    if (title && link) items.push({ title, url: link, summary: desc.slice(0, 300), source: channelSource, tag, pubDate });
  }
  return items;
}

async function fetchSource(source) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    const res = await fetch(source.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DailyBriefBot/1.0)' }
    });
    clearTimeout(t);
    if (!res.ok) { log('source not ok', source.url, res.status); return []; }
    const text = await res.text();
    const items = source.type === 'json' ? parseJsonNews(text, source.tag) : parseRss(text, source.tag);
    log('source ok', source.url, items.length);
    return items;
  } catch (e) {
    log('source failed', source.url, e.message);
    return [];
  }
}

// ---- 大模型调用 ----
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  throw new Error('no json in llm response');
}

async function callLLM(material) {
  const sys = '你是一位帮用户筛选「今天值得看」的多领域资讯编辑（科技 / AI / 财经 / 宏观 / 教育 / 互联网 / 生活），不是新闻通稿播报员。根据下面的新闻素材，产出一份有用、好读、像人话的每日简报。\n'
    + '风格要求（非常重要）：\n'
    + '1. 说人话：title 不要照抄原标题，改写成大白话，让人一眼看懂讲的是啥。\n'
    + '2. 每条都要有「看点」：summary 用两句话——第一句讲「发生了什么」（大白话），第二句用「看点：」开头点出为什么值得花30秒看（对普通人的影响 / 背后的趋势 / 信息量在哪）。\n'
    + '3. 宁缺毋滥：只挑当天真正有信息量、和普通人相关的消息（影响钱包、生活、工作、科技趋势）；过滤掉广告、软文、口水花边、纯蹭热点的内容。\n'
    + '4. 内容要新鲜、具体、有信息量：基于素材写，不编造；同一期简报里不要重复相似内容；不要出现「据悉、日前、有关人士」这类官腔套话。\n'
    + '只输出一个 JSON 对象，不要任何解释文字，格式如下：\n'
    + '{\n'
    + '  "sections": {\n'
    + '    "headlines": {"label":"今日必读","items":[{"title":"","summary":"发生了什么…。看点：…","source":"","url":"","tag":""}]},\n'
    + '    "ai": {"label":"AI · 大模型动态","items":[...]},\n'
    + '    "tech": {"label":"科技硬核","items":[...]},\n'
    + '    "finance": {"label":"财经 · 市场","items":[...]},\n'
    + '    "economy": {"label":"宏观经济","items":[...]},\n'
    + '    "education": {"label":"教育","items":[...]},\n'
    + '    "internet": {"label":"互联网大厂","items":[...]},\n'
    + '    "life": {"label":"生活 · 消费","items":[...]}\n'
    + '  }\n'
    + '}\n'
    + '要求：今日必读 / AI / 科技硬核 / 财经市场 每板块 3-4 条；宏观经济 / 教育 / 互联网大厂 / 生活消费 每板块 2-3 条；title 为简体中文、口语化；summary 为「发生了什么 + 看点」两句话；source 用素材里的真实媒体名；url 用素材里的真实链接；tag 为 2-6 字口语标签（如「降息」「新机发布」「监管新规」）。'
    + '板块定位：headlines=当天最重要的综合要闻；ai=大模型/AI 应用；tech=芯片/机器人/航天等硬科技；finance=股市/基金/黄金/外汇；economy=宏观政策/经济数据/国际贸易；education=教育政策/升学/校园/教育科技；internet=互联网大厂/电商/社交/App；life=民生/消费/健康/出行。'
    + '同一事件全简报只能出现一次，严禁跨板块重复；哪个板块素材不足就少于该条数，但绝不编造、绝不用过期旧闻充数。';

  const user = '以下是今日（'
    + new Date().toLocaleDateString('zh-CN')
    + '）收集到的新闻素材（标题 / 链接 / 摘要）：\n\n'
    + material.map((m, i) => `${i + 1}. [${m.title}](${m.url})\n   ${m.summary}`).join('\n\n');

  const base = {
    model: LLM_MODEL,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: 0.5
  };

  const doCall = async (useJson) => {
    const body = Object.assign({}, base);
    if (useJson) body.response_format = { type: 'json_object' };
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), LLM_TIMEOUT);
    const res = await fetch(LLM_BASE + '/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + LLM_KEY },
      body: JSON.stringify(body)
    });
    clearTimeout(t);
    if (!res.ok) {
      const t2 = await res.text().catch(() => '');
      throw new Error('LLM ' + res.status + ': ' + t2.slice(0, 300));
    }
    const data = await res.json();
    const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) throw new Error('LLM empty content');
    return content;
  };

  let parsed;
  let lastErr;
  for (const useJson of [true, false]) {
    try {
      const content = await doCall(useJson);
      parsed = JSON.parse(extractJson(content));
      break;
    } catch (e) {
      lastErr = e;
      log('LLM attempt (json=' + useJson + ') failed:', e.message);
    }
  }
  if (parsed === undefined) throw lastErr || new Error('LLM all attempts failed');
  return parsed;
}

// ---- 自选列表（实时行情，失败回退默认）----
const GTIMG_TIMEOUT = 12000;
async function fetchWatchlist() {
  const stocks = (WATCHLIST_DEFAULT.stocks || []).map(s => Object.assign({}, s));
  const liveCodes = stocks.filter(s => /^(sh|sz|hk)\w+$/i.test(s.id)).map(s => s.id);
  if (liveCodes.length) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), GTIMG_TIMEOUT);
      const res = await fetch('https://qt.gtimg.cn/q=' + liveCodes.join(','), {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DailyBriefBot/1.0)' }
      });
      clearTimeout(t);
      const txt = await res.text();
      const map = {};
      (txt.match(/v_\w+="[^"]*"/g) || []).forEach(seg => {
        const m = seg.match(/v_(\w+)="([^"]*)"/);
        if (m) map[m[1].toLowerCase()] = m[2];
      });
      for (const s of stocks) {
        const raw = map[s.id.toLowerCase()];
        if (!raw) continue;
        const p = raw.split('~');
        const val = parseFloat(p[3]);
        const prev = parseFloat(p[4]);
        if (!isNaN(val)) s.value = val;
        if (!isNaN(val) && !isNaN(prev) && prev !== 0) {
          s.changePct = +(((val - prev) / prev) * 100).toFixed(2);
        }
      }
      log('watchlist live updated for', liveCodes.length, 'codes');
    } catch (e) {
      log('watchlist live fetch failed, use default:', e.message);
    }
  }
  return {
    stocks,
    funds: (WATCHLIST_DEFAULT.funds || []).map(f => Object.assign({}, f))
  };
}

// ---- 历史序列更新（追加当日值）----
function appendHistory(histFile, items, dateStr) {
  const hist = loadJSON(histFile) || { series: {} };
  for (const it of items) {
    if (it.value === null || it.value === undefined || isNaN(it.value)) continue;
    const id = it.id || it.code || it.name;
    if (!id) continue;
    const arr = hist.series[id] || [];
    const last = arr[arr.length - 1];
    if (last && last.date === dateStr) continue; // 同日已记录
    arr.push({ date: dateStr, value: it.value });
    hist.series[id] = arr.slice(-180); // 最多保留180期
  }
  saveJSON(histFile, hist);
}

// ---- 主流程 ----
async function run() {
  if (!LLM_KEY) throw new Error('LLM_KEY 未配置');
  const now = new Date();
  const dateStr = beijingDateStr(now);
  const hour = beijingHour(now);
  const slot = hour < 14 ? SLOT_MORNING : SLOT_EVENING;
  const dateKey = dateStr + '-' + slot;
  const editionLabel = slot === SLOT_MORNING ? '晨报' : '晚报';
  log('start', dateKey, '(' + editionLabel + ')');

  // 1) 抓取素材
  const sources = await Promise.all(NEWS_SOURCES.map(fetchSource));
  let material = sources.flat().filter(m => m.title && m.url);
  const seen = new Set();
  material = material.filter(m => { const k = m.url; if (seen.has(k)) return false; seen.add(k); return true; });

  // 只保留今天发布的新闻（pubDate 为空则保留，避免误杀无法解析日期的源）
  const beforeFilter = material.length;
  material = material.filter(m => {
    if (!m.pubDate) return true;
    return m.pubDate === dateStr;
  });
  log('date filter: kept', material.length, '/', beforeFilter, '(today=' + dateStr + ')');
  if (material.length === 0) throw new Error('no news material fetched (after date filter)');

  // 打乱顺序，避免取前 N 条全是同一来源
  for (let i = material.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [material[i], material[j]] = [material[j], material[i]];
  }
  if (material.length > LIMIT) material = material.slice(0, LIMIT);
  log('use', material.length, 'items for llm');

  // 2) 大模型生成
  const llm = await callLLM(material);
  const sections = llm.sections || {};
  for (const s of SECTIONS) {
    if (!sections[s] || !Array.isArray(sections[s].items)) sections[s] = { label: s, items: [] };
  }

  // 3) 组装 digest
  const watchlist = await fetchWatchlist();
  const digest = {
    date: dateStr,
    slot: slot,
    edition: editionLabel,
    updatedAt: beijingISO(now),
    siteName: SITE_NAME,
    sections,
    watchlist
  };

  // 4) 写文件
  fs.mkdirSync(DATA_DIR, { recursive: true });
  saveJSON(path.join(DATA_DIR, 'digest-latest.json'), digest);
  saveJSON(path.join(DATA_DIR, 'digest-' + dateKey + '.json'), digest);

  // editions/{date}.json：该日所有版次列表（含历史，按 slot 排序）
  const edFile = path.join(DATA_DIR, 'editions', dateStr + '.json');
  const edOld = loadJSON(edFile) || { date: dateStr, editions: [] };
  const edList = edOld.editions || [];
  const exists = edList.some(e => e.dateKey === dateKey);
  if (!exists) edList.push({ dateKey, slot, label: editionLabel });
  edList.sort((a, b) => a.slot.localeCompare(b.slot));
  saveJSON(edFile, { date: dateStr, editions: edList });

  // archive.json：日期列表
  const archFile = path.join(DATA_DIR, 'archive.json');
  const archOld = loadJSON(archFile) || { dates: [] };
  const dates = archOld.dates || [];
  if (!dates.includes(dateStr)) dates.push(dateStr);
  dates.sort();
  saveJSON(archFile, { dates });

  // history：追加当日行情
  appendHistory(path.join(DATA_DIR, 'history', 'stocks.json'), watchlist.stocks, dateStr);
  appendHistory(path.join(DATA_DIR, 'history', 'funds.json'), watchlist.funds, dateStr);

  log('done', dateKey, editionLabel, 'sections:', Object.keys(sections).join('/'));
  return { ok: true, date: dateStr, slot, edition: editionLabel, dateKey, items: Object.values(sections).reduce((n, s) => n + (s.items ? s.items.length : 0), 0) };
}

if (require.main === module) {
  run().then(r => { console.log(JSON.stringify(r)); process.exit(0); }).catch(e => { console.error('[generate] ERROR', e.message); process.exit(1); });
}
module.exports = { run };
