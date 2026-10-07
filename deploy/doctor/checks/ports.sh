#!/usr/bin/env bash
# ============================================================================
# ports.sh — 端口开放与安全暴露核查（只读）
#
# 目标：把「系统通起来」必备的端口核查，从"只读列监听"升级为安全体检。
# 三类核查：
#   A. 关键端口确实在监听（app 3000 / nginx 80·443·8443 / db 5432）
#   B. db 5432 监听面是否过宽（绝不该 bind 0.0.0.0/::: —— 那是把数据库裸露出去）
#   C. 防火墙/安全组放行状态 + 公网可达性判定（Cloudflare 场景下，源站回源
#      端口 8443 应「只对 CF 网段开」，否则等于没隐藏源站 IP）
#
# 只读，不改任何配置。可单独跑：bash deploy/doctor/checks/ports.sh
# 也会被 haiou-doctor.sh（--only=ports）串入全量体检。
# 关联：deploy/运维总控.md；docs/部署操作手册.md §5.4（隐藏源站 IP）。
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../engine.sh"

PORT_HTTP=80
PORT_HTTPS=443
PORT_CF=8443            # Cloudflare 回源专用（.env 可覆盖）
PORT_APP=3000
PORT_DB=5432

_cfguard="$(env_get NGINX_CF_GUARD_PORT || true)"
[ -n "${_cfguard:-}" ] && [ "${_cfguard}" != "0" ] && PORT_CF="${_cfguard}"

# ---- 端口工具优先 ss，回退 netstat -------------------------------------------
# 返回监听端口地址（含监听面）。优先 ss；其次读 /proc/net/tcp(/6)（Linux 原生，
# 无 ss/netstat 也准）；最后 netstat。返回如 0.0.0.0:443 / 127.0.0.1:3000 / [::]:5432 / 空。
listener_addr() { # $1=port
    local port="$1"
    local hex
    hex="$(printf '%04X' "${port}")"   # 端口转 16 位大写 hex，与 /proc/net/tcp 一致
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | awk -v hp="${hex}" '$4 ~ (":" hp "$"){print $4}' | head -1
        return 0
    fi
    # Linux /proc/net/tcp（监听行 STATE=0A）。第2列 local_address=hex:hex
    awk -v p="${hex}" 'NR>1 && $4=="0A" {split($2,a,":"); if (a[2]==p) {print a[1]" (proc)"; exit}}' \
        /proc/net/tcp 2>/dev/null | head -1 && return 0
    awk -v p="${hex}" 'NR>1 && $4=="0A" {split($2,a,":"); if (a[2]==p) {print a[1]" (proc6)"; exit}}' \
        /proc/net/tcp6 2>/dev/null | head -1 && return 0
    if command -v netstat >/dev/null 2>&1; then
        netstat -ltn 2>/dev/null | awk -v pp=":${port} " '$4 ~ pp{print $4; exit}'
    fi
    printf ''
}
port_on() { # $1=port ; 0=监听中
    [ -n "$(listener_addr "$1")" ]
}
# 判断某端口是否「全网段监听」（0.0.0.0 / :: / :::）
addr_is_wild() { # $1=监听地址
    printf '%s' "${1}" | grep -qE '^(0\.0\.0\.0|::|:::|\*)'
}

echo
printf '%s== A) 关键端口监听 ==%s\n' "${C_BOLD}" "${C_RST}"

# app 3000
if port_on "${PORT_APP}"; then
    announce port-app done "app 在 ${PORT_APP} 监听"
else
    announce port-app wait "app ${PORT_APP} 未监听（应用没起？）" "${COMPOSE[*]} up -d app"
fi

# nginx 443 / 80
if port_on "${PORT_HTTPS}"; then
    announce port-443 done "nginx ${PORT_HTTPS} 监听（HTTPS 对外）"
else
    announce port-443 wait "nginx ${PORT_HTTPS} 未监听（未上 HTTPS/Cloudflare，或 nginx 未起）" \
        "检查：bash deploy/doctor/haiou-doctor.sh --only=connect"
fi
if port_on "${PORT_HTTP}"; then
    announce port-80 done "nginx ${PORT_HTTP} 监听（→ 301 HTTPS）"
else
    announce port-80 wait "nginx ${PORT_HTTP} 未监听"
fi

# CF 回源端口 8443
if port_on "${PORT_CF}"; then
    announce port-8443 done "源站回源端口 ${PORT_CF} 已监听（CF 直连源站用）"
else
    announce port-8443 skip "源站回源端口 ${PORT_CF} 未监听（未启用拆分源站，CF 走 ${PORT_HTTPS}）"
fi

# ---- B) db 监听面（安全关键）--------------------------------------------------
echo
printf '%s== B) 数据库 5432 暴露核查 ==%s\n' "${C_BOLD}" "${C_RST}"
if port_on "${PORT_DB}"; then
    daddr="$(listener_addr "${PORT_DB}")"
    # 只取冒号前的地址部分再做通配判定（兼容 ss: "0.0.0.0:5432" 与 proc: "0100007F (proc)"）
    dhost="${daddr%%:*}"
    if addr_is_wild "${dhost}"; then
        announce port-db missing "db ${PORT_DB} 绑定 ${daddr}（通配监听）—— 数据库可能裸露到公网/全网段，高危！"
        echo "         应改为仅 127.0.0.1 或内网段；docker compose 不应给 db 映射公网端口。"
        echo "         核查：docker compose -f docker-compose.yml ps db  的 PORTS 列"
    else
        announce port-db done "db ${PORT_DB} 在 ${daddr} 监听（未绑 0.0.0.0，符合内网隔离）"
    fi
else
    announce port-db wait "db ${PORT_DB} 未在宿主机监听（正常 —— compose 通常不映射 db 端口，仅容器内互访）"
fi

# ---- C) 防火墙/安全组放行核查 ---------------------------------------------------
echo
printf '%s== C) 防火墙 / 安全组放行核查 ==%s\n' "${C_BOLD}" "${C_RST}"
fw_tool=""
{ command -v ufw >/dev/null 2>&1 && fw_tool="ufw"; } \
 || { command -v firewall-cmd >/dev/null 2>&1 && fw_tool="firewalld"; } \
 || { command -v nft >/dev/null 2>&1 && fw_tool="nftables"; } \
 || { command -v iptables >/dev/null 2>&1 && fw_tool="iptables"; }

case "${fw_tool}" in
    ufw)
        printf '  %s 检测到 ufw，规则如下（CHECK 80/443 是否 Allow，5432 是否 Deny）：\n' "$(tag_wait)"
        ufw status 2>/dev/null | sed 's/^/      /'
        ;;
    firewalld)
        printf '  %s 检测到 firewalld，放行清单如下：\n' "$(tag_wait)"
        echo "    ports与服务："
        firewall-cmd --list-ports 2>/dev/null | sed 's/^/      /'
        firewall-cmd --list-services 2>/dev/null | sed 's/^/      /'
        ;;
    nftables|iptables)
        printf '  %s 检测到 nftables/iptables（规则量大，只列 dport/DROP/ACCEPT 相关）：\n' "$(tag_wait)"
        if [ "${fw_tool}" = "nftables" ]; then
            nft list ruleset 2>/dev/null | grep -iE 'dport|reject|drop|accept' | head -15 | sed 's/^/      /' || true
        else
            iptables -S 2>/dev/null | grep -iE 'dport|DROP|ACCEPT' | head -15 | sed 's/^/      /' || true
        fi
        ;;
    *)
        printf '  %s 未检测到本机防火墙前端（ufw/firewalld/nft/iptables）——\n' "$(tag_wait)"
        echo "         可能是：①云安全组在承担放行（此时上面看不到规则是正常的）"
        echo "         ②裸网无防护（高危，务必用云安全组只放 CF 段）"
        ;;
esac

# 云安全组在服务器侧不可读，给出校验清单而非瞎猜
echo
echo "   [外网] 云安全组（阿里云/腾讯云/AWS SG）决定了公网最终可达性，请到控制台逐条核对："
echo "          · 80  入方向：只对 Cloudflare 段 → 301"
echo "          · 443 入方向：只对 Cloudflare 段（隐藏源站核心）"
echo "          · ${PORT_CF} 回源：只对 Cloudflare 段（用拆分源站时必做，否则白拆）"
echo "          · 5432 绝对不放公网（db 只 127.0.0.1 / 内网段）"
echo "          放行越少攻击面越小——除非回源需要，不要对 0.0.0.0/0 开任何非 80/443 端口。"
echo "          （CF 官方IP段：https://www.cloudflare.com/ips/ ，2026-10 核对见 部署操作手册 §3.2）"

# ---- D) 公网可达性判定（监听 × 防火墙 × 关键危险项）----------------------------
echo
printf '%s== D) 安全判定汇总 ==%s\n' "${C_BOLD}" "${C_RST}"
# db 万能对外监听已在上方 B）标红；这里只给一条总原则与结论
echo "     对外应只需 80/443（± CF 回源 ${PORT_CF}）。多开一个公网端口 = 多一个攻击面。"
echo "     若上面任一端口被标【未配置】，优先核：docker 映射 / 防火墙 / 云安全组 三层。"
echo
announce ports-check done "端口与防火墙安全核查完成"