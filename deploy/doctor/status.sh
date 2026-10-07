#!/usr/bin/env bash
# ============================================================================
# status.sh — 一键运行态概览（安全门保护）
#
# 汇总：compose 服务、systemd 定时器、磁盘占用、今日日志量、关键端口。
# 只读。适合日常巡检与投稿；详细诊断请再跑 haiou-doctor。
#
# 用法：bash deploy/doctor/status.sh
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/engine.sh"

gate_check || exit 2

echo
printf '%s== 1) Docker 服务状态 ==%s\n' "${C_BOLD}" "${C_RST}"
if [ "${#COMPOSE[@]}" -ge 1 ]; then
    "${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null \
      | sed 's/^/   /' || echo "  (compose ps 失败)"
else
    echo "  docker compose 不可用"
fi

echo
printf '%s== 2) systemd 定时器（若用 systemd 部署）==%s\n' "${C_BOLD}" "${C_RST}"
if command -v systemctl >/dev/null 2>&1; then
    systemctl list-timers 'haiou-docker-*' --no-pager --all 2>/dev/null | sed 's/^/   /' || echo "  (无 haiou-docker timers)"
else
    echo "  （非 systemd 环境，跳过）"
fi

echo
printf '%s== 3) 磁盘占用 ==%s\n' "${C_BOLD}" "${C_RST}"
df -h "${APP_ROOT}" "${APP_ROOT}/data/postgres" "${APP_ROOT}/data/backups" 2>/dev/null | sed 's/^/   /' || true

echo
printf '%s== 4) 日志规模（类别 + 行数）==%s\n' "${C_BOLD}" "${C_RST}"
if [ -d "${APP_ROOT}/logs" ]; then
    for cat in app error audit payment; do
        n=$(find "${APP_ROOT}/logs/${cat}" -type f -name '*.log' 2>/dev/null | wc -l | tr -d ' ')
        size=$(du -sh "${APP_ROOT}/logs/${cat}" 2>/dev/null | cut -f1)
        printf '   %-9s 文件数=%-4s 大小=%s\n' "${cat}" "${n}" "${size:-0}"
    done
else
    echo "  目录 ${APP_ROOT}/logs 尚不存在（未挂卷 或 app 未写日志）"
fi

echo
printf '%s== 5) 备份状态 ==%s\n' "${C_BOLD}" "${C_RST}"
BSTATE="${APP_ROOT}/data/doctor/backup.state"
if [ -f "${BSTATE}" ]; then
    while IFS='=' read -r k v; do
        case "${k}" in
            generated) printf '   上次备份：    %s\n' "${v}" ;;
            latest)    printf '   最近备份：    %s\n' "${v}" ;;
            size)      printf '   大小：        %s\n' "${v}" ;;
            offsite)   case "${v}" in
                ok)   printf '    %s 离机同步：   %s\n' "$(tag_done)" "已在远端" ;;
                fail) printf '    %s 离机同步：   %s\n' "$(tag_missing)" "上次失败（查 backup.sh 日志）" ;;
                *)    printf '    %s 离机同步：   未配置（本地仅一份）\n' "$(tag_wait)" ;;
            esac ;;
        esac
    done < "${BSTATE}"
    # 新鲜度检查：备份超过 48h 未更新 → 认为是停摆
    # （若 old-format 状态文件缺 generated_ts 键，按"停摆"处理而不是放行——
    #   停摆能吸引人去查，放行会让人误以为备份在跑。）
    ts="$(awk -F= '$1=="generated_ts"{print $2}' "${BSTATE}" 2>/dev/null || true)"
    now="$(date +%s)"
    if [ -z "${ts}" ] || [ $(( now - ts )) -gt 172800 ]; then
        printf '    %s 备份超过 48 小时未更新（或状态文件缺时间戳），备份可能已停摆！\n' "$(tag_missing)"
        printf '        若确已跑过 backup.sh，检查它是否报错、以及 .env 的 BACKUP_DIR 是否一致。\n'
    else
        printf '    %s 备份新鲜（最近 48h 内）\n' "$(tag_done)"
    fi
else
    printf '    %s 尚无备份状态文件（std backup 还没跑过）。请手动跑：bash deploy/docker/backup.sh\n' "$(tag_wait)"
fi

echo
printf '%s== 6) 数据目录清单（应在 init 阶段建好）==%s\n' "${C_BOLD}" "${C_RST}"
for d in data/postgres data/logs data/backups/db data/doctor; do
    p="${APP_ROOT}/${d}"
    if [ -d "${p}" ]; then
        printf '    %s %-20s （%s）\n' "$(tag_done)" "${d}" "$(du -sh "${p}" 2>/dev/null | cut -f1)"
    else
        printf '    %s %s  未创建 —— 先：mkdir -p "%s" && chmod 0700 "%s"\n' "$(tag_missing)" "${d}" "${p}" "${p}"
    fi
done

echo
printf '%s== 7) 关键端口（监听面 + 暴露提示）==%s\n' "${C_BOLD}" "${C_RST}"
# 判断某地址是否为全网段（0.0.0.0 / :: / :::）
_addr_wild() { printf '%s' "$1" | grep -qE '^(0\.0\.0\.0|::|:::|\*)'; }
port_addr() { # $1=port; 输出监听地址(空=未监听)；保证返回 0（否则 set -e 会被非零管道中断）
    local r=""
    if command -v ss >/dev/null 2>&1; then
        r="$(ss -ltn 2>/dev/null | awk -v pp=":${1} " '$4 ~ pp{print $4; exit}')" || true
    elif [ -r /proc/net/tcp ]; then
        for f in /proc/net/tcp /proc/net/tcp6; do
            r="$(awk -v hx="$(printf '%X' "$1")" 'NR>1 && $4=="0A" {split($2,a,":"); if (a[2]==hx){print $2; exit}}' "$f" 2>/dev/null)" || true
            [ -n "${r}" ] && break
        done
    elif command -v netstat >/dev/null 2>&1; then
        r="$(netstat -ltn 2>/dev/null | awk -v p=":${1} " '$4 ~p{print $4; exit}')" || true
    fi
    printf '%s\n' "${r}"
    return 0
}
printf '   %-8s %s\n' "3000" "$(addr=$(port_addr 3000); [ -n "$addr" ] && printf '监听(%s)' "$addr" || printf '未监听(app 承载)')"
printf '   %-8s %s\n' "443" "$(addr=$(port_addr 443); [ -n "$addr" ] && printf '监听(%s)' "$addr" || printf '未监听')"
printf '   %-8s %s\n' "80" "$(addr=$(port_addr 80); [ -n "$addr" ] && printf '监听(%s)' "$addr" || printf '未监听')"
db_addr="$(port_addr 5432)"
if [ -n "$db_addr" ]; then
    if printf '%s' "$db_addr" | grep -qE '^(0\.0\.0\.0|::|:::|\*)'; then
        printf '   %s db 5432 在 %s 监听 —— 通配绑定，疑似暴露公网，高危！\n' "$(tag_missing)" "$db_addr"
    else
        printf '   %s db 5432 在 %s 监听（内网隔离正常）\n' "$(tag_done)" "$db_addr"
    fi
else
    printf '   %-8s %s\n' "5432" "未在宿主机监听（正常,仅容器内互访）"
fi
echo "   提示：端口/防火墙/安全组全量核查 → bash deploy/doctor/checks/ports.sh"
echo
printf '%s运行态概览结束。深度诊断：bash deploy/doctor/haiou-doctor.sh%s\n' "${C_BOLD}" "${C_RST}"