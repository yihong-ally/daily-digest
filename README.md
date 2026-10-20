# 每日前沿简报 (Daily Frontier Brief)

每天自动生成的中文资讯简报：科技 / AI / 财经 / 宏观 / 教育 / 互联网 / 生活 八大板块。

- 🌐 网站：https://yihong-ally.github.io/daily-digest/ （GitHub Pages，免登录）
- 💰 成本：0 元（GitHub 免费额度），无服务器、无数据库、零 npm 依赖
- 🤖 全自动：Action 定时跑脚本 → 抓新闻 → DeepSeek 改写 → 提交 JSON → 自动部署

## 架构

```
GitHub Actions（北京时间 08:00 / 08:05 / 18:00 / 18:05 / 22:00 共 5 个触发点）
   ↓ node scripts/generate.js
① 抓 19 个新闻源（RSS + JSON API + 政府网点列表页）
② 只保留当天发布的新闻 → 去重 → 按板块公平取样 60 条（保证教育/互联网等小板块也有素材）
③ DeepSeek 生成 8 板块口语化简报（标题改人话 + "发生了什么…看点：…"）
④ 抓自选股实时行情（腾讯行情接口），基金走静态配置
⑤ 写 site/data/ 静态 JSON（最新一期 + 归档 + 版次索引 + 日期索引 + 行情历史）
⑥ git 提交 → GitHub Pages 自动部署；可选 PushPlus 推送到微信
```

**选题偏好**：AI 与大模型前沿进展、财经/宏观动向优先；其次硬科技与互联网大厂；教育、生活有真正相关的才放。

**时段判定（关键设计）**：GitHub 的 schedule 可能比设定晚数小时。脚本不按"当前几点"猜晨报/晚报，
而是每次运行先规划「该补哪几期」——当天到点的时段优先，其次回补昨天缺失的时段，因此延迟只会让某期晚出，
不会出现"晚报缺失 / 晨报凌晨发布"。同一期已存在则自动跳过（去重）。

## 目录结构

```
.github/workflows/daily.yml     定时任务（5 个触发点；手动触发可选 normal / topup）
scripts/generate.js             生成脚本（抓取 + 大模型 + 写数据 + 微信推送）
scripts/watchlist.default.json  自选股/基金默认配置
site/index.html                 前端页面（纯静态，免登录）
site/assets/css|js/             前端样式与脚本
site/data/                      生成的数据（由 Actions 自动提交）
docs/PROJECT_GUIDE.md           项目手册（操作 + 依赖 + 排障）
docs/项目检查报告-2026-10-20.md  上线以来的健康检查记录
_local-archive/                 本地归档（旧腾讯云版本等，已 gitignore，不进仓库）
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `LLM_KEY` | ✅ | DeepSeek API Key（GitHub Secrets） |
| `PUSHPLUS_TOKEN` | ⬜ | PushPlus 推送 token，配了才会推微信 |
| `LLM_BASE` | ⬜ | 默认 `https://api.deepseek.com/v1` |
| `LLM_MODEL` | ⬜ | 默认 `deepseek-chat` |
| `MODE` | ⬜ | `normal`（默认）或 `topup`（强制补齐昨天+今天） |
| `FORCE` | ⬜ | 设为 1 强制重做当期，忽略"已生成则跳过" |

## 本地运行

```bash
LLM_KEY=sk-xxx node scripts/generate.js          # 正常模式
LLM_KEY=sk-xxx MODE=topup node scripts/generate.js  # 补齐昨天+今天
```

本地调试注意：`DATA_DIR` 可指向临时目录，避免改动真实的 `site/data`。

## 手动触发线上更新

GitHub 仓库 → Actions → Daily Digest Generator → **Run workflow**（可选 mode=`topup` 强制补齐）。

## 数据结构

```
site/data/digest-latest.json          最新一期（首页默认展示）
site/data/digest-YYYY-MM-DD-HH.json   每期归档（HH = 08 晨报 / 18 晚报）
site/data/editions/YYYY-MM-DD.json    某天的版次列表（前端晨/晚报切换用）
site/data/archive.json                日期列表（前端日期选择器用）
site/data/history/{stocks,funds}.json 行情历史序列（前端 sparkline 用）
```
