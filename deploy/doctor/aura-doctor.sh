#!/usr/bin/env bash
# ============================================================================
# aura-doctor.sh — 全量体检中央入口（展开式分步反馈）
#
# 把 deploy/doctor/checks/ 下的子检查串起来跑，并按「已具备/未执行/未配置」
# 三态收拢：
#   · 已具备        → 折叠成一行（[已具备] xxx）
#   · 未执行 / 待配置 → 展开：给出「应当执行」的多条 fix 命令 + 可选的额外提示
#   这样既有总览，又能在弯腰处直接看到修复路径。
#
# 主要能力：
#   aura-doctor.sh                    全部检查（按顺序）
#   aura-doctor.sh --only=connect      只跑指定子检查（db|admin|connect|ports|cloudflare）或 step
#   aura-doctor.sh --gate-set          设置/重置安全门密码
#   aura-doctor.sh --reset-state       清空已收集状态（重新跑时全部按现场判定）
#   aura-doctor.sh --no-gate=1         CI/自动化：跳过安全门（不推荐）
#
# 统一出口：所有子检查把结论写进 STATE_FILE（data/doctor/steps.state），
# 本脚本读它做收敛展示。也可分别直接跑子脚本，结论同样落盘。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/engine.sh"

# ---- 参数 ------------------------------------------------------------------
ONLY=""
RESET_STATE=0
GATE_MODE=""      # "" 默认检查 | gate-set | gate-reset
while [ $# -gt 0 ]; do
    case "$1" in
        --only=*) ONLY="${1#--only=}" ;;
        --only) shift; ONLY="${1:-}" ;;
        --gate-set)  GATE_MODE="set" ;;
        --gate-reset) GATE_MODE="reset" ;;
        --reset-state) RESET_STATE=1 ;;
        --no-gate) NO_GATE=1 ;;
        *) doc_die "未知参数：$1（支持 --only=xxx / --gate-set / --gate-reset / --reset-state）" ;;
    esac
    shift
done

case "${GATE_MODE}" in
    set)
        doc_log "重置安全门密码……"
        rm -f "${GATE_DIR}/gate.hash"
        gate_init || exit 1
        announce sg-gate done "安全门已更新"
        exit 0
        ;;
    reset)
        rm -f "${GATE_DIR}/gate.hash" "${STATE_FILE}"
        doc_log "已清空安全门与状态文件"
        exit 0
        ;;
esac

# 中央入口跑查看/检查类命令前，默认要求安全门（仅当独立子脚本则不强求）。
if [ "${ONLY}" != "" ] && [ "${ONLY}" != "all" ]; then
    # 定向模式：不做整体门禁，避免打扰单步调试
    :
else
    if [ "${NO_GATE:-0}" = "1" ]; then
        doc_warn "跳过安全门（--no-gate）—— 如非 CI，请谨慎。"
    else
        gate_check || exit 2
    fi
fi

# --reset-state 立即作用于本轮
[ "${RESET_STATE}" -eq 1 ] && { rm -f "${STATE_FILE}"; doc_log "已清空状态文件，本轮将按现场重新判定"; }

echo
printf '%s=================================================%s\n' "${C_BOLD}" "${C_RST}"
printf '%s  aura 体检报告（先 preflight 后逐项）%s\n' "${C_BOLD}" "${C_RST}"
printf '%s=================================================%s\n' "${C_BOLD}" "${C_RST}"

# ---- 顺序执行子检查（每个都追加写 state，结论收拢）---------------------------
run_block() {
    local name="$1"; shift
    local file="${DOCTOR_DIR}/checks/${name}.sh"
    if [ "${ONLY}" != "" ] && [ "${ONLY}" != "all" ] && [ "${ONLY}" != "${name}" ]; then
        return 0
    fi
    if [ -f "${file}" ]; then
        # 子检查失败不能中断整套（db 未起、schema 缺失等都会使个别子检查非零退出）。
        # 在 `if` 条件上下文里吞掉退出码，只作告警记录，继续跑后续 block。
        if bash "${file}" "$@"; then :; else
            doc_warn "子检查 ${name} 未通过（见上方具体项，继续其余检查）"
        fi
    else
        doc_warn "找不到子检查：${name}.sh"
    fi
}
run_block db
run_block admin
run_block connect
run_block ports
run_block cloudflare

# ---- 收拢：展开式汇总（关键产出）------------------------------------------
echo
echo
printf '%s===========   展开式体检结论   ===========%s\n' "${C_BOLD}" "${C_RST}"
if [ ! -f "${STATE_FILE}" ]; then
    echo "  (未收集到任何状态 —— 请去掉 --only 全量跑一次)"
else
    # 稳定顺序：先展示每类，缺省键按「未执行」处理。
    # 这里只把「确实有结论」的键列出来（done 折叠 / wait+missing 仍折叠成标签行）。
    n_done=0; n_wait=0; n_missing=0
    while IFS='=' read -r k v; do
        [ -n "${k}" ] || continue
        case "${v}" in
            done)    n_done=$((n_done+1));    printf '  %-18s %s\n' "${k}" "$(tag_done)" ;;
            wait)    n_wait=$((n_wait+1));    printf '  %-18s %s\n' "${k}" "$(tag_wait)" ;;
            missing) n_missing=$((n_missing+1)); printf '  %-18s %s\n' "${k}" "$(tag_missing)" ;;
            skip)    printf '  %-18s %s\n'     "${k}" "$(tag_skip)" ;;
        esac
    done < "${STATE_FILE}"
    echo
    printf '  小结：%s 项已具备 / %s 项待执行 / %s 项未配置\n' \
        "${n_done}" "${n_wait}" "${n_missing}"
    [ "${n_missing}" -gt 0 ] && \
        printf '  %s：上方标记为「未配置」的项给出处置命令，按序执行即可。\n' "$(tag_missing)"
fi
echo
doc_log "所有检查完成。对任何「待执行/未配置」项，上方已展开并给出一条或多条修复命令。"
doc_log "单独再查某个子类：bash deploy/doctor/aura-doctor.sh --only=db|admin|connect|ports|cloudflare"