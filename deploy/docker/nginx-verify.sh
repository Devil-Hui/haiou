#!/usr/bin/env bash
# ============================================================================
# Nginx 运维助手：验证 / 重载 / 状态 / 日志，一次到位，每次操作留痕
#
# 为什么需要这个脚本：
#   1. 验证 —— 上线前/改配置后一键确认"配置没坏"（nginx -t + 健康检查 + 关键项断言）
#   2. 留痕 —— 每次 reload / 验证都写进专用日志 data/nginx/ops.log，可回溯谁、何时、做了什么
#   3. 应急 —— 出问题时 `--status` / `--log` 一眼定位，不用翻 compose 无数命令
#
# 用法（任意子命令，均可重复执行）：
#   bash deploy/docker/nginx-verify.sh             # 完整验证（推荐上线前跑）
#   bash deploy/docker/nginx-verify.sh --quick     # 快速验证（nginx -t + healthy，日常用）
#   bash deploy/docker/nginx-verify.sh --reload    # 平滑重载（改配置/换证书后）
#   bash deploy/docker/nginx-verify.sh --log       # 查看最近操作留痕
#   bash deploy/docker/nginx-verify.sh --status    # 容器/端口/内存状态
#
# 使用前提：nginx、db、app 三个容器已通过 compose 启动。
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${APP_ROOT}"

# compose 命令（必须带覆盖文件才能引用 nginx 服务）
COMPOSE="${COMPOSE:-docker compose -f docker-compose.yml -f deploy/docker-compose.nginx.yml}"

# 操作留痕日志
OPS_LOG="${APP_ROOT}/data/nginx/ops.log"
mkdir -p "$(dirname "${OPS_LOG}")" 2>/dev/null || true

# ---- 工具函数 ---------------------------------------------------------------
log()  { printf '  %s\n' "$*"; }
die()  { printf '❌  %s\n' "$*" >&2; exit 1; }

# 统一留痕：每次动作带时间戳，"谁在何时做了什么"可追溯
record() {
    local action="$*"
    printf '%s  %s\n' "$(date '+%F %T')" "${action}" >> "${OPS_LOG}"
}

# ---- 子命令分发 ----
MODE="${1:-verify}"
case "${MODE}" in
  --do|verify)     MODE="verify" ;;
  --quick)         MODE="quick" ;;
  --reload)        MODE="reload" ;;
  --status)        MODE="status" ;;
  --log)           MODE="log" ;;
  -h|--help)       sed -n '2,18p' "$0" | sed 's/^# //'; echo "  (部署路径假设：脚本位于 deploy/docker/ 下)"; exit 0 ;;
  *)               die "未知参数：${MODE}。用 ${0} -h 查看用法" ;;
esac

# 容器在跑吗？
is_running() {
    ${COMPOSE} ps --status running --services 2>/dev/null | grep -qx nginx
}

# ---- 验证主逻辑 ----------------------------------------------------------
verify_core() {
    # 1. 容器状态
    if ! is_running; then
        record "VERIFY FAIL nginx 容器未运行"
        die "nginx 容器未运行。先启动：${COMPOSE} up -d nginx"
    fi
    log "✓ nginx 容器运行中"

    # 2. 配置语法（硬门槛）
    if ! ${COMPOSE} exec nginx nginx -t >/dev/null 2>&1; then
        record "VERIFY FAIL nginx -t 配置语法失败"
        die "nginx -t 配置语法失败，请检查：(改配置后先跑 bash deploy/docker/nginx-verify.sh --reload 前不要上线)"
    fi
    log "✓ nginx -t 配置语法通过"

    # 3. 健康检查端点（真实请求而非进程存活）
    local hc
    hc="$(${COMPOSE} exec nginx curl -fsS http://127.0.0.1:9443/nginx-health 2>/dev/null || echo FAIL)"
    [ "${hc}" = "ok" ] || { record "VERIFY FAIL 健康检查端点未返回 ok"; die "健康检查端点异常：${hc}"; }
    log "✓ 健康检查端点 → ok"

    # 4. 关键配置断言（防止"部署了但没生效"的隐性故障）
    local realip_cn worker
    realip_cn="$(${COMPOSE} exec nginx sh -c "nginx -T 2>/dev/null | grep -c set_real_ip_from" 2>/dev/null || echo 0)"
    [ "${realip_cn}" -ge 23 ] || { record "VERIFY FAIL Cloudflare realip 段数不足（${realip_cn}）"; die "Cloudflare realip 段数异常（${realip_cn}，应为 ≥23）——真实 IP 还原可能失效"; }
    log "✓ Cloudflare realip 信任链 ${realip_cn} 段"

    worker="$(${COMPOSE} exec nginx sh -c "nginx -T 2>/dev/null | grep -m1 'worker_processes'" 2>/dev/null | awk '{print $NF}')"
    [ -n "${worker}" ] || die "无法读取 worker_processes"
    log "✓ worker_processes=${worker}"

    record "VERIFY OK: nginx -t + 健康检查 + realip(${realip_cn}段) + worker(${worker}) 全部通过"
    echo
    log "✅ Nginx 验证通过 —— 配置可靠可上线"
}

# ---- 各子命令执行 --------------------------------------------------------
case "${MODE}" in
  verify)
    echo "== 完整生产验证 =="
    verify_core
    ;;

  quick)
    echo "== 快速验证 =="
    verify_core
    ;;

  reload)
    # 改配置/换证书后平滑重载（不中断连接）。先验证再重载。
    echo "== 平滑重载 =="
    record "RELOAD: 开始重载 nginx（请求平滑重载）"
    # 先做语法与健康前置，重载前失败就不触碰线上
    verify_core
    if ! ${COMPOSE} exec nginx nginx -s reload 2>/dev/null; then
        record "RELOAD FAIL: nginx -s reload 失败"
        die "reload 失败，请立即查看：bash $0 --status"
    fi
    record "RELOAD OK: nginx 已平滑重载"
    log "✓ 已平滑重载，连接未中断"
    ;;

  status)
    echo "== 运行状态 =="
    ${COMPOSE} ps nginx 2>/dev/null || true
    echo
    log "资源占用（内存上限应不受影响）："
    docker stats --no-stream --format "  {{.Name}}: {{.MemUsage}} / {{.MemPerc}}" 2>/dev/null | grep -i nginx || true
    echo
    log "配置总览（worker_processes / worker_connections / rlimit_nofile）："
    ${COMPOSE} exec nginx sh -c "nginx -T 2>/dev/null | grep -E 'worker_processes|worker_connections|worker_rlimit_nofile'" 2>/dev/null || true
    echo
    log "最近操作留痕："
    [ -f "${OPS_LOG}" ] && tail -10 "${OPS_LOG}" || echo "   （暂无留痕，运行 --verify 或 --reload 后生成）"
    record "STATUS: 查询运行状态"
    ;;

  log)
    echo "== 操作留痕（最近 20 条）=="
    if [ -f "${OPS_LOG}" ]; then
        tail -20 "${OPS_LOG}"
    else
        echo "  脚本尚未写入任何操作留痕（首次运行 --verify 或 --reload 后生成）"
    fi
    ;;

esac