/**
 * Cloudflare Worker —— 外部定时器，用于替代不可靠的 GitHub schedule
 *
 * 背景：实测 GitHub 的 schedule 在 2026-10-29 连续 10 小时零触发（配了 6 个触发点全部落空），
 *      而 workflow_dispatch（API 触发）1 分钟内即可启动。所以改由外部按点调 API。
 *
 * 用法：
 *   1) Cloudflare Dashboard → Workers & Pages → Create → Worker → 命名 digest-cron → Deploy
 *   2) Edit code → 全选删除 → 粘贴本文件内容 → Deploy
 *   3) Settings → Variables and Secrets → Add → 类型 Secret
 *        Name: GITHUB_TOKEN   Value: ghp_ 开头的 GitHub token（需 Actions: Read and write）
 *   4) Settings → Triggers → Cron Triggers → Add Cron Trigger → 填 * * * * *（必须「每分钟」）
 *      注意：若选成「Every 30 minutes」，只有 :00 / :30 会被唤醒，09:20、21:45 永远命不中。
 *   5) 浏览器打开 https://<worker名>.<你的子域>.workers.dev 可手动触发一次（返回 204 即成功）
 */

const OWNER = 'yihong-ally';
const REPO = 'daily-digest';
const WORKFLOW = 'daily.yml';

// 触发时刻（北京时间 HH:MM）。脚本本身幂等：该期已存在就秒退，不调模型，所以多点是安全的。
//   09:00 晨报到点  09:20 晨报兜底（若 09:00 那次失败）
//   21:30 晚报到点  21:45 晚报兜底
const SCHEDULE = ['09:00', '09:20', '21:30', '21:45'];

function beijingHHMM(date) {
  const t = new Date(date.getTime() + 8 * 3600 * 1000);
  const hh = String(t.getUTCHours()).padStart(2, '0');
  const mm = String(t.getUTCMinutes()).padStart(2, '0');
  return hh + ':' + mm;
}

function toMin(hhmm) {
  const p = hhmm.split(':');
  return Number(p[0]) * 60 + Number(p[1]);
}

// 目标时刻之后 0~2 分钟内都算命中：cron 抖动几十秒、晚一两分钟也不会漏。
// 重复触发不要紧——workflow 里「该期已存在」会秒退。
function hit(nowHHMM) {
  const n = toMin(nowHHMM);
  return SCHEDULE.some(function (t) {
    const d = n - toMin(t);
    return d >= 0 && d <= 2;
  });
}

async function dispatch(env, note) {
  const url = 'https://api.github.com/repos/' + OWNER + '/' + REPO + '/actions/workflows/' + WORKFLOW + '/dispatches';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.GITHUB_TOKEN,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'digest-cron-worker',
    },
    body: JSON.stringify({ ref: 'main', inputs: { mode: 'normal', force: 'no' } }),
  });
  const text = await res.text();
  console.log(note, 'HTTP', res.status, text.slice(0, 200));
  return { status: res.status, text };
}

export default {
  // Cron 每分钟调用一次，只在目标分钟真正触发（避免占用多个 cron 配额）
  async scheduled(event, env, ctx) {
    const now = beijingHHMM(new Date());
    // 心跳日志：每次被 cron 唤醒都留一行。去 Observability → 日志 搜 tick，
    // 能看到「定时到底有没有跑」「实际落在第几分钟」，是排查漏刊最直接的一条线索。
    console.log('tick ' + now + ' cron=' + (event && event.cron ? event.cron : '-'));
    if (!hit(now)) return;
    ctx.waitUntil(dispatch(env, 'cron ' + now));
  },

  // 浏览器直接访问即可手动触发，方便验证 token 是否有效
  async fetch(request, env) {
    if (!env.GITHUB_TOKEN) {
      return new Response('未配置 GITHUB_TOKEN：请在 Settings → Variables and Secrets 添加 Secret', { status: 500 });
    }
    const r = await dispatch(env, 'manual');
    const ok = r.status === 204;
    return new Response(
      (ok ? '触发成功：HTTP 204' : '触发失败：HTTP ' + r.status) +
        (r.text ? '\n' + r.text.slice(0, 300) : '') +
        '\n\n204 = GitHub 已接受，约 1 分钟后运行；401 = token 无效；403 = 权限不足；404 = 仓库或文件名错',
      { headers: { 'content-type': 'text/plain; charset=utf-8' } }
    );
  },
};
