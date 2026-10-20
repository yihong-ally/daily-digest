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
 *   MODE       normal（默认）=延迟感知+缺口自愈；topup=强制扫描昨天+今天四个时段补齐
 *   FORCE      设为 1 时忽略"已生成则跳过"，强制重做当期
 *   PUSHPLUS_TOKEN  有值时生成成功后推一条摘要到微信（失败不影响生成）
 *
 * 调度说明（重要）：
 *   GitHub Actions 的 schedule 实际触发时间可能比 cron 设定晚数小时，跨过午夜后
 *   "按当前钟点判断晨报/晚报"会把晚报写成第二天的晨报。因此本脚本不再按时钟推断版次，
 *   而是先规划该补哪几期（当天到点的时段优先，其次回补昨天的缺口），再逐期生成。
 *   结果：定时延迟只会让某期晚出，不会再出现"晚报永久缺失 + 晨报凌晨发布"。
 */

const fs = require('fs');
const path = require('path');

const LLM_BASE = (process.env.LLM_BASE || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const LLM_KEY = process.env.LLM_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'site', 'data'));
const LIMIT = parseInt(process.env.LIMIT || '120', 10) || 120;

// watchlist 默认值（随脚本打包，实时行情获取失败时回退用）
const WATCHLIST_DEFAULT = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'watchlist.default.json'), 'utf8'));
  } catch (e) { return { stocks: [], funds: [] }; }
})();

// ---- 新闻源（多源容错：某源失效只记日志，不影响整体）----
// 2026-10-20 实测调整：删掉 3 个已失效源（澎湃 RSS 已返回 HTML、虎嗅 RSS 稳定超时、新浪教育 lid=2523 空响应），
// 补上已验证可用的源：AI 前沿（雷峰网）、英文前沿（Hacker News）、宏观财经（华尔街见闻快讯 / 中新网财经）、
// 互联网商业（钛媒体）、教育（芥末堆 + 教育部官网列表页，后者是 HTML 需专用解析）。
const FETCH_TIMEOUT = 15000;
const LLM_TIMEOUT = 90000;
const NEWS_SOURCES = [
  // 综合要闻
  { url: 'https://news-at.zhihu.com/api/4/news/latest', type: 'json', tag: 'headlines' },
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2511&num=30', type: 'json', tag: 'headlines' },
  // AI · 大模型（国内 + 国外各留专用源，保证"国内外都有"）
  { url: 'https://www.leiphone.com/feed', type: 'rss', tag: 'ai' },                    // 雷峰网（国内，AI 前沿）
  { url: 'https://www.geekpark.net/rss', type: 'rss', tag: 'ai' },                     // 极客公园（国内，AI 应用）
  { url: 'https://www.qbitai.com/feed', type: 'rss', tag: 'ai' },                      // 量子位（国内，AI 垂直）
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', type: 'rss', tag: 'ai' }, // TechCrunch AI（国外，AI 专属）
  { url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', type: 'rss', tag: 'ai' }, // The Verge AI（国外）
  // 科技硬核（国内外重大事件：新硬件发布 / 航天 / 汽车 / 芯片 / 机器人）
  { url: 'https://www.ithome.com/rss/', type: 'rss', tag: 'tech' },
  { url: 'https://www.36kr.com/feed', type: 'rss', tag: 'tech' },
  { url: 'https://www.ifanr.com/feed', type: 'rss', tag: 'tech' },
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=30', type: 'json', tag: 'tech' },
  { url: 'https://hnrss.org/frontpage', type: 'rss', tag: 'tech' },                    // Hacker News（国外）
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', type: 'rss', tag: 'tech' }, // Ars Technica（国外）
  { url: 'https://www.technologyreview.com/feed/', type: 'rss', tag: 'tech' },          // MIT 科技评论（国外）
  // 财经 · 市场
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2518&num=30', type: 'json', tag: 'finance' },
  // 宏观经济
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2510&num=30', type: 'json', tag: 'economy' },
  { url: 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30', type: 'json', tag: 'economy' },
  { url: 'https://api-one.wallstcn.com/apiv1/content/articles?channel=global&limit=20', type: 'json', tag: 'economy' },
  { url: 'https://www.chinanews.com.cn/rss/finance.xml', type: 'rss', tag: 'economy' },
  // 教育（免费 RSS 大多已死，用垂直媒体 + 教育部官网）
  { url: 'https://www.jiemodui.com/rss', type: 'rss', tag: 'education' },
  { url: 'http://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/', type: 'html', tag: 'education', base: 'http://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/' },
  // 互联网大厂
  { url: 'https://www.tmtpost.com/rss.xml', type: 'rss', tag: 'internet' },
  // 生活 · 消费
  { url: 'https://sspai.com/feed', type: 'rss', tag: 'life' },
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2512&num=30', type: 'json', tag: 'life' }
];

// 每个板块送进模型的素材上限（AI/科技板块要给足，才能支撑"AI 10 条、科技 8 条"）
// 板块素材不足时会自动少送，不会硬凑
const TAG_QUOTA = { ai: 26, tech: 24, headlines: 10, finance: 12, economy: 14, internet: 10, education: 8, life: 8 };

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
  // 数字时间戳（秒 / 毫秒）：新浪 ctime="1792495780"、华尔街见闻 display_time=1792495979
  const str = String(raw).trim();
  if (/^\d{10,13}$/.test(str)) {
    const n = parseInt(str, 10);
    const ms = str.length <= 10 ? n * 1000 : n;
    const d = new Date(ms);
    if (!isNaN(d.getTime()) && d.getFullYear() > 2000) return beijingDateStr(d);
  }
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return beijingDateStr(d);
  } catch (e) {}
  const m1 = str.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
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
    else if (data.data) {                                  // 华尔街见闻等：{data:{items:[...]}}
      for (const k of ['data', 'items', 'lives', 'articles', 'list', 'roll_data']) {
        if (Array.isArray(data.data[k])) { list = data.data[k]; break; }
      }
    }
    return list.map(a => {
      const title = cleanText(a.title || a.highlight_title || a.name || a.content_short || '').slice(0, 120);
      const url = cleanText(a.url || a.share_url || a.link || a.uri || a.content_more_uri || '');
      const summary = cleanText(
        a.intro || a.description || a.summary || a.content_text || a.content_short || a.content || a.hint || ''
      ).slice(0, 300);
      const source = cleanText(a.source || a.sourceName || a.siteName || (a.global_channel_name || '') || '');
      const pubDateRaw = a.ctime || a.intime || a.display_time || a.pubDate || a.publishedAt ||
        a.publish_time || a.created_at || a.date || '';
      const pubDate = parsePubDate(pubDateRaw);
      return { title, url, summary, source, tag, pubDate };
    }).filter(m => m.title && m.url && /^https?:/i.test(m.url));
  } catch (e) { return []; }
}

// 政府/机构站点列表页（HTML）解析：抓 <li> 里的「链接 + 标题 + 日期」
function parseHtmlList(html, tag, base) {
  const items = [];
  const hostTitle = cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const source = hostTitle.replace(/[-_|].*$/, '').trim() || '官网';
  const liRe = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRe.exec(html))) {
    const inner = m[1];
    const a = inner.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const title = cleanText(a[2]);
    if (!title || title.length < 8) continue;
    let href = a[1];
    try { href = new URL(href, base).toString(); } catch (e) { continue; }
    if (!/^https?:/i.test(href)) continue;
    const d = inner.match(/(\d{4}-\d{2}-\d{2})/);
    items.push({ title, url: href, summary: '', source, tag, pubDate: d ? d[1] : null });
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
    let text;
    if (source.type === 'html') {
      // 政府站点编码不统一，UTF-8 解出乱码时回退 GBK
      const buf = await res.arrayBuffer();
      text = new TextDecoder('utf-8').decode(buf);
      if (((text.match(/\uFFFD/g) || []).length) > 50) text = new TextDecoder('gbk').decode(buf);
    } else {
      text = await res.text();
    }
    let items;
    if (source.type === 'json') items = parseJsonNews(text, source.tag);
    else if (source.type === 'html') items = parseHtmlList(text, source.tag, source.base || source.url);
    else items = parseRss(text, source.tag);
    log('source ok', source.url, items.length);
    return items;
  } catch (e) {
    log('source failed', source.url, e.message);
    return [];
  }
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

// ---- 素材取样 ----
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 按板块配额取样：每个板块先按 TAG_QUOTA 取足（不足则全取），剩余名额再在板块间轮转补足
function balancedSample(items, limit) {
  const groups = {};
  for (const it of items) {
    const k = it.tag || 'other';
    (groups[k] = groups[k] || []).push(it);
  }
  const tags = Object.keys(groups);
  if (!tags.length) return [];
  const picked = [];
  const used = {};
  tags.forEach(t => { used[t] = 0; });

  // 第一轮：按板块配额
  for (const t of tags) {
    const cap = TAG_QUOTA[t] || 6;
    const take = Math.min(cap, groups[t].length);
    picked.push.apply(picked, groups[t].slice(0, take));
    used[t] = take;
    if (picked.length >= limit) return picked.slice(0, limit);
  }
  // 第二轮：还有余量就轮转补足
  let progressed = true;
  while (picked.length < limit && progressed) {
    progressed = false;
    for (const t of tags) {
      if (picked.length >= limit) break;
      const next = groups[t][used[t]];
      if (next) { picked.push(next); used[t]++; progressed = true; }
    }
  }
  return picked.slice(0, limit);
}

// 按板块分组的素材文本：让模型清楚「这条素材属于哪个板块」，杜绝跨板块乱搬
const TAG_LABELS = {
  headlines: '今日必读', ai: 'AI·大模型动态', tech: '科技硬核', finance: '财经·市场',
  economy: '宏观经济', education: '教育', internet: '互联网大厂', life: '生活·消费'
};
function buildMaterialText(material) {
  const groups = {};
  for (const m of material) (groups[m.tag] = groups[m.tag] || []).push(m);
  const parts = [];
  let n = 0;
  for (const tag of SECTIONS) {
    const g = groups[tag] || [];
    if (!g.length) continue;
    parts.push('\n===== 【' + (TAG_LABELS[tag] || tag) + '】候选素材（' + g.length + ' 条）=====');
    for (const m of g) {
      n += 1;
      parts.push(n + '. [' + m.title + '](' + m.url + ')  来源:' + (m.source || '未知'));
      if (m.summary) parts.push('   ' + m.summary);
    }
  }
  return parts.join('\n');
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
  const sys = '你是一位帮用户筛选「今天值得看」的多领域资讯编辑，产出结构化的每日简报。严格按下面的「模块模板」写作。\n'
    + '\n【最重要的三条铁律】\n'
    + 'A. 素材已按板块分组标注（见【XX 板块候选素材】）。每个板块只能从它自己那组素材里挑，不得跨组搬运；若发现素材明显归错组（例如 AI 专属素材混进科技组），可以调整，但必须确实属于目标板块。\n'
    + 'B. 只写「今天发生的、具体的、新的事件」。凡是回顾、盘点、教程、评测、榜单、周年纪念、营销软文、纯观点评论，一律不要。素材里出现旧新闻（标题含往年/往月、明显不是今天）也不要。\n'
    + 'C. 绝不编造。素材里没有的模型名、数字、公司动作不许写；某板块符合标准的素材不够，就少写，不要拿凑数的垃圾填满。\n'
    + '\n【写作风格】\n'
    + '1. title 不要照抄原标题，改写成一句大白话（20-28 字），一眼看懂谁做了什么。\n'
    + '2. summary 固定两句话：第一句讲「发生了什么」（把关键数字、型号、公司写清楚）；第二句以「看点：」开头，说明为什么值得花 30 秒看（对普通人的影响 / 背后的趋势）。\n'
    + '3. source 用素材里的真实媒体名；url 必须用素材里的真实链接，不许自己拼。\n'
    + '4. tag 为 2-6 字口语标签（如「新模型」「降息」「发射成功」「新机发布」）。\n'
    + '\n【模块模板（严格按此执行）】\n'
    + '■ ai（AI·大模型动态）— 目标 10 条\n'
    + '  只收：①大模型发布/新版本/新能力（如某公司发布 X 模型、上下文扩容、多模态升级）；②AI 智能体（Agent）发布或升级；③AI 产品/功能正式上线或重大升级（编程、视频、绘图、办公、搜索等）；④与大模型直接相关的算力/训练突破（如新芯片用于大模型训练）。\n'
    + '  不收：融资八卦（除非同时伴随重大发布）、人事变动、法律纠纷、政策监管、纯观点评论、教程、评测、招聘。\n'
    + '  国内外都要有：至少 3 条国外（OpenAI / Anthropic / Google / Meta / xAI / NVIDIA / 微软 / Mistral 等），至少 4 条国内（阿里 / 字节 / 腾讯 / 百度 / DeepSeek / 月之暗面 / MiniMax / 智谱 / 商汤等）。\n'
    + '  按重要性排序：重磅新模型 > 智能体/产品升级 > 算力突破。\n'
    + '■ tech（科技硬核）— 目标 8 条\n'
    + '  只收：国内外重大科技事件——新硬件/旗舰产品发布（苹果、华为、三星等）、航天与火箭、汽车（飞行汽车、自动驾驶、新车型重大突破）、芯片与半导体、机器人、能源与材料突破。\n'
    + '  不收：小版本更新、配件与周边、优惠促销、跑分对比、供应链传闻（除非官方确认）。\n'
    + '  国内外都要有：至少 3 条国外、至少 3 条国内。\n'
    + '■ headlines（今日必读）— 目标 5 条\n'
    + '  只收：当天最重要的综合要闻（政策、国际大事、经济数据、社会重大事件）。不收产品发布（那属于 ai/tech）。\n'
    + '■ finance（财经·市场）— 目标 5 条\n'
    + '  只收：A股/港股/美股行情、基金、黄金、外汇、大宗商品的当日重要变动，必须带具体数字或涨跌幅与原因。\n'
    + '■ economy（宏观经济）— 目标 5 条\n'
    + '  只收：宏观政策、经济数据（CPI/PMI/就业/GDP）、央行操作、国际贸易与关税，国内与国外各半。\n'
    + '■ education（教育）— 目标 3 条\n'
    + '  只收：教育政策、升学考试、校园重大事件、教育科技/AI 教育落地。没有符合条件的就只写 1-2 条。\n'
    + '■ internet（互联网大厂）— 目标 5 条\n'
    + '  只收：国内外互联网大厂动态（新业务/新功能发布、组织与竞争格局、平台规则、监管处罚），电商/社交/短视频/App。\n'
    + '■ life（生活·消费）— 目标 3 条\n'
    + '  只收：与钱包和日常直接相关的民生、消费趋势、物价、健康、出行变化。\n'
    + '\n【去重】同一事件全简报只能出现一次；同一发布会拆成多条时，只保留信息量最大的 1 条。\n'
    + '\n【输出格式】只输出一个 JSON 对象，不要任何解释文字：\n'
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
    + '}';

  const user = '以下是今日（'
    + new Date().toLocaleDateString('zh-CN')
    + '）的素材，已按板块分组。请只从对应板块的素材里挑选，按模块模板生成简报：\n'
    + buildMaterialText(material);

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

// ---- 时段判定与缺口自愈 ----
// GitHub Actions 的 schedule 实际触发时间会晚于 cron 设定（实测有延迟数小时的情况）。
// 若仍按「现在几点 → 算晨报还是晚报」，18:00 的晚报任务一旦漂过午夜就会被写成「第二天的晨报」，
// 于是前一天的晚报永久缺失。现在改成：先规划「该补哪几期」，再由调用方逐期生成，与当前钟点无关。
const MORNING_READY_HOUR = 6;    // 早于 6 点不生成当天晨报（避免凌晨就产出"晨报"）
const EVENING_READY_HOUR = 14;   // 早于 14 点不生成当天晚报
const MAX_EDITIONS_PER_RUN = 2;  // 单次运行最多生成几期（控制大模型调用成本）

function pad2(n) { return String(n).padStart(2, '0'); }

// 按天平移（以 UTC 计算，避开本地时区/夏令时干扰）
function shiftDate(dateStr, days) {
  const parts = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
  t.setUTCDate(t.getUTCDate() + days);
  return t.getUTCFullYear() + '-' + pad2(t.getUTCMonth() + 1) + '-' + pad2(t.getUTCDate());
}

function editionFile(dateStr, slot) {
  return path.join(DATA_DIR, 'digest-' + dateStr + '-' + slot + '.json');
}

function editionExists(dateStr, slot) {
  return !!loadJSON(editionFile(dateStr, slot));
}

// 规划本次运行要生成哪几期：先补「昨天晚报」缺口，再补到点的当天时段
function planTargets(now, opts) {
  opts = opts || {};
  const today = beijingDateStr(now);
  const hour = beijingHour(now);
  const yesterday = shiftDate(today, -1);
  const targets = [];
  const add = (dateStr, slot, reason) => {
    if (targets.length >= MAX_EDITIONS_PER_RUN) return;
    if (targets.some(t => t.date === dateStr && t.slot === slot)) return;
    if (editionExists(dateStr, slot)) return;
    targets.push({ date: dateStr, slot, reason });
  };

  // ⓿ 强制模式（FORCE=1）：把当前该出的一期直接排到最前面，忽略"已存在"
  if (opts.force) {
    const slot = hour >= EVENING_READY_HOUR ? SLOT_EVENING : SLOT_MORNING;
    targets.push({ date: today, slot, reason: '强制重做（FORCE=1）' });
  }

  // ① 今天到点的时段优先（正常情况就是这一期）
  if (hour >= MORNING_READY_HOUR) add(today, SLOT_MORNING, '今日晨报');
  if (hour >= EVENING_READY_HOUR) add(today, SLOT_EVENING, '今日晚报');
  // ② 昨天晚报缺口（典型场景：18:00 的任务延迟到次日凌晨才跑，会被这里捡回来）
  add(yesterday, SLOT_EVENING, '补昨天晚报（定时延迟跨夜）');
  // ③ 昨天晨报也缺 → 只在上半天补，避免整天的缺口一直漏下去
  if (hour < EVENING_READY_HOUR) add(yesterday, SLOT_MORNING, '补昨天晨报（缺口自愈）');

  return { today, hour, targets };
}

// ---- 生成一期（日期与版次由调用方指定，不再按当前钟点推断）----
async function runEdition(dateStr, slot, opts) {
  opts = opts || {};
  const force = opts.force !== undefined ? opts.force : !!process.env.FORCE;
  const now = new Date();
  const dateKey = dateStr + '-' + slot;
  const editionLabel = slot === SLOT_MORNING ? '晨报' : '晚报';
  const isToday = dateStr === beijingDateStr(now);

  // ★ 已生成则跳过（补跑保险：同一期只生成一次，不重复不覆盖）
  if (!force && editionExists(dateStr, slot)) {
    log('skip: already generated', dateKey);
    return { ok: true, skipped: dateKey, date: dateStr, slot, edition: editionLabel };
  }

  log('start', dateKey, '(' + editionLabel + ')' + (isToday ? '' : ' [回补]'));

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
  material = shuffle(material);

  // ★ 按板块公平取样：小板块（教育/互联网）素材天然少，若整体打乱后截断，它们大概率进不了 60 条，
  //   结果就是这几个板块长期空着。这里改成「每个板块先保底 PER_TAG_MIN 条，再余量轮转补足」。
  const beforeBalance = material.length;
  material = balancedSample(material, LIMIT);
  const byTag = {};
  for (const m of material) byTag[m.tag] = (byTag[m.tag] || 0) + 1;
  log('use', material.length, '/', beforeBalance, 'items for llm | per-tag:', JSON.stringify(byTag));

  // 2) 大模型生成
  const llm = await callLLM(material);
  const sections = llm.sections || {};
  for (const s of SECTIONS) {
    if (!sections[s] || !Array.isArray(sections[s].items)) sections[s] = { label: s, items: [] };
  }

  // 3) 组装 digest
  const watchlist = await fetchWatchlist();
  const digest = Object.assign({
    date: dateStr,
    slot: slot,
    edition: editionLabel,
    updatedAt: beijingISO(now),
    siteName: SITE_NAME,
    sections,
    watchlist
  }, isToday ? {} : { backfilled: true });

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

  // history：只给「今天这期」追加行情（回补历史期时拿到的是当前行情，记到历史日期会失真）
  if (isToday) {
    appendHistory(path.join(DATA_DIR, 'history', 'stocks.json'), watchlist.stocks, dateStr);
    appendHistory(path.join(DATA_DIR, 'history', 'funds.json'), watchlist.funds, dateStr);
  }

  log('done', dateKey, editionLabel, 'sections:', Object.keys(sections).join('/'));
  // 5) 微信推送（失败不影响生成结果）
  await sendPush(digest);
  return { ok: true, date: dateStr, slot, edition: editionLabel, dateKey, items: Object.values(sections).reduce((n, s) => n + (s.items ? s.items.length : 0), 0) };
}

// ---- 微信推送（PushPlus）：生成成功后把简报摘要推到微信 ----
const PUSHPLUS_TOKEN = process.env.PUSHPLUS_TOKEN || '';
const SITE_URL = 'https://yihong-ally.github.io/daily-digest/';

async function sendPush(digest) {
  if (!PUSHPLUS_TOKEN) { log('push: no PUSHPLUS_TOKEN, skip'); return; }
  try {
    const secs = digest.sections || {};
    const lines = [];
    // 各板块取前 2 条
    for (const key of SECTIONS) {
      const sec = secs[key];
      const items = (sec && sec.items) || [];
      if (!items.length) continue;
      const label = sec.label || key;
      lines.push('\n**【' + label + '】**');
      for (const it of items.slice(0, 2)) {
        lines.push('- [' + it.title + '](' + it.url + ')');
      }
    }
    // 行情快照
    const w = digest.watchlist || {};
    const mkLine = (x) => {
      if (!x || !x.name) return '';
      const chg = typeof x.change === 'number' ? ' (' + (x.change > 0 ? '+' : '') + x.change + ')' : '';
      return x.name + ' ' + (x.value != null ? x.value : '') + chg;
    };
    const stockLine = (w.stocks || []).map(mkLine).filter(Boolean).join(' ｜ ');
    const fundLine = (w.funds || []).map(mkLine).filter(Boolean).join(' ｜ ');
    if (stockLine) lines.push('\n**【行情】**\n' + stockLine);
    if (fundLine) lines.push('\n**【基金】**\n' + fundLine);
    lines.push('\n---\n[📖 打开完整简报](' + SITE_URL + ')');

    const title = SITE_NAME + ' · ' + (digest.date || '') + ' ' + (digest.edition || '');
    const body = JSON.stringify({ token: PUSHPLUS_TOKEN, title, content: lines.join('\n'), template: 'markdown' });
    const res = await fetch('https://www.pushplus.plus/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(20000)
    });
    const txt = await res.text();
    let ok = false, msg = txt.slice(0, 120);
    try { const j = JSON.parse(txt); ok = j.code === 200; msg = j.msg || msg; } catch (_) {}
    log('push:', ok ? 'sent' : 'failed', msg);
  } catch (e) {
    log('push error (ignore):', e.message);
  }
}

// ---- 兜底补全：扫描 昨天+今天 的 08/18 四期，缺哪期补哪期 ----
async function runTopup(now) {
  if (!LLM_KEY) throw new Error('LLM_KEY 未配置');
  now = now || new Date();
  const today = beijingDateStr(now);
  const yesterday = shiftDate(today, -1);
  log('topup check', yesterday, '~', today);
  const results = [];
  let generated = 0;
  for (const d of [yesterday, today]) {
    for (const s of [SLOT_MORNING, SLOT_EVENING]) {
      const dateKey = d + '-' + s;
      if (editionExists(d, s)) { results.push({ dateKey, status: 'exists' }); continue; }
      if (generated >= MAX_EDITIONS_PER_RUN) { results.push({ dateKey, status: 'deferred' }); continue; }
      log('topup: missing, generate', dateKey);
      const savedLimit = LIMIT;
      process.env.LIMIT = '45'; // 补全时少取素材，加快速度
      try {
        const r = await runEdition(d, s, { force: false });
        generated++;
        results.push({ dateKey, status: r.skipped ? 'exists' : 'generated', items: r.items });
      } catch (e) {
        log('topup generate failed for', dateKey, e.message);
        results.push({ dateKey, status: 'failed', error: e.message });
      } finally {
        process.env.LIMIT = String(savedLimit);
      }
    }
  }
  return { ok: !results.some(r => r.status === 'failed'), today, results };
}

// ---- 常规运行：按「延迟感知 + 缺口自愈」规划逐期生成 ----
async function runPlan(now) {
  if (!LLM_KEY) throw new Error('LLM_KEY 未配置');
  const plan = planTargets(now || new Date(), { force: !!process.env.FORCE });
  const today = plan.today;
  const hour = plan.hour;
  const targets = plan.targets;
  log('plan', today, 'hour=' + hour, 'targets=' + (targets.map(t => t.date + '-' + t.slot).join(',') || 'none(已齐，无需生成)'));
  const generated = [];
  for (const t of targets) {
    const dateKey = t.date + '-' + t.slot;
    try {
      const r = await runEdition(t.date, t.slot);
      generated.push({ dateKey, reason: t.reason, status: r.skipped ? 'exists' : 'generated', items: r.items });
    } catch (e) {
      log('generate failed', dateKey, e.message);
      generated.push({ dateKey, reason: t.reason, status: 'failed', error: e.message });
    }
  }
  return { ok: !generated.some(g => g.status === 'failed'), date: today, generated };
}

if (require.main === module) {
  const mode = (process.env.MODE || 'normal').toLowerCase();
  const job = mode === 'topup' ? runTopup() : runPlan();
  job.then(r => {
    console.log(JSON.stringify(r));
    process.exit(r.ok === false ? 1 : 0);
  }).catch(e => { console.error('[generate] ERROR', e.message); process.exit(1); });
}
module.exports = { runEdition, runPlan, runTopup, planTargets, shiftDate, beijingDateStr, beijingHour, buildMaterialText, balancedSample, parsePubDate, parseJsonNews };
