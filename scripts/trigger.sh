#!/usr/bin/env bash
# 手动触发一期生成（不需要打开 GitHub 网页）
#
# 用法：
#   GITHUB_TOKEN=ghp_xxx bash scripts/trigger.sh              # 正常模式：缺哪期补哪期
#   GITHUB_TOKEN=ghp_xxx MODE=topup bash scripts/trigger.sh   # 强制补齐昨天+今天
#   GITHUB_TOKEN=ghp_xxx FORCE=yes bash scripts/trigger.sh    # 重做当期（会再花一次模型费用）
#
# 注意：GITHUB_TOKEN 只放环境变量，绝对不要写进这个文件（否则会被推上 GitHub）。

set -euo pipefail

TOKEN="${GITHUB_TOKEN:?请先设置 GITHUB_TOKEN 环境变量，例如：GITHUB_TOKEN=ghp_xxx bash scripts/trigger.sh}"
PROXY="${LOCAL_PROXY:-http://127.0.0.1:7897}"
MODE="${MODE:-normal}"
FORCE="${FORCE:-no}"

REPO="yihong-ally/daily-digest"
API="https://api.github.com/repos/${REPO}/actions/workflows/daily.yml/dispatches"

code=$(curl -s -o /dev/null -w "%{http_code}" -m 25 -x "$PROXY" \
  -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  -H "Content-Type: application/json" \
  -d "{\"ref\":\"main\",\"inputs\":{\"mode\":\"${MODE}\",\"force\":\"${FORCE}\"}}" \
  "$API" || echo "000")

case "$code" in
  204) echo "✓ 已触发（mode=${MODE} force=${FORCE}），约 1~2 分钟后出刊"
       echo "  进度：https://github.com/${REPO}/actions" ;;
  401) echo "✗ 401：token 无效或已过期" ;;
  403) echo "✗ 403：token 权限不足（需要 workflow 或 Actions:write）" ;;
  404) echo "✗ 404：仓库或 workflow 文件找不到" ;;
  000) echo "✗ 连接失败：检查代理 ${PROXY} 是否可用" ;;
  *)   echo "✗ 未预期状态码 ${code}" ;;
esac
