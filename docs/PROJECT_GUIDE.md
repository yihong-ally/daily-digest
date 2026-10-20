# 每日前沿简报 · 项目手册

> 最后更新：2026-10-20（v2.2 结构重构 + 时段判定修复）
> 本文档 = 项目说明书 + 操作手册 + 排障记录。看完就知道它是什么、怎么转、怎么改、坏了怎么修。

---

## 一、这个项目是什么

**一个零成本、全自动的中文每日资讯网站。**

每天云端定时抓 14 个中文新闻源 → 交给 DeepSeek 改写成"人话版"8 板块简报 → 自动发布到公网，任何人免登录就能看；另有 PushPlus 可推到微信。

- 🌐 网站：https://yihong-ally.github.io/daily-digest/
- 📦 仓库：https://github.com/yihong-ally/daily-digest （默认分支 `main`）
- 💰 成本：**0 元**（GitHub 免费额度）
- 🖥️ 电脑依赖：**无**（关机也能跑，全部在云端）

**八个板块**：今日必读 / AI·大模型动态 / 科技硬核 / 财经·市场 / 宏观经济 / 教育 / 互联网大厂 / 生活·消费

---

## 二、整体架构

```
┌──────────────────────────────────────────────────────────────┐
│                      GitHub（云端，免费）                       │
│                                                              │
│  GitHub Actions：每天 5 个触发点（北京时间）                     │
│    08:00 / 08:05 / 18:00 / 18:05 / 22:00                      │
│         │                                                    │
│         ▼                                                    │
│  node scripts/generate.js（零 npm 依赖）                       │
│         ├─ ① 抓 14 个中文新闻源（RSS + JSON API）               │
│         ├─ ② 只留当天新闻 → 去重 → 打乱 → 取前 60 条            │
│         ├─ ③ DeepSeek 生成 8 板块口语化简报                     │
│         ├─ ④ 抓自选股实时行情（腾讯行情接口）                    │
│         └─ ⑤ 写 site/data/ 静态 JSON                          │
│         │                                                    │
│         ▼                                                    │
│  git 自动提交 → GitHub Pages 自动部署 → 公网可访问               │
│  （可选）PushPlus 推送摘要到微信                                │
└──────────────────────────────────────────────────────────────┘
```

### 时段判定：延迟感知 + 缺口自愈（v2.2 重写，重要）

GitHub 的 `schedule` **实际触发时间可能比 cron 设定晚数小时**。旧版脚本按"现在几点"判断晨报/晚报
（`hour < 14` → 晨报），一旦晚报任务延迟跨过午夜，就会被写成"第二天的晨报"，导致**前一天的晚报永久缺失**，
且 22:00 的兜底任务本身也被延迟到次日凌晨、只检查"新的一天"，补不回来。

现在改为**每次运行先规划该补哪几期，再逐期生成**，与当前钟点无关：

| 顺序 | 目标 | 条件 |
|---|---|---|
| 1 | 今天晨报（08） | 当前 ≥ 06:00 且该期不存在 |
| 2 | 今天晚报（18） | 当前 ≥ 14:00 且该期不存在 |
| 3 | 昨天晚报（18） | 不存在就补（延迟跨夜的主要回收场景） |
| 4 | 昨天晨报（08） | 当前 < 14:00 且不存在（整天缺口自愈） |

- 每期生成后即写入 `digest-YYYY-MM-DD-HH.json`，同日再跑会被"已存在则跳过"去重，不会重复消耗 API。
- 单次运行最多生成 `MAX_EDITIONS_PER_RUN = 2` 期，控制大模型成本；5 个触发点足以补齐全部缺口。
- 回补历史期时 `digest.backfilled = true`，并且**不写入行情历史**（回补时拿到的是当前行情，记到历史日期会失真）。

---

## 三、目录结构

### 线上仓库（GitHub `main`，共 166 个文件）

| 路径 | 作用 |
|---|---|
| `.github/workflows/daily.yml` | 定时任务：5 个 cron + 手动触发（可选 normal / topup） |
| `scripts/generate.js` | **核心生成脚本**（抓取 + LLM + 写数据 + 微信推送） |
| `scripts/watchlist.default.json` | 自选股/基金默认配置 |
| `site/index.html` | 网站首页（纯静态，免登录） |
| `site/assets/css/style.css` | 样式 |
| `site/assets/js/app.js` | 前端逻辑（读 `data/*.json` 渲染、日期/版次切换、sparkline） |
| `site/data/digest-latest.json` | 最新一期（首页默认展示） |
| `site/data/digest-YYYY-MM-DD-HH.json` | 每期归档（HH = 08 晨报 / 18 晚报） |
| `site/data/editions/YYYY-MM-DD.json` | 某天有哪些版次（前端晨/晚报切换） |
| `site/data/archive.json` | 日期列表（前端日期选择器） |
| `site/data/history/{stocks,funds}.json` | 行情历史序列（前端走势图） |
| `docs/PROJECT_GUIDE.md` | 本文档 |
| `docs/项目检查报告-2026-10-20.md` | 2026-10-20 健康检查记录 |

### 本地目录（`D:\智能体生成\每日前沿简报\`）

本地 = 线上镜像 + 一个**不进仓库的本地归档区**：

```
.github/  scripts/  site/  README.md  .gitignore   → 与线上一致，改了要推送
docs/                                             → 文档，同样推到线上
_local-archive/                                   → 本地归档，已 gitignore，不进仓库
  ├── tencent-cloud/   （旧腾讯云版本：cloudfunctions、cloudrun-app、digest-server、distDir、Dockerfile、cloudbaserc.json 等）
  ├── old-frontend/    （旧前端副本 daily-digest/）
  └── local-git-backup/（旧 .git 备份，2026-10-20 重建仓库前留档）
.workbuddy/         → 助手工作目录，已 gitignore
```

> ⚠️ `_local-archive/tencent-cloud/digest-server/` 里有**明文密钥**（`env.local`、`pg.local.json`、`config.json`：
> 腾讯云 API Key、Cookie 签名密钥）。这些文件从未上传到 GitHub，但建议确认腾讯云已停用后整目录删掉。

---

## 四、依赖与密钥

### 运行依赖

| 依赖 | 用途 | 要不要自己准备 |
|---|---|---|
| Node.js ≥ 18（Actions 自带） | 跑生成脚本 | ❌ |
| 14 个公开新闻源 | 素材 | ❌ 全公开接口 |
| DeepSeek API | 生成内容 | ✅ 已配置 |

脚本**零 npm 依赖**（只用 Node 原生 `fetch`），刻意为之，方便在任何环境跑。

### 密钥（GitHub → Settings → Secrets and variables → Actions）

| 密钥 | 内容 | 必须 |
|---|---|---|
| `LLM_KEY` | DeepSeek API Key | ✅ |
| `PUSHPLUS_TOKEN` | PushPlus 推送 token（不配则不推微信） | ⬜ |

---

## 五、每天怎么运作

| 北京时间 | UTC | 动作 |
|---|---|---|
| 08:00 | `0 0 * * *` | 晨报主触发 |
| 08:05 | `5 0 * * *` | 晨报补跑（已生成则跳过） |
| 18:00 | `0 10 * * *` | 晚报主触发 |
| 18:05 | `5 10 * * *` | 晚报补跑（已生成则跳过） |
| 22:00 | `0 14 * * *` | 兜底：按规划补齐当天/昨天缺口 |

> GitHub cron 用 **UTC**，北京时间 = UTC + 8。改时间记得换算：想 07:00 跑 = UTC 前一天 23:00（`0 23 * * *`）。

每期简报包含：8 板块条目（每条 = 口语化标题 + "发生了什么…看点：…" 两句话 + 来源 + 原文链接）+ 行情快照。

---

## 六、日常操作手册

> 通用规则：**改本地文件 → 推送到 GitHub `main` → Actions 下次运行生效**。数据文件由 Actions 自己提交，不用手动改。

### 6.1 推送修改到 GitHub

本地 git 已于 2026-10-20 修复并对齐线上：

```bash
git remote -v          # origin → https://github.com/yihong-ally/daily-digest.git
git branch -vv         # main 跟踪 origin/main
git status             # 看改动
git add -A && git commit -m "chore: 说明"
git push origin main   # 需要 GitHub PAT 作为密码（或无密码登录态）
```

> 若没有 PAT：可以把改动文件内容贴到 GitHub 网页端对应文件里直接提交（网页编辑同样能触发部署）。

### 6.2 常用修改

| 想改什么 | 改哪里 |
|---|---|
| 内容风格（更活泼/更专业） | `scripts/generate.js` → `callLLM()` 的 `sys` 提示词 |
| 增删新闻源 | `scripts/generate.js` → `NEWS_SOURCES`（14 条，`{url, type, tag}`） |
| 增删板块 | ① `SECTIONS` 数组 ② `callLLM()` 提示词里的板块定义 ③ `site/assets/js/app.js` 的 `SECTION_KEYS`/`COL_TITLES` |
| 改更新频率/时间 | `.github/workflows/daily.yml` 的 `on.schedule.cron`（注意 UTC） |
| 改自选股/基金 | `scripts/watchlist.default.json`（要实时行情，`id` 必须以 `sh`/`sz`/`hk` 开头；无实时源的条目加 `"static": true`） |
| 强制重做某期 | 手动触发 workflow 时无法指定日期；本地跑 `FORCE=1 node scripts/generate.js` 或删除对应 `digest-*.json` 后让 Actions 补 |
| 查历史数据 | 网站日期选择器 + 晨/晚报切换；或直接看 `site/data/digest-*.json` |

### 6.3 手册/文档

- 项目手册：`docs/PROJECT_GUIDE.md`
- 健康检查记录：`docs/项目检查报告-2026-10-20.md`
- 改完文档记得一起推送，否则只改在本地。

---

## 七、故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 某期没生成 | GitHub schedule 漏触发/延迟 | 5 个触发点 + 缺口自愈已能兜住；仍缺就在 Actions 里手动 Run workflow（选 mode=topup） |
| Actions 红色失败 | 看日志定位 | 仓库 → Actions → 点失败记录 → 展开步骤 |
| 某新闻源没内容 | 源临时失效 | 脚本自动跳过坏源；日志里 `source failed` 就是它 |
| LLM 报错 | key 失效/余额不足 | 换新 key：Settings → Secrets → `LLM_KEY` |
| 网站空白 | 数据缺失 | 手动触发一次生成 |
| 晚报连续缺失 | 旧版按钟点判版次的 bug | **v2.2 已修**（延迟感知 + 缺口自愈）；历史缺口无法补（脚本只留当天新闻） |
| `git` 操作报 `config.lock`/`index.lock` 存在 | 2026-08 留下的陈旧锁文件 | 已删除；若再出现，删掉 `.git/*.lock` 即可 |
| 删除/重命名文件报"访问被拒绝" | 目录 ACL 缺少删除权限（历史沙箱遗留） | **2026-10-20 已修**：给项目根目录加了当前用户可继承的完全控制权限；备份在 `D:\智能体生成\acl-recovery\` |

**查运行日志**：仓库 → **Actions** → 点任意一次运行 → 展开步骤看 `[generate]` 开头的日志（会打印 plan / skip / done / push 结果）。

---

## 八、版本沿革

| 版本 | 时间 | 变化 |
|---|---|---|
| v1 | 2026-08 上旬 | 腾讯云 CloudBase：CloudRun 容器 + PostgreSQL，带登录审批 |
| v1.5 | 2026-08 中旬 | 扩到 8 板块，晨报/晚报分版保存，只爬当天新闻 |
| v2.0 | 2026-08-25 | 腾讯云免费额度耗尽 → 迁 GitHub 免费方案，去登录，纯静态 Pages |
| v2.1 | 2026-08-27 | 发现定时漏触发 → 加 5 个触发点 + 跳过/兜底逻辑 |
| **v2.2** | **2026-10-20** | **① 目录重构**：废弃腾讯云版本归档到 `_local-archive/`、清理 26 个临时垃圾目录、文档归入 `docs/`；**② 修复时段判定**：延迟感知 + 缺口自愈，解决"晚报系统性缺失 + 晨报凌晨发布"；**③ 修复 git**：清陈旧锁、重建 remote、对齐 `main`；**④ 修复工作区权限**：恢复删除/重命名能力；**⑤ 修复行情误导**：黄金标为静态参考、隐藏假涨跌；**⑥ README/手册更新** |

---

## 九、速查

| 项目 | 地址 |
|---|---|
| 网站 | https://yihong-ally.github.io/daily-digest/ |
| 仓库 | https://github.com/yihong-ally/daily-digest |
| 运行日志 | 仓库 → Actions |
| 密钥管理 | 仓库 → Settings → Secrets and variables → Actions |
| 本地项目 | `D:\智能体生成\每日前沿简报\` |
| 本地归档 | `D:\智能体生成\每日前沿简报\_local-archive\` |
| 权限恢复备份 | `D:\智能体生成\acl-recovery\` |
