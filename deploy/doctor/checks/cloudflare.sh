#!/usr/bin/env bash
# ============================================================================
# cloudflare.sh — Cloudflare 接入校验（前端/后端/数据库的正确映射）
#
# 核心诉求：确保 CDN 之下「真实客户端 IP 能穿透到应用」且「各子映射不打架」。
# 检查点：
#   A. TRUSTED_PROXY_HOPS 与 Cloudflare 的匹配（CF 下必须 0）
#   B. realip 模板存在 & 指向 CF 网段
#   C. 站点域名/SITE_URL 是否配置
#   D. 逻辑链路自检（edge → nginx(realip) → app(受限) → db）的口径说明
# 只读，不改配置；给出修复命令。
#
# 用法：bash deploy/doctor/checks/cloudflare.sh
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../engine.sh"

NK="deploy/docker/nginx/templates/conf.d/00-cloudflare-realip.conf.template"
REALIP_FILE="${APP_ROOT}/${NK}"

echo
printf '%s== A. 代理跳数（CF 下必须 TRUSTED_PROXY_HOPS=0）==%s\n' "${C_BOLD}" "${C_RST}"
HOPS="$(env_get TRUSTED_PROXY_HOPS || echo 0)"
if [ "${HOPS}" = "0" ]; then
    announce cf-hops done "TRUSTED_PROXY_HOPS=0（CF 正确：应用只认 realip 写出的 X-Real-IP）"
else
    printf '  %s TRUSTED_PROXY_HOPS=%s —— 若已挂 CF，这会取到 CF 边缘 IP，导致全站共用一个限流桶\n' "$(tag_missing)" "${HOPS}"
    announce cf-hops missing "TRUSTED_PROXY_HOPS=${HOPS}（应改为 0）" \
        "在 ${ENV_FILE} 设 TRUSTED_PROXY_HOPS=0 后重启 app"
fi

echo
printf '%s== [B] realip 模板与 CF 网段 ==%s\n' "${C_BOLD}" "${C_RST}"
if [ -f "${REALIP_FILE}" ]; then
    # 模板里是否存在 acknowledge CF 段的 set_real_ip_from
    if grep -qE 'set_real_ip_from|real_ip_header' "${REALIP_FILE}"; then
        announce cf-realip done "realip 模板存在且含 set_real_ip_from（对应 nginx 由它恢复真实 IP）"
        grep -E '^ *(set_real_ip_from|real_ip_header|real_ip_recursive)' "${REALIP_FILE}" | sed 's/^/      /' | head -12 || true
    else
        announce cf-realip wait "realip 模板存在但未见 set_real_ip_from（确认模板内容正确）" \
            "cat ${NK}"
    fi
else
    announce cf-realip missing "缺少 realip 模板文件（${NK}）" \
        "请确认该模板被 nginx 挂载；若直连裸机（不经 CF）可忽略"
fi

echo
printf '%s== [C] 域名指向与 SITE_URL ==%s\n' "${C_BOLD}" "${C_RST}"
DOMAIN="$(env_get AURA_DOMAIN || echo '')"
SITE="$(env_get SITE_URL || echo '')"
_placeholder() { [ -z "$1" ] || echo "$1" | grep -qE '请改成|example|localhost|^https?://$'; }

if _placeholder "${DOMAIN}"; then
    printf '  %s AURA_DOMAIN 未配置/占位（nginx server_name 会落 default）\n' "$(tag_missing)"
    announce cf-domain missing "AURA_DOMAIN 未真正配置" \
        "在 ${ENV_FILE} 设 AURA_DOMAIN=你的域名 后重启 nginx/app"
else
    printf '  %s AURA_DOMAIN=%s\n' "$(tag_done)" "${DOMAIN}"
    announce cf-domain done "AURA_DOMAIN 已配置"
fi

if _placeholder "${SITE}"; then
    printf '  %s SITE_URL 未真正配置（对外绝对链接将退化）\n' "$(tag_wait)"
    announce cf-site wait "SITE_URL 未真正配置（可选优化）" "在 ${ENV_FILE} 设 SITE_URL=https://<你的域名>"
else
    printf '  %s SITE_URL=%s\n' "$(tag_done)" "${SITE}"
    announce cf-site done "SITE_URL 已配置"
fi

echo
printf '%s== [D] 链路口径（数据流）==%s\n' "${C_BOLD}" "${C_RST}"
cat <<'EOF'
  客户端 ──(HTTPS, 经Cloudflare)──▶ Nginx(realip 还原真实IP)
        ──X-Real-IP──▶ app(读X-Real-IP, 受 限流 保护)
        ──DATABASE_URL(db:5432, 仅内网──▶ PostgreSQL(不映射宿主端口)
关键：db 只在内网可达，公网 5432 不通（无 ports 映射）；若 mapping 出问题，
症状为「后台限流误伤全体」或「公网直连 5432」。上面两步连查即覆盖。
EOF
printf '%s  映射检查无强制错误；顺带确认真实 IP 已在 access.log 出现（非 173.245.x.x）即验证通过\n' "$(tag_done)"
announce cloudflare-ok done "Cloudflare 三条目的映射检查完成"