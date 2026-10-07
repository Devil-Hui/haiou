#!/usr/bin/env bash
# ============================================================================
# check.sh — 应用内核对：管理员、关键会话/令牌、运行态配置校验
#
# 进 app 容器核对管理员账号已创建、无静默闸门失效（degated adminAccess）、
# 并从 DB 二次确认管理员行存在。只读。
#
# 用法：bash deploy/doctor/checks/admin.sh
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../engine.sh"

[ "${#COMPOSE[@]}" -ge 1 ] || doc_die "docker compose 不可用。"
DB_UP=0
if svc_running db; then DB_UP=1; else
    announce db-stop missing "db 未运行，无法核对管理员行（其余环境检查继续）" "${COMPOSE[*]} up -d db"
fi

load_env_pg || true
_psql() { [ "${DB_UP}" -eq 1 ] || return 1; "${COMPOSE[@]}" exec -T db psql -U "${PG_USER}" -d "${PG_DB}" -Atqc "$1" 2>/dev/null; }

echo
printf '%s== 管理员记录存在性 ==%s\n' "${C_BOLD}" "${C_RST}"
if [ "${DB_UP}" -eq 0 ]; then
    announce admin-row wait "管理员行待确认（db 未就绪，先启动 db）" "${COMPOSE[*]} up -d db"
elif [ -n "$(_psql "SELECT to_regclass('public.admins');")" ]; then
    ADMIN_ROW=$(_psql "SELECT username FROM public.admins ORDER BY id LIMIT 1;")
    if [ -n "${ADMIN_ROW}" ]; then
        announce admin-row done "管理员已创建（username=${ADMIN_ROW}）"
    else
        announce admin-row missing "admins 表为空，尚未创建管理员" \
            "docker compose -f docker-compose.yml -f deploy/docker-compose.nginx.yml exec -it app node_modules/.bin/tsx scripts/create-admin.mjs"
    fi
else
    announce admin-row missing "admins 表缺失（先 init.sh 第 3 步 push 建表）" \
        "docker compose exec -T app npx drizzle-kit push"
fi

echo
printf '%s== 后台访问开关 ==%s\n' "${C_BOLD}" "${C_RST}"
ADMIN_ACCESS="$(env_get ADMIN_ACCESS || echo false)"
if [ "${ADMIN_ACCESS}" = "true" ]; then
    printf '  %s ADMIN_ACCESS=true —— 注意：生产应保持关闭，防止公网/后台页被绕过闸门直接访问管理接口\n' "$(tag_wait)"
    announce admin-access wait "ADMIN_ACCESS=true（生产建议设为 false）" \
        "在 ${ENV_FILE} 改 ADMIN_ACCESS=false 后重启 app"
else
    announce admin-access done "ADMIN_ACCESS=false（生产默认，符合安全基线）"
fi

echo
printf '%s==  .env 关键保密项非占位 ==%s\n' "${C_BOLD}" "${C_RST}"
for k in POSTGRES_PASSWORD ADMIN_SETUP_TOKEN CREDENTIAL_KEY; do
    v="$(env_get "${k}" || true)"
    if [ -z "${v}" ] || echo "${v}" | grep -qE '^(请改成|change|example|https://)'; then
        announce "env-${k}" missing "${k} 未配置（占位/空）" "bash deploy/doctor/init.sh"
    else
        printf '  %s %-18s 已配置（长度 %-3s，不回显）\n' "$(tag_done)" "${k}:" "${#v}"
    fi
done

echo
announce admin-check done "管理员核对完成"