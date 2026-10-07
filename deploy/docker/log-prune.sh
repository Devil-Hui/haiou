#!/usr/bin/env bash
# ============================================================================
# haiou 应用日志清理（Docker Compose 版）
#
# 保留期按类别区分——这是刻意的设计，不是随手定的天数：
#   logs/app/      运行日志     14 天   排障够用即可，多了只是占盘
#   logs/error/    error 级     30 天   告警数据源，要比运行日志长一点
#   logs/audit/    资金/权限    365 天  举证与对账依据，**丢了无法补**
#   logs/payment/  支付回调原文 180 天  dispute 时逐字比对，同样不可再生
#
# 为什么必须有这个脚本：
#   日志挂了卷持久化之后就不会再随容器重建消失，但也**不会再自动消失**——
#   没有清理就会一直增长，直到把盘写满。盘满的后果不是"日志写不进去"，
#   而是 PostgreSQL 一起挂掉（同一个盘）。这是从"丢日志"变成"丢服务"。
#
# 由 haiou-docker-log-prune.timer 每天触发，也可手工执行：
#   bash deploy/docker/log-prune.sh
#   DRY_RUN=1 bash deploy/docker/log-prune.sh     # 只看会删什么
# ============================================================================
set -euo pipefail

# ---- 定位项目根 --------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

LOG_DIR="${HAIOU_LOG_DIR:-${APP_ROOT}/data/logs}"
DRY_RUN="${DRY_RUN:-0}"

log() { printf '[log-prune] %s\n' "$*"; }

# ---- 保留天数默认值；覆盖通道 = 环境变量（.env 或调用时 export）----------------
# 类别 → 保留天数。与 compose/lib/core/log-sink.ts 顶部注释的约定保持一致；
# 改这里请同步改那份注释，否则文档与实现会对不上。
#
# 运营想微调保留期，**不用改本脚本**：在项目根 .env 加一行即可覆盖，例如
#   LOG_KEEP_APP=7
#   LOG_KEEP_AUDIT=730
# 缺省时回落如下默认（14/30/365/180）。DRY_RUN=1 可只预览不真删。
KEEP_APP="${LOG_KEEP_APP:-14}"
KEEP_ERROR="${LOG_KEEP_ERROR:-30}"
KEEP_AUDIT="${LOG_KEEP_AUDIT:-365}"
KEEP_PAYMENT="${LOG_KEEP_PAYMENT:-180}"

if [ ! -d "${LOG_DIR}" ]; then
    # 不能 exit 0：目录不存在 = 清理任务**静默没干活**（假阴性）。
    # 应用刚部署、还没写过日志时这里可能成立，但那是几百毫秒的事；
    # 之后只要应用在跑，目录就一定在。走到这里是异常，必须能让 timer/监控看到。
    printf '[log-prune] 错误 QL_001：日志目录不存在，清理未执行：%s\n' "${LOG_DIR}" >&2
    printf '[log-prune]    请先创建并确认卷映射：mkdir -p "%s" && chown 1000:1000 "%s"\n' "${LOG_DIR}" "${LOG_DIR}" >&2
    printf '[log-prune]    或在 docker-compose 中确认 HAIOU_LOG_DIR 与卷映射正确。\n' >&2
    exit 1
fi

prune() {
    category="$1"
    days="$2"
    dir="${LOG_DIR}/${category}"
    [ -d "${dir}" ] || { log "  ${category}: 目录不存在，跳过"; return 0; }

    # -mtime +N 表示"最后修改在 N*24 小时之前"。
    # 日志按天命名（app-2026-10-05.log）且当天持续追加，
    # 所以 mtime 就是"最后一次写入的日期"，用它判断过期是准确的。
    #
    # -name '*.log' 是必要的护栏：万一以后往这个目录放了别的东西，
    # 不会跟着一起被删。
    if [ "${DRY_RUN}" = "1" ]; then
        found=$(find "${dir}" -maxdepth 1 -type f -name '*.log' -mtime "+${days}" | wc -l)
        log "  ${category}: 保留 ${days} 天，将删除 ${found} 个文件（DRY_RUN，未实际删除）"
        return 0
    fi

    deleted=$(find "${dir}" -maxdepth 1 -type f -name '*.log' -mtime "+${days}" -print -delete | wc -l)
    log "  ${category}: 保留 ${days} 天，已删除 ${deleted} 个过期文件"
}

log "清理应用日志：${LOG_DIR}"
prune app      "${KEEP_APP}"
prune error    "${KEEP_ERROR}"
prune audit    "${KEEP_AUDIT}"
prune payment  "${KEEP_PAYMENT}"

# 顺带报告占用，便于观察趋势（盘满前会有明显上涨）
if command -v du >/dev/null 2>&1; then
    log "当前日志占用：$(du -sh "${LOG_DIR}" 2>/dev/null | cut -f1)"
fi
log "完成"
