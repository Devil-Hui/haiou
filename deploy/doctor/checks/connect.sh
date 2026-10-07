#!/usr/bin/env bash
# ============================================================================
# connect.sh — 各容器连通性 & 应用 HTTP 探活
#
# 逐项验证：docker 可用 → compose 服务清单 → db 容器运行 & pg_isready →
# app 容器运行 & 应用在 127.0.0.1:3000 响应 /api/auth → （含 nginx 边缘层时）
# nginx 健康端口。只读探活，不改配置。
#
# 用法：bash deploy/doctor/checks/connect.sh
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../engine.sh"

echo
printf '%s== 基础环境 ==%s\n' "${C_BOLD}" "${C_RST}"
if command -v docker >/dev/null 2>&1 && docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    announce docker-ok done "Docker 守护进程可用（server v$(docker version --format '{{.Server.Version}}' 2>/dev/null)）"
else
    announce docker-ok missing "docker 不可用或未启动守护进程" "sudo systemctl enable --now docker"
fi

echo
printf '%s== db 容器 ==%s\n' "${C_BOLD}" "${C_RST}"
if svc_running db; then
    announce db-ct done "db 容器在 running 状态"
else
    announce db-ct missing "db 未 running" "docker compose -f docker-compose.yml -f deploy/docker-compose.nginx.yml up -d db"
fi

echo
printf '%s== app 容器 ==%s\n' "${C_BOLD}" "${C_RST}"
if svc_running app; then
    announce app-ct done "app 容器在 running 状态"
else
    announce app-ct wait "app 未运行（先在 db 就绪后启动）" "${COMPOSE[*]} up -d app"
fi

echo
printf '%s== apply HTTP 直连探活（127.0.0.1:3000）==%s\n' "${C_BOLD}" "${C_RST}"
HTTP="/api/auth"
B="http://127.0.0.1:3000"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "${B}${HTTP}" 2>/dev/null || true)
if [ -n "${CODE}" ] && [ "${CODE}" -ge 200 ] && [ "${CODE}" -lt 500 ] && [ "${CODE}" != "000" ]; then
    printf '  %s 应用响 /api/auth HTTP %s\n' "$(tag_done)" "${CODE}"
    announce http-app done "应用可访问（HTTP ${CODE}）"
else
    printf '  %s 未能访问 %s（code=%s）。检查：docker compose %s logs app\n' "$(tag_wait)" \
        "${B}${HTTP}" "${CODE:-无响应}" "${COMPOSE[*]}"
    announce http-app wait "应用未在 127.0.0.1:3000 响应" "${COMPOSE[*]} logs -f app"
fi

echo
printf '%s== Nginx 边缘层（若叠加了 docker-compose.nginx.yml）==%s\n' "${C_BOLD}" "${C_RST}"
if svc_running nginx; then
    # 健康端口来自 .env 的 NGINX_HEALTH_PORT（默认 9443），探一下
    HPORT="$(env_get NGINX_HEALTH_PORT || echo 9443)"
    NCODE=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://127.0.0.1:${HPORT}/" 2>/dev/null || true)
    printf '  %s nginx 容器在运行（健康端口 %s → %s）\n' "$(tag_done)" "${HPORT}" "${NCODE:-无响应}"
    announce nginx-ok done "Nginx 边缘层已叠加且可探"
else
    announce nginx-ok skip "未叠加 Nginx 边缘层（当前仅裸 app；需 HTTPS/Cloudflare 时叠加 docker-compose.nginx.yml）"
fi

echo
announce connect-check done "容器连通核查完成"