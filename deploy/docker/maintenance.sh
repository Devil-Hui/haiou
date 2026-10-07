#!/usr/bin/env bash
# ============================================================================
# aura 维护任务（Docker Compose 版）
#
# 做三件事，缺一个都会在 silently 层面出问题：
#   1. 订单过期清理      —— 不做则「待支付」列表越积越多，运营看不出真实在跑的量
#   2. 充值任务推进      —— 不做则买家关掉页面任务永久卡住（timed_out 终态永不出现）
#   3. 账号凭证 TTL 抹除 —— 不做则买家的登录态密文无限期留库（最高敏感级数据）
#
# 由 aura-docker-maintenance.timer 每 5 分钟触发，也可手工执行：
#   bash deploy/docker/maintenance.sh
#
# 退出码：0 成功；1 失败（供 systemd / cron 判定是否告警）。
# ============================================================================
set -euo pipefail

# ---- 定位项目根 --------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${APP_ROOT}"

log() { printf '[maintenance] %s\n' "$*"; }
die() { printf '[maintenance] 错误：%s\n' "$*" >&2; exit 1; }

# compose 命令：带 nginx 覆盖文件，这样即使叠加了边缘层也能正确解析服务。
COMPOSE_BASE="${COMPOSE:-docker compose -f docker-compose.yml -f deploy/docker-compose.nginx.yml}"

# ---- 前置检查 ----------------------------------------------------------------
# app 没起来就 exec = 命令必然失败，且失败原因（容器不存在）会淹没真正的业务错误。
if ! ${COMPOSE_BASE} ps --status running --services 2>/dev/null | grep -qx app; then
    die "app 容器未运行，无法执行维护任务。先检查：${COMPOSE_BASE} ps"
fi

# ---- 执行 --------------------------------------------------------------------
# ⚠️ 必须用 tsx，不能用裸 node：
#   src/lib/orders/expiry.ts 等依赖 `@/db` 这类 tsconfig 路径别名，
#   而 Node 的 type stripping **不支持别名**，裸 node 会报
#   `Cannot find package '@/db'`（实测踩过）。
#   tsx 已在 dependencies（非 devDependencies），生产镜像里 node_modules/.bin/tsx 存在。
#
# -T 是必须的：不开 TTY，否则 cron/systemd 下没有终端会直接报错退出。
log "开始维护任务（订单过期 + 充值推进 + 凭证抹除）"
if ${COMPOSE_BASE} exec -T app node_modules/.bin/tsx scripts/maintenance.mjs; then
    log "维护任务完成"
else
    code=$?
    printf '[maintenance] 维护任务失败（退出码 %s），请查 journalctl -u aura-docker-maintenance\n' "${code}" >&2
    exit "${code}"
fi
