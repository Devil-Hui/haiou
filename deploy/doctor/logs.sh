#!/usr/bin/env bash
# ============================================================================
# logs.sh — 便捷看日志（安全门保护）
#
# 常用子命令：
#   bash deploy/doctor/logs.sh app [行数]     # 最近 N 行应用日志（默认 100）
#   bash deploy/doctor/logs.sh error          # error 类最近
#   bash deploy/doctor/logs.sh audit          # audit（资金/权限举证，只读）
#   bash deploy/doctor/logs.sh payment        # 支付回调原文
#   bash deploy/doctor/logs.sh <无>            # 列出各分类
#   tail -f                                     # 跟随 直接可用
# 只读。
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/engine.sh"

gate_check || exit 2

CAT="${1:-}"
LINES="${2:-100}"

if [ -z "${CAT}" ]; then
    echo "用法：bash deploy/doctor/logs.sh <app|error|audit|payment> [行数]"
    echo "当前各分类日志文件："
    for c in app error audit payment; do
        dir="${APP_ROOT}/logs/${c}"
        if [ -d "${dir}" ]; then
            _lfiles="$(ls -1 "${dir}"/*.log 2>/dev/null | head -3 | xargs -r -n1 basename | tr '\n' ' ')" || _lfiles=""
            echo "  ${c}: ${_lfiles:-（无 .log）}"
        else
            echo "  ${c}: (无目录)"
        fi
    done
    exit 0
fi

case "${CAT}" in
    app|error|audit|payment) ;;
    *) doc_die "未知分类 ${CAT}（app|error|audit|payment）" ;;
esac

LATEST="$(find "${APP_ROOT}/logs/${CAT}" -type f -name '*.log' 2>/dev/null -printf '%T@ %p\n' | sort -n | tail -1 | cut -d' ' -f2-)"
if [ -z "${LATEST}" ]; then
    doc_warn "没有 ${CAT} 日志。若为空属于正常（未发生）而非故障。audit 空也可能是权限不足。"
    exit 0
fi
echo "（最近文件：${LATEST}，末 ${LINES} 行）"
tail -n "${LINES}" "${LATEST}"