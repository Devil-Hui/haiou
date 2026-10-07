#!/usr/bin/env bash
# ============================================================================
# haiou-doctor 共享引擎
#
# 被 deploy/doctor/ 下的所有脚本 source（不要直接执行）。职责：
#   1. SFG —— 安全门：本套件可整体开启「根密码（superuser gate）」，防未授权人员
#      用 status / tail-errors / haiou-doctor 偷看运行态。密码令牌存于项目外
#      的独立用户文件，默认打开（最开始的服务器即要求先配），可选 --no-gate 绕过。
#   2. 共享状态：一套「已检测 / 待执行 / 未配置 / 已具备」的收拢式结论模型，
#      供中央入口 haiou-doctor.sh 展开式输出；每个子检查通过 announce 上报。
#   3. 容器与命令的可重复访问：compose 命令、db/app 容器探测、日志路径等。
#
# 约束（沿用项目铁律）：
#   · 本文件及被 source 的脚本一律 LF，CRLF 检测见 has_cr（勿用 $'\r'）。
#   · shell 里不做破坏性操作：本引擎只读 / 生成状态，不改数据。
#   · 密码令牌不落盘不 export，仅存在于内存变量。
# ============================================================================
set -euo pipefail

DOCTOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${DOCTOR_DIR}/../.." && pwd)"

# ---- 常量与位点 ------------------------------------------------------------
COMPOSE_BASE="${COMPOSE:-docker compose -f ${APP_ROOT}/docker-compose.yml -f ${APP_ROOT}/deploy/docker-compose.nginx.yml}"
ENV_FILE="${APP_ROOT}/.env"
STATE_DIR="${HAIOU_STATE_DIR:-${APP_ROOT}/data/doctor}"
STATE_FILE="${STATE_DIR}/steps.state"
GATE_DIR="${HAIOU_GATE_DIR:-${APP_ROOT}/../.haiou-doctor}"     # 项目外，防误提交
GATE_FILE="${GATE_DIR}/gate.hash"
LOG_PRUNE_CATS="app:14 error:30 audit:365 payment:180"

# ---- 输出着色（自动探测 TTY，非 TTY 时关闭以免日志带转义码） ----------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    C_RST='\033[0m'; C_RED='\033[0;31m'; C_GRN='\033[0;32m'
    C_YEL='\033[0;33m'; C_BLU='\033[0;34m'; C_MAG='\033[0;35m'; C_CYN='\033[0;36m'; C_BOLD='\033[1m'
else
    C_RST=''; C_RED=''; C_GRN=''; C_YEL=''; C_BLU=''; C_MAG=''; C_CYN=''; C_BOLD=''
fi

# ---- 日志与日志（统一前缀） --------------------------------------------------
doc_log()  { printf '[doctor] %s\n' "$*"; }
doc_warn() { printf '[doctor] %s 警告：%s\n' "${C_YEL}${C_RST}" "$*" >&2; }
doc_err()  { printf '[doctor] %s 错误：%s\n' "${C_RED}${C_RST}" "$*" >&2; }
doc_die()  { doc_err "$@"; exit 1; }

# ---- compose 探测 ----------------------------------------------------------
COMPOSE=()
if command -v docker >/dev/null 2>&1; then
    # docker compose 插件优先；否则老式 docker-compose 二进制
    if docker compose version >/dev/null 2>&1; then
        COMPOSE=(docker compose -f "${APP_ROOT}/docker-compose.yml" -f "${APP_ROOT}/deploy/docker-compose.nginx.yml")
    elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE=(docker-compose -f "${APP_ROOT}/docker-compose.yml" -f "${APP_ROOT}/deploy/docker-compose.nginx.yml")
    else
        doc_warn "未发现 docker compose 插件（docker compose --version 失败）"
    fi
else
    doc_warn "环境中没有 docker 命令"
fi

# 服务是否在跑（接受 db/app/nginx）
svc_running() {
    [ "${#COMPOSE[@]}" -ge 1 ] || return 1
    "${COMPOSE[@]}" ps --status running --services 2>/dev/null | grep -qx "$1"
}

# ---- 步骤状态机 ------------------------------------------------------------
# state 文件每行：<key>=<status>，status ∈ {configured, skip, pending}。
# 子脚本执行时用 step_set 实时写盘，中央脚本收拢后 decide。
mk_state() { mkdir -p "${STATE_DIR}"; }
step_status() { [ -f "${STATE_FILE}" ] && grep -q "^${1}=" "${STATE_FILE}" && return 0 || return 1; }
step_get()    { awk -F= -v k="$1" '$1==k{print $2}' "${STATE_FILE}" 2>/dev/null; }
step_set_val() {
    mk_state
    local key="$1" val="$2"
    [ -f "${STATE_FILE}" ] && sed -i "/^${key}=/d" "${STATE_FILE}" 2>/dev/null
    printf '%s=%s\n' "${key}" "${val}" >> "${STATE_FILE}"
}

# 收敛输出标签
tag_done()     { printf '%s[%s已具备%s]%s' "${C_GRN}" "${C_RST}" "${C_GRN}" "${C_RST}"; }
tag_wait()     { printf '%s[%s未执行%s]%s' "${C_YEL}" "${C_RST}" "${C_YEL}" "${C_RST}"; }
tag_missing()  { printf '%s[%s未配置%s]%s' "${C_RED}" "${C_RST}" "${C_RED}" "${C_RST}"; }
tag_skip()     { printf '%s[%s跳过%s]%s' "${C_MAG}" "${C_RST}" "${C_MAG}" "${C_RST}"; }

# announce：子检查上报一个独立可判定步骤
#   announce <key> <done|wait|missing> <标题> [提示命令...]
# 调用点负责正确传参；本函数只负责落 state 和打标签。
announce() {
    local key="$1" status="$2" title="$3"; shift 3
    mk_state
    step_set_val "${key}" "${status}"
    case "${status}" in
        done)    printf '  %s %s\n' "$(tag_done)"    "${title}" ;;
        wait)    printf '  %s %s\n' "$(tag_wait)"    "${title}" ;;
        missing) printf '  %s %s\n' "$(tag_missing)" "${title}" ;;
        skip)    printf '  %s %s\n' "$(tag_skip)"    "${title}" ;;
    esac
    [ "${status}" = "missing" ] && for c in "$@"; do printf '        %s\n' " >> ${c}"; done
    [ "${status}" = "wait" ]    && for c in "$@"; do printf '        %s\n' " >> ${c}"; done
    return 0
}

# ---- 安全门
# 首次运行：交互设置根密码（设置时明确提示安全强度）；生成的哈希仅存于项目外。
# GATE=off 环境变量可跳过（用于 CI / 自动化非交互）。
gate_init() {
    [ -n "${NO_GATE:-}" ] && return 0
    if [ -f "${GATE_FILE}" ]; then
        return 0
    fi
    mkdir -p "${GATE_DIR}"
    if ! [ -t 0 ]; then
        doc_err "检测到非交互环境（没有 TTY），且安全门未初始化。\n  请先在 TTY 下执行：bash ${DOCTOR_DIR}/haiou-doctor.sh --gate-set\n  或在自动化中显式传 NO_GATE=1（不推荐）。"
        exit 2
    fi
    printf '%s\n' "首次使用 haiou-doctor，请先设置「安全门密码」（保护 status/logs/haiou-doctor 等查看类工具）。"
    printf '%s\n' "规则：≥8 位。输入时不回显。"
    local P1 P2
    printf '新密码: '
    read -rs P1; printf '\n'
    printf '再次输入: '
    read -rs P2; printf '\n'
    [ -n "${P1:-}" ] && [ "${#P1}" -ge 8 ] || { doc_err "密码过短（<8 位），已取消。"; return 1; }
    [ "${P1}" = "${P2}" ] || { doc_err "两次输入不一致，已取消。"; return 1; }
    printf '%s' "${P1}" | sha256sum | cut -d' ' -f1 > "${GATE_FILE}"
    chmod 600 "${GATE_FILE}"
    doc_log "安全门已启用（哈希仅存于 ${GATE_FILE}，明文未落盘）。查看/运维类命令需输入安全门密码。"
    return 0
}

# 校验一次输入
gate_check() {
    [ -n "${NO_GATE:-}" ] && return 0
    [ -f "${GATE_FILE}" ] || { doc_err "安全门未初始化，先执行 haiou-doctor.sh --gate-set"; return 1; }
    [ -t 0 ] || { doc_err "非交互环境且未提供密码，请传 NO_GATE=1（仅 CI，不推荐）。"; return 1; }
    local Pw want got
    printf '%s' "安全门密码: "
    read -rs Pw; printf '\n'
    want="$(cat "${GATE_FILE}")"
    got="$(printf '%s' "${Pw}" | sha256sum | cut -d' ' -f1)"
    [ "${got}" = "${want}" ] && return 0
    doc_err "安全门密码错误。"
    return 1
}

# ---- LF 自检：判定某文件是否为 LF（未被 CR）-----------------------------------
# 为什么必须用这招：本脚本及被 source 的兄弟脚本可能本身就是 CRLF（Windows 开发）。
# 用 `grep -q $'\r'` 在 CRLF 脚本内会因 $'\r' 二次解析而恒假。这里对所有待写文件
# 用 `tr -dc '\r'` 检测，可复用于 CLI 之外。
has_cr() {
    local f="$1"
    [ -f "${f}" ] || return 1
    [ "$(tr -dc '\r' < "${f}" 2>/dev/null | wc -c | tr -d ' ')" -gt 0 ]
}

# 参照：写回时若源带 CR，先对该单文件 LF 化（避免污染后续脚本）。
ensure_lf() {
    local f="$1"
    if [ -f "${f}" ] && has_cr "${f}"; then
        sed -i 's/\r$//' "${f}"
        has_cr "${f}" && doc_die "LF 化失败：${f}"
        doc_log "已 LF 化：${f}"
    fi
}

# 供 .env 修改入口共用：确保 .env 权限先收紧再写
lock_env() {
    [ -f "${ENV_FILE}" ] && chmod 600 "${ENV_FILE}"
}

# 从 .env 读取 PG 连接信息（与 backup.sh 口径一致：不 export 密码）。
# 成功时设置全局 PG_USER / PG_DB / PG_PASS（仅内存，不回显）。
load_env_pg() {
    [ -f "${ENV_FILE}" ] || return 1
    PG_USER="$(grep -E '^POSTGRES_USER=' "${ENV_FILE}" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
    PG_DB="$(grep  -E '^POSTGRES_DB=' "${ENV_FILE}" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
    PG_PASS="$(grep -E '^POSTGRES_PASSWORD=' "${ENV_FILE}" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
    PG_USER="${PG_USER:-haiou}"; PG_DB="${PG_DB:-haiou}"
    [ -n "${PG_PASS}" ]
}

# 读取任意 .env 键（不回显值本身）
env_get() {
    [ -f "${ENV_FILE}" ] || return 1
    grep -E "^${1}=" "${ENV_FILE}" | tail -1 | cut -d= -f2- | tr -d '"'"'"' '
}

# 在 .env 中设置键值（幂等：存在即替换，缺则追加）。先锁权限后单行改写，
# 保留文件其它行与注释。此改动用临时文件原子替换，避免半写。
env_set() {
    local key="$1" val="$2"
    local tmp
    lock_env
    mkdir -p "$(dirname "${ENV_FILE}")"
    [ -f "${ENV_FILE}" ] || touch "${ENV_FILE}"
    tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
    if grep -qE "^${key}=" "${ENV_FILE}"; then
        sed -E "s#^${key}=.*#${key}=${val}#" "${ENV_FILE}" > "${tmp}"
    else
        cp "${ENV_FILE}" "${tmp}"
        printf '%s=%s\n' "${key}" "${val}" >> "${tmp}"
    fi
    ensure_lf "${tmp}"
    mv "${tmp}" "${ENV_FILE}"
    chmod 600 "${ENV_FILE}"
}

# ---- 随机串生成（可选 openssl，回退到 /dev/urandom 的 base64 化简）----------
rand_token() {
    local len="${1:-32}"
    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$(( (len + 1) / 2 ))"
    else
        head -c "$(( (len + 1) / 2 ))" /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

# ============================================================================
# OPS 错误码框架（运维/脚本层专用）
#
# 约定：`{前缀2字母拼音}{下划线}{3位序号}`，如 BF_001 / WL_002 / QX_001。
#   前缀 = 拼音缩写，首两位即锁定问题的大类；尾号定位到具体脚本/位置。
#   只用于 deploy/ 下的备份、检查、日志、目录、用户、网络等运维动作，
#   **绝不改动业务 HTTP 错误码**（src/lib/core/api-error.ts 保持不变）。
#
# 前缀表（取拼音首字母，尽量可读）：
#   BF  备份 backup              HF  恢复/还原 restore
#   QY  迁移/转移 move           QL  清理/删除 prune
#   MF  目录/路径 dir             QZ  用户/权限 user/permission
#   SJ  数据库 database            YX  运行/容器 run/container
#   WL  网络/连通 network          YZ  校验/检查 verify
#   QX  权限不足 permission         SC  配置 config
#   ZT  状态文件 status            （兜底可用任意可读前缀）
# ============================================================================

# 给出前缀的人读释义（展示用）
ops_prefix_name() {
    case "${1:-}" in
        BF) printf '备份';; HF) printf '恢复/还原';; QY) printf '迁移/转移';; QL) printf '清理/删除';;
        MF) printf '目录/路径';; QZ) printf '用户/权限';; SJ) printf '数据库';;
        YX) printf '运行/容器';; WL) printf '网络';; YZ) printf '校验';; QX) printf '权限不足';;
        SC) printf '配置';; ZT) printf '状态';; *) printf '未知类目' ;;
    esac
}

# 展示一个完整错误码：前缀_序号 · 释义
ops_show_code() {
    local full="$1" pre="${1%%_*}"
    printf '  %s错误码 %s%s%s · %s%s\n' \
        "${C_RED}" "${C_BOLD}" "${full}" "${C_RST}" "$(ops_prefix_name "${pre}")"
}

# 友好失败统一出口：ops_fail <完整错误码> <标题> [提示命令...]
ops_fail() {
    local code="$1" title="$2"; shift 2
    printf '  %s ✗ %s\n' "$(tag_missing)" "${title}"
    ops_show_code "${code}"
    for c in "$@"; do printf '        %s\n' " · ${c}"; done
    return 1
}

ops_ok() {
    printf '  %s ✓ %s\n' "$(tag_done)" "$@"
    return 0
}

# 目录/路径存在且可写检查（友好反馈“该去哪创建/修权限”）。
# ops_dir_check <完整路径> ；返回 0=可写 1=缺失 2=存在但不可写
ops_dir_check() {
    local d="$1" _u _g
    if [ -d "${d}" ]; then
        if [ -w "${d}" ]; then
            ops_ok "目录可写：${d}"
            return 0
        else
            _u="$(id -un)"; _g="$(id -gn)"
            ops_fail QX_001 "目录存在但当前用户不可写：${d}" \
                "检查属主：ls -ld \"${d}\"" \
                "修正属主：sudo chown -R ${_u}:${_g} \"${d}\"（或改用项目专用用户执行）"
            return 2
        fi
    else
        ops_fail MF_001 "缺少必需目录：${d}" \
            "请先创建并收紧权限：" \
            "    mkdir -p \"${d}\" && chmod 0700 \"${d}\"" \
            "（本套件建议所有 data/ 子目录 0700，只有运行用户可进）"
        return 1
    fi
}

# 断言外置依赖存在
ops_need() {
    local bin="$1"
    if ! command -v "${bin}" >/dev/null 2>&1; then
        ops_fail YZ_001 "缺少命令：${bin}" "安装：sudo apt install -y ${bin}（或对应发行版包）"
        return 1
    fi
    return 0
}