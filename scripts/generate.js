'use strict';
/**
 * 每日前沿简报 · 独立生成脚本（GitHub Actions / 本地均可运行）
 * - 抓取中文新闻源（RSS + JSON API）→ 调用大模型生成八板块简报 → 写入静态 JSON
 * - 输出目录结构（相对 DATA_DIR，默认 site/data）：
 *   digest-latest.json            最新一期
 *   digest-YYYY-MM-DD-HH.json     每期归档（HH=08 晨报 / 21 晚报）
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
 *   workflow 用每 30 分钟轮询触发：到 READY 时刻（晨报 09:00 / 晚报 21:30）后的第一次
 *   轮询就生成该期，出刊时间基本不受 GitHub 延迟影响。
 */

const fs = require('fs');
const path = require('path');

const LLM_BASE = (process.env.LLM_BASE || 'https://api.deepseek.com/v1').replace(/\/$/, '');
const LLM_KEY = process.env.LLM_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'site', 'data'));
const LIMIT = parseInt(process.env.LIMIT || '90', 10) || 90;

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
  // 综合要闻（注意：新浪滚动 2510/2511 实测返回 2024-2025 旧闻，已弃用）
  { url: 'https://news-at.zhihu.com/api/4/news/latest', name: '知乎', type: 'json', tag: 'headlines' },
  { url: 'https://www.chinanews.com.cn/rss/scroll-news.xml', name: '中新网', type: 'rss', tag: 'headlines' },
  // AI · 大模型（国内 + 国外各留专用源，保证"国内外都有"）
  { url: 'https://www.leiphone.com/feed', name: '雷峰网', type: 'rss', tag: 'ai' },                    // 雷峰网（国内，AI 前沿）
  { url: 'https://www.geekpark.net/rss', name: '极客公园', type: 'rss', tag: 'ai' },                     // 极客公园（国内，AI 应用）
  { url: 'https://www.qbitai.com/feed', name: '量子位', type: 'rss', tag: 'ai' },                      // 量子位（国内，AI 垂直）
  { url: 'https://techcrunch.com/category/artificial-intelligence/feed/', name: 'TechCrunch', type: 'rss', tag: 'ai' }, // TechCrunch AI（国外，AI 专属）
  // 科技硬核（国内外重大事件：新硬件发布 / 航天 / 汽车 / 芯片 / 机器人）
  { url: 'https://www.ithome.com/rss/', name: 'IT之家', type: 'rss', tag: 'tech' },
  { url: 'https://www.36kr.com/feed', name: '36氪', type: 'rss', tag: 'tech' },
  { url: 'https://www.ifanr.com/feed', name: '爱范儿', type: 'rss', tag: 'tech' },
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2516&num=30', name: '新浪', type: 'json', tag: 'tech' },
  { url: 'https://hnrss.org/frontpage', name: 'Hacker News', type: 'rss', tag: 'tech' },                    // Hacker News（国外）
  { url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', name: 'Ars Technica', type: 'rss', tag: 'tech' }, // Ars Technica（国外）
  { url: 'https://www.technologyreview.com/feed/', name: 'MIT 科技评论', type: 'rss', tag: 'tech' },
  { url: 'https://www.solidot.org/index.rss', name: '奇客Solidot', type: 'rss', tag: 'tech' },          // MIT 科技评论（国外）
  // 财经 · 市场
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2518&num=30', name: '新浪', type: 'json', tag: 'finance' },
  // 宏观经济
  { url: 'https://api-one.wallstcn.com/apiv1/content/lives?channel=global-channel&limit=30', name: '华尔街见闻', type: 'json', tag: 'economy' },
  { url: 'https://api-one.wallstcn.com/apiv1/content/articles?channel=global&limit=20', name: '华尔街见闻', type: 'json', tag: 'economy' },
  { url: 'https://www.chinanews.com.cn/rss/finance.xml', name: '中新网', type: 'rss', tag: 'economy' },
  // 教育（免费 RSS 大多已死，用垂直媒体 + 教育部官网两个栏目）
  { url: 'https://www.jiemodui.com/rss', name: '芥末堆', type: 'rss', tag: 'education' },
  { url: 'http://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/', name: '教育部', type: 'html', tag: 'education', base: 'http://www.moe.gov.cn/jyb_xwfb/gzdt_gzdt/' },
  { url: 'http://www.moe.gov.cn/jyb_xwfb/s5147/', name: '教育部', type: 'html', tag: 'education', base: 'http://www.moe.gov.cn/jyb_xwfb/s5147/' },
  // 互联网大厂
  { url: 'https://www.tmtpost.com/rss.xml', name: '钛媒体', type: 'rss', tag: 'internet' },
  // 生活 · 消费
  { url: 'https://sspai.com/feed', name: '少数派', type: 'rss', tag: 'life' },
  { url: 'https://feed.mix.sina.com.cn/api/roll/get?pageid=153&lid=2512&num=30', name: '新浪', type: 'json', tag: 'life' }
];

// 每个板块的目标产出条数（写进素材标题，作为模型的即时提醒）
const TAG_TARGET = { headlines: 5, ai: 10, tech: 6, finance: 5, economy: 5, education: 3, internet: 5, life: 3 };

// 每个板块送进模型的素材上限（AI/科技板块要给足，才能支撑"AI 10 条、科技 8 条"）
// 板块素材不足时会自动少送，不会硬凑
const TAG_QUOTA = { ai: 22, tech: 18, headlines: 8, finance: 8, economy: 10, internet: 8, education: 8, life: 6 };

const SITE_NAME = '每日前沿简报';
const SECTIONS = ['headlines', 'ai', 'tech', 'finance', 'economy', 'education', 'internet', 'life'];
const SLOT_MORNING = '08';
const SLOT_EVENING = '21';

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

// 本期覆盖时段（北京时间），两期首尾相接、不留空档：
//   晨报(08)：前一天 21:30 → 当天 09:00（隔夜 + 晚报截稿之后的新闻，09:00~09:30 出刊）
//   晚报(21)：当天 09:00 → 当天 21:30（白天到晚间，21:30~22:00 出刊）
// 晚报 21:30 截稿，之后的消息由次日晨报接住，所以晨报起点取 21:30，避免丢时段。
function slotWindow(dateStr, slot) {
  const p = dateStr.split('-').map(Number);
  const y = p[0], m = p[1], d = p[2];
  if (slot === SLOT_MORNING) {
    return {
      from: Date.UTC(y, m - 1, d - 1, 13, 30, 0), // 前一天 21:30 北京时间
      to: Date.UTC(y, m - 1, d, 1, 0, 0)          // 当天 09:00 北京时间
    };
  }
  return {
    from: Date.UTC(y, m - 1, d, 1, 0, 0),        // 当天 09:00
    to: Date.UTC(y, m - 1, d, 13, 30, 0)         // 当天 21:30
  };
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
function decodeEntities(s) {
  return (s || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#(\d+);/g, (m, n) => { try { return String.fromCharCode(parseInt(n, 10)); } catch (e) { return m; } });
}
function cleanText(s) {
  return decodeEntities((s || '').toString().replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function parsePubMs(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  // 数字时间戳（秒 / 毫秒）：新浪 ctime="1792495780"、华尔街见闻 display_time=1792495979
  if (/^\d{10,13}$/.test(str)) {
    const n = parseInt(str, 10);
    const ms = str.length <= 10 ? n * 1000 : n;
    if (ms > 946684800000) return ms; // 只认 2000 年之后的时间戳
    return null;
  }
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d.getTime();
  } catch (e) {}
  const m1 = str.match(/(\d{4})[年\-\/](\d{1,2})[月\-\/](\d{1,2})/);
  if (m1) {
    const d = new Date(Number(m1[1]), Number(m1[2]) - 1, Number(m1[3]), 0, 0, 0);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  return null;
}

function parsePubDate(raw) {
  const ms = parsePubMs(raw);
  return ms === null ? null : beijingDateStr(new Date(ms));
}

function parseJsonNews(text, tag, defaultSource) {
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
      const source = cleanText(a.source || a.sourceName || a.siteName || (a.global_channel_name || '') || defaultSource || '');
      const pubDateRaw = a.ctime || a.intime || a.display_time || a.pubDate || a.publishedAt ||
        a.publish_time || a.created_at || a.date || '';
      const pubDate = parsePubDate(pubDateRaw);
      const pubAt = parsePubMs(pubDateRaw);
      return { title, url, summary, source, tag, pubDate, pubAt };
    }).filter(m => m.title && m.url && /^https?:/i.test(m.url));
  } catch (e) { return []; }
}

// 政府/机构站点列表页（HTML）解析：抓 <li> 里的「链接 + 标题 + 日期」
function parseHtmlList(html, tag, base, defaultSource) {
  const items = [];
  const hostTitle = cleanText((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  const source = defaultSource || hostTitle.replace(/[-_|].*$/, '').trim() || '官网';
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
    items.push({ title, url: href, summary: '', source, tag, pubDate: d ? d[1] : null, pubAt: parsePubMs(d ? d[1] : null) });
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
    if (source.type === 'json') items = parseJsonNews(text, source.tag, source.name);
    else if (source.type === 'html') items = parseHtmlList(text, source.tag, source.base || source.url, source.name);
    else items = parseRss(text, source.tag, source.name);
    log('source ok', source.url, items.length);
    return items;
  } catch (e) {
    log('source failed', source.url, e.message);
    return [];
  }
}

function parseRss(xml, tag, defaultSource) {
  const items = [];
  const channelTitle = (xml.match(/<channel>[\s\S]*?<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const channelSource = defaultSource || cleanText(channelTitle).split(/[|｜]/)[0].trim();
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
    const pubAt = parsePubMs(pubDateRaw);
    if (title && link) items.push({ title, url: link, summary: desc.slice(0, 300), source: channelSource, tag, pubDate, pubAt });
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

// 关键词补充：某些板块的专属源太少（如教育），从其他板块素材里按关键词补一份候选
const TAG_KEYWORDS = {
  ai: /(大模型|大语言|智能体|Agent|AIGC|生成式|GPT|Claude|Gemini|Llama|Qwen|DeepSeek|多模态|推理模型|具身智能|AI芯片|算力)/i,
  education: /(教育|高考|中考|高校|大学|学生|招生|开学|教师|校园|留学|升学|课程|双减)/,
  economy: /(CPI|PPI|PMI|GDP|央行|降息|加息|关税|进出口|社融|财政|就业|失业|物价)/,
  finance: /(涨停|跌停|指数|基金|黄金|汇率|金价|油价|A股|港股|美股|债券)/,
  internet: /(微信|抖音|淘宝|京东|拼多多|美团|字节|小红书|B站|腾讯|阿里|Meta|Google|亚马逊|TikTok)/
};
function enrichMaterial(material, perTag) {
  const cap = perTag || 6;
  const extra = [];
  for (const tag of Object.keys(TAG_KEYWORDS)) {
    const re = TAG_KEYWORDS[tag];
    let n = 0;
    for (const m of material) {
      if (n >= cap) break;
      if (m.tag === tag) continue;
      if (re.test(m.title) || re.test(m.summary || '')) {
        extra.push(Object.assign({}, m, { tag: tag, derived: true }));
        n += 1;
      }
    }
  }
  return material.concat(extra);
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
    const tgt = TAG_TARGET[tag] || 3;
    const hint = g.length >= tgt ? ('→ 本板块必须产出 ' + tgt + ' 条') : ('→ 目标 ' + tgt + ' 条，但候选只有 ' + g.length + ' 条，按实际素材写，不要编造');
    parts.push('\n===== 【' + (TAG_LABELS[tag] || tag) + '】候选素材 ' + g.length + ' 条 ' + hint + ' =====');
    for (const m of g) {
      n += 1;
      const marks = (m.pubDate ? '' : ' [无日期]') + (m.derived ? ' [跨板块补充]' : '');
      parts.push(n + '. [' + m.title + '](' + m.url + ')  来源:' + (m.source || '未知') + marks);
      if (m.summary) parts.push('   ' + m.summary);
    }
  }
  return parts.join('\n');
}

// ---- 结果后处理：跨板块去重（模型偶尔会把同一事件同时写进两个板块）----
function normalizeTitle(s) {
  return (s || '').replace(/[\s，。、；：""''（）()【】\[\]「」《》!！?？—\-·|/:：]/g, '');
}
// 两个标题是否共享 >= n 个连续汉字（用于判断是否同一事件）
function shareLongPhrase(a, b, n) {
  if (a.length < n || b.length < n) return false;
  for (let i = 0; i + n <= a.length; i++) {
    if (b.indexOf(a.slice(i, i + n)) >= 0) return true;
  }
  return false;
}
// 按 SECTIONS 顺序（越靠前越重要）保留首次出现，后面板块的重复条目删掉
function dedupeSections(sections, minPhrase) {
  const n = minPhrase || 6;
  const seen = [];
  const removed = [];
  for (const sec of SECTIONS) {
    const s = sections[sec];
    if (!s || !Array.isArray(s.items)) continue;
    s.items = s.items.filter(it => {
      const t = normalizeTitle(it.title);
      const dup = seen.find(k => (k.url && it.url && k.url === it.url) ||
        (t.length >= n && k.t.length >= n && shareLongPhrase(t, k.t, n)));
      if (dup) { removed.push({ section: sec, title: it.title, sameAs: dup.section }); return false; }
      seen.push({ url: it.url, t, section: sec });
      return true;
    });
  }
  return removed;
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
    + 'B2. 素材标注 [无日期] 的，仅在确实重要时使用，且不要写成"今天刚发生"；标注 [跨板块补充] 的是为补足该板块候选而从别处借来的，若它其实更属于别的板块就忽略它。\n'
    + 'C. 绝不编造。素材里没有的模型名、数字、公司动作不许写；url 必须来自素材。\n'
    + 'D. 条数是硬指标：每个板块都要写到目标条数。1级标准的不够时，按该板块给出的「补充顺序」从**本板块**候选素材里继续挑，直到凑满；只有该板块素材总数确实不够时才少写。\n'
    + '\n【写作风格】\n'
    + '1. title 不要照抄原标题，改写成一句大白话（20-28 字），一眼看懂谁做了什么。\n'
    + '2. summary 固定两句话：第一句讲「发生了什么」（把关键数字、型号、公司写清楚）；第二句以「看点：」开头，说明为什么值得花 30 秒看（对普通人的影响 / 背后的趋势）。\n'
    + '3. source 用素材里的真实媒体名；url 必须用素材里的真实链接，不许自己拼。\n'
    + '4. tag 为 2-6 字口语标签（如「新模型」「降息」「发射成功」「新机发布」）。\n'
    + '\n【模块模板（严格按此执行，含目标条数、1级标准与补充顺序）】\n'
    + '■ ai（AI·大模型动态）— 必须 10 条\n'
    + '  1级（应占多数，≥6 条）：大模型发布/新版本/新能力、AI 智能体(Agent)发布或升级、AI 产品功能正式上线或重大升级（编程/视频/绘图/办公/搜索/助手）、大模型训练推理的算力与芯片突破。\n'
    + '  补充顺序（用于补满）：①AI 公司重大融资与估值 ②AI 芯片与算力基础设施 ③AI 安全与监管 ④具身智能/机器人 AI 进展。\n'
    + '  不收：纯观点评论、教程、评测、招聘、旧闻回顾、与 AI 无关的科技新闻。\n'
    + '  国内外都要有：国外（OpenAI/Anthropic/Google/Meta/xAI/NVIDIA/微软/Mistral/亚马逊/Tenstorrent 等）≥3 条；国内（阿里/字节/腾讯/百度/DeepSeek/月之暗面/MiniMax/智谱/商汤/上海 AI Lab 等）≥4 条。\n'
    + '  排序：重磅新模型 > 智能体/产品升级 > 算力芯片 > 融资/安全。\n'
    + '■ tech（科技硬核）— 目标 6 条（最低 3 条，宁少勿滥）\n'
    + '  1级：旗舰硬件/新品类正式发布（苹果、华为、三星等）、航天与火箭（发射/回收/载人）、汽车突破（飞行汽车、自动驾驶、新车型量产）、芯片新架构/新制程、机器人、能源与材料突破。\n'
    + '  补充顺序（用于补满）：①重大基础设施投产/下线 ②重要开源项目或软件大版本发布 ③通信与网络重大进展 ④国家级科技工程节点。\n'
    + '  不收：开售预告与定档、颜色/存储版本、参数曝光、跑分对比、折痕/发热等细节八卦、优惠促销、配件周边、未证实的供应链传闻。\n'
    + '  严禁凑数：灯泡/耳机/NAS/路由器/游戏上架/软件小版本这类常规商品动态一律不要，即使因此不足 6 条也可以只写 3-4 条。\n'
    + '  判断标准：这条能不能上科技媒体头条？不能就换候选里更重要的；候选里没有就不写。\n'
    + '  国内外都要有：国外 ≥3 条、国内 ≥3 条。\n'
    + '■ headlines（今日必读）— 必须 5 条\n'
    + '  当天最重要的综合要闻（政策、国际大事、经济数据、社会重大事件）。不收产品发布（那属于 ai/tech）。\n'
    + '■ finance（财经·市场）— 必须 5 条\n'
    + '  当日重要变动：A股/港股/美股、基金、黄金、外汇、大宗商品，必须带具体数字或涨跌幅与原因。\n'
    + '■ economy（宏观经济）— 必须 5 条\n'
    + '  宏观政策、经济数据（CPI/PMI/就业/GDP）、央行操作、国际贸易与关税；国内与国外尽量各半。\n'
    + '■ education（教育）— 目标 3 条（素材确实不足时可为 2 条）\n'
    + '  教育政策、升学考试、校园重大事件、教育科技/AI 教育落地、教育行业重要动态。\n'
    + '■ internet（互联网大厂）— 必须 5 条\n'
    + '  国内外互联网大厂动态：新业务/新功能发布、组织与竞争格局、平台规则、监管处罚；电商/社交/短视频/App。\n'
    + '■ life（生活·消费）— 必须 3 条\n'
    + '  与钱包和日常直接相关：民生、消费趋势、物价、健康、出行变化。\n'
    + '\n【去重】同一事件全简报只能出现一次；同一发布会拆成多条时，只保留信息量最大的 1 条，并优先放在它最该在的板块。\n'
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

  return await llmRequest(sys, user, 0.5);
}

// 单期 token 用量统计（用于核对花费）
const USAGE = { calls: 0, prompt: 0, completion: 0 };
function resetUsage() { USAGE.calls = 0; USAGE.prompt = 0; USAGE.completion = 0; }
function usageLine() {
  const cost = USAGE.prompt * 2 / 1e6 + USAGE.completion * 8 / 1e6; // deepseek-chat 参考价：输入2元/百万，输出8元/百万
  return 'calls=' + USAGE.calls + ' prompt=' + USAGE.prompt + ' completion=' + USAGE.completion +
    ' 估算≈¥' + cost.toFixed(4);
}
// 通用大模型请求（JSON 模式优先，失败回退普通模式）
async function llmRequest(sys, user, temperature) {
  const base = {
    model: LLM_MODEL,
    messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
    temperature: temperature === undefined ? 0.5 : temperature
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
    if (data.usage) { USAGE.prompt += data.usage.prompt_tokens || 0; USAGE.completion += data.usage.completion_tokens || 0; }
    USAGE.calls += 1;
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

// 补稿：某板块条数未达目标时，用该板块剩余的候选素材再要一轮，只补缺额
async function topUpSections(sections, material) {
  const usedUrls = new Set();
  for (const s of SECTIONS) {
    for (const it of ((sections[s] && sections[s].items) || [])) {
      if (it.url) usedUrls.add(it.url);
      if (it.title) usedUrls.add('T:' + normalizeTitle(it.title));
    }
  }
  const blocks = [];
  const needs = [];
  // 已出现过的标题：补稿时不能再挑同一事件（否则补上又被去重删掉，条数永远差一条）
  const existingTitles = [];
  for (const s of SECTIONS) {
    for (const it of ((sections[s] && sections[s].items) || [])) {
      if (it.title) existingTitles.push(normalizeTitle(it.title));
    }
  }
  for (const s of SECTIONS) {
    const target = TAG_TARGET[s] || 3;
    const have = (sections[s] && sections[s].items ? sections[s].items.length : 0);
    if (have >= target) continue;
    const candidates = material.filter(m => {
      if (m.tag !== s) return false;
      if (usedUrls.has(m.url)) return false;
      const t = normalizeTitle(m.title);
      if (usedUrls.has('T:' + t)) return false;
      if (existingTitles.some(x => x.length >= 6 && t.length >= 6 && shareLongPhrase(t, x, 6))) return false;
      return true;
    });
    if (!candidates.length) { log('topup: no candidate left for', s); continue; }
    needs.push({ section: s, need: target - have });
    blocks.push('【' + (TAG_LABELS[s] || s) + '】还需 ' + (target - have) + ' 条，候选素材：');
    candidates.slice(0, 15).forEach((m, i) => {
      blocks.push((i + 1) + '. [' + m.title + '](' + m.url + ')  来源:' + (m.source || '未知'));
      if (m.summary) blocks.push('   ' + m.summary);
    });
  }
  if (!needs.length) return null;

  const sys2 = '你是简报补稿编辑。只输出一个 JSON 对象：'
    + '{"sections":{"<板块key>":{"label":"","items":[{"title":"","summary":"","source":"","url":"","tag":""}]}}}。'
    + '规则：①每条 title 改写成大白话（20-28 字）；②summary 两句——「发生了什么」+「看点：为什么值得看」；'
    + '③url 必须原样取自给定候选，不许自己拼；④不许编造候选里没有的公司/数字；⑤同一事件不要重复写；'
    + '⑥板块 key 用我给出的英文 key（如 ai、tech、finance、economy、education、internet、life、headlines）；'
    + '⑦按每个板块要求的「还需 N 条」如数补齐，不要多写。';
  const user2 = '以下板块条数不足，请补齐。\n\n' + blocks.join('\n');

  const extra = await llmRequest(sys2, user2, 0.4);
  const added = {};
  const ex = (extra && extra.sections) || {};
  for (const need of needs) {
    const src = ex[need.section];
    if (!src || !Array.isArray(src.items)) continue;
    if (!sections[need.section]) sections[need.section] = { label: TAG_LABELS[need.section] || need.section, items: [] };
    const got = src.items.filter(it => it && it.title && it.url).slice(0, need.need);
    sections[need.section].items = sections[need.section].items.concat(got);
    added[need.section] = got.length;
  }
  return added;
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
// 出刊目标（2026-10-29 调整）：晨报 09:30 前可见，晚报 22:00 前可见。
// workflow 已改为每 30 分钟轮询触发，到 READY 时间后的第一次轮询即生成该期，
// 因此无论 GitHub schedule 延迟多久，出刊时间最多比 READY 晚约半个轮询周期。
const MORNING_READY = { h: 9, m: 0 };    // 早于 09:00 不生成当天晨报（预期 09:00~09:30 出刊）
const EVENING_READY = { h: 21, m: 30 };  // 早于 21:30 不生成当天晚报（预期 21:30~22:00 出刊）
const MAX_EDITIONS_PER_RUN = 2;  // 单次运行最多生成几期（控制大模型调用成本）

function pad2(n) { return String(n).padStart(2, '0'); }

// 北京时间「时:分」（分钟级判定到点，因为晚报 READY 定在 21:30）
function beijingHourMinute(d) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: BEIJING_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
  const g = k => { const x = p.find(t => t.type === k); return x ? parseInt(x.value, 10) : 0; };
  return { h: g('hour'), m: g('minute') };
}
// 当前北京时间是否已到 ready（{h,m}）
function isReady(now, ready) {
  const t = beijingHourMinute(now);
  return t.h > ready.h || (t.h === ready.h && t.m >= ready.m);
}

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
  const hm = beijingHourMinute(now);
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
    const slot = isReady(now, EVENING_READY) ? SLOT_EVENING : SLOT_MORNING;
    targets.push({ date: today, slot, reason: '强制重做（FORCE=1）' });
  }

  // ① 今天到点的时段优先（正常情况就是这一期；到点 = 北京时间过 READY 时刻）
  if (isReady(now, MORNING_READY)) add(today, SLOT_MORNING, '今日晨报');
  if (isReady(now, EVENING_READY)) add(today, SLOT_EVENING, '今日晚报');
  // ② 昨天晚报缺口（典型场景：轮询任务延迟跨夜才跑，会被这里捡回来）
  add(yesterday, SLOT_EVENING, '补昨天晚报（定时延迟跨夜）');
  // ③ 昨天晨报也缺 → 只在上半天补，避免整天的缺口一直漏下去
  if (!isReady(now, EVENING_READY)) add(yesterday, SLOT_MORNING, '补昨天晨报（缺口自愈）');

  return { today, hour: hm.h, minute: hm.m, targets };
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

  resetUsage();
  log('start', dateKey, '(' + editionLabel + ')' + (isToday ? '' : ' [回补]'));

  // 1) 抓取素材
  const sources = await Promise.all(NEWS_SOURCES.map(fetchSource));
  let material = sources.flat().filter(m => m.title && m.url);
  const seen = new Set();
  material = material.filter(m => { const k = m.url; if (seen.has(k)) return false; seen.add(k); return true; });

  // 只保留「本期覆盖时段」内发布的新闻：
  //   晨报 08 → 前一天 21:30 ~ 当天 09:00（隔夜，09:00~09:30 出刊）
  //   晚报 21 → 当天 09:00 ~ 当天 21:30（白天到晚间，21:30~22:00 出刊）
  // 无时间戳的素材（如知乎热榜）只在要闻板块保留，其余板块丢弃，避免旧闻混入
  const win = slotWindow(dateStr, slot);
  const beforeFilter = material.length;
  material = material.filter(m => {
    if (!m.pubAt) return m.tag === 'headlines';
    return m.pubAt >= win.from && m.pubAt < win.to;
  });
  log('window filter: ' + beijingISO(new Date(win.from)) + ' ~ ' + beijingISO(new Date(win.to)),
    'kept', material.length, '/', beforeFilter);
  if (material.length === 0) throw new Error('no news material inside window ' + beijingISO(new Date(win.from)) + ' ~ ' + beijingISO(new Date(win.to)));

  // 关键词补充：教育/AI 等专属源偏少的板块，从其他板块按关键词补候选（文本里标 [跨板块补充]）
  const beforeEnrich = material.length;
  material = enrichMaterial(material, 6);
  if (material.length > beforeEnrich) log('keyword enrich: +', material.length - beforeEnrich, 'candidates');

  // 打乱顺序，避免取前 N 条全是同一来源
  material = shuffle(material);

  // ★ 按板块配额取样：小板块（教育/互联网）素材天然少，整体打乱后截断就会长期空着，
  //   所以改成「每板块按 TAG_QUOTA 取足，再余量轮转补足」。
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
  // 后处理：跨板块去重（同一事件只保留最靠前板块的那一条）
  const dupRemoved = dedupeSections(sections);
  if (dupRemoved.length) {
    log('dedupe: removed', dupRemoved.length, dupRemoved.map(d => d.section + '←' + d.sameAs + ':' + d.title.slice(0, 16)).join(' | '));
  }

  // 补稿：未达目标条数的板块，用剩余候选再要一轮（失败不影响主流程，最多两轮）
  for (let round = 1; round <= 1; round++) {
    try {
      const added = await topUpSections(sections, material);
      const totalAdded = added ? Object.values(added).reduce((a, b) => a + b, 0) : 0;
      if (!added || !totalAdded) break;
      const dup2 = dedupeSections(sections);
      log('topup round', round, 'added:', JSON.stringify(added), dup2.length ? ('dedupe removed: ' + dup2.length) : '');
    } catch (e) {
      log('topup failed (ignore):', e.message);
      break;
    }
  }

  // 3) 组装 digest
  const watchlist = await fetchWatchlist();
  const digest = Object.assign({
    date: dateStr,
    slot: slot,
    edition: editionLabel,
    updatedAt: beijingISO(now),
    coverage: { from: beijingISO(new Date(win.from)), to: beijingISO(new Date(win.to)) },
    siteName: SITE_NAME,
    sections,
    watchlist
  }, isToday ? {} : { backfilled: true });

  // 4) 写文件
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // digest-latest.json（首页默认展示）：只有当本期比现有 latest 更新时才覆盖，
  // 避免"回补昨天的晚报"把首页改成旧一期
  const latestFile = path.join(DATA_DIR, 'digest-latest.json');
  const curLatest = loadJSON(latestFile);
  const keyNew = dateStr + '-' + slot;
  const keyCur = curLatest ? (curLatest.date + '-' + curLatest.slot) : '';
  if (!curLatest || keyNew >= keyCur) {
    saveJSON(latestFile, digest);
  } else {
    log('latest 保持不变（本期 ' + keyNew + ' 为回补，现有 latest=' + keyCur + '）');
  }
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

  const secCounts = {};
  for (const s of SECTIONS) secCounts[s] = (sections[s] && sections[s].items ? sections[s].items.length : 0);
  log('done', dateKey, editionLabel, '条数:', JSON.stringify(secCounts));
  log('llm 用量:', usageLine());
  const shortSecs = SECTIONS.filter(s => secCounts[s] < (TAG_TARGET[s] || 3));
  if (shortSecs.length) log('WARN 未达目标条数的板块:', shortSecs.map(s => s + '(' + secCounts[s] + '/' + (TAG_TARGET[s] || 3) + ')').join(', '));
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
  const targets = plan.targets;
  log('plan', today, 'time=' + pad2(plan.hour) + ':' + pad2(plan.minute), 'targets=' + (targets.map(t => t.date + '-' + t.slot).join(',') || 'none(已齐，无需生成)'));
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
module.exports = { runEdition, runPlan, runTopup, planTargets, shiftDate, beijingDateStr, beijingHour, buildMaterialText, balancedSample, parsePubDate, parsePubMs, parseJsonNews, parseRss, dedupeSections, slotWindow };
