# 每日前沿简报 (Daily Frontier Brief)

每天自动生成的中文资讯简报：科技 / AI / 财经 / 宏观 / 教育 / 互联网 / 生活 八大板块。

## 架构（0 元全自动方案）

- **定时生成**：GitHub Actions 每天北京时间 08:00 / 18:00 自动运行 `scripts/generate.js`
- **内容生产**：抓取 14 个中文新闻源 → DeepSeek 大模型生成口语化八板块简报 → 只保留当天新闻
- **数据存储**：静态 JSON 直接提交到仓库 `site/data/`
- **网站托管**：GitHub Pages 免费托管 `site/` 目录，免登录公网访问，push 即自动更新

## 目录结构

```
scripts/generate.js          生成脚本（爬虫 + LLM + 写 JSON）
scripts/watchlist.default.json  自选列表默认值
site/index.html              前端页面（纯静态，免登录）
site/assets/                 前端样式与脚本
site/data/                   生成的简报数据（由 Actions 自动更新）
.github/workflows/daily.yml  定时任务
```

## 环境变量（GitHub Secrets 中配置）

| 变量 | 说明 |
|---|---|
| `LLM_KEY` | DeepSeek API Key（必填） |

可选：`LLM_BASE`（默认 `https://api.deepseek.com/v1`）、`LLM_MODEL`（默认 `deepseek-chat`）

## 本地运行

```bash
LLM_KEY=sk-xxx node scripts/generate.js
```

## 手动触发

GitHub 仓库 → Actions → Daily Digest Generator → Run workflow。
