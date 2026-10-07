#!/usr/bin/env bash
# ============================================================================
# db-review.sh — 数据库设计与健康检查（进 db 容器）
#
# 逐项核查：关键表是否存在、外键约束、批量索引、部分唯一索引（幂等保证）、
# 自定义函数/过程是否存在。只读，不做任何写库操作。
#
# 用法：bash deploy/doctor/checks/db-review.sh
# 被 aura-doctor.sh 收拢；也可独立执行。
# ============================================================================
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/../engine.sh"

[ "${#COMPOSE[@]}" -ge 1 ] || doc_die "docker compose 不可用，无法检查数据库。"
svc_running db || { announce db-stop missing "db 容器未运行，先：${COMPOSE[*]} up -d db"; exit 1; }

load_env_pg || true
_psql() { "${COMPOSE[@]}" exec -T db psql -U "${PG_USER}" -d "${PG_DB}" -Atqc "$1" 2>/dev/null; }

echo
printf '%s== db 基础连通 ==%s\n' "${C_BOLD}" "${C_RST}"
if [ -n "$(_psql "SELECT 1;")" ]; then
    announce db-connect done "db 容器可连通（SELECT 1 通过）"
else
    announce db-connect missing "无法登录数据库，核对 .env 的 POSTGRES_PASSWORD 与容器日志"
    exit 1
fi
VER="$(_psql "SHOW server_version;")"
doc_log "PostgreSQL 版本：${VER:-未知}"

# ---- 表存在性（应能见到足以支撑业务的核心表） -------------------------------
echo
printf '%s== 核心表存在性 ==%s\n' "${C_BOLD}" "${C_RST}"
MISS=0
for t in plans orders card_keys admins users coupon_redemptions recharge_jobs payment_transactions payment_settings coupons categories cdk_settings upstream_config system_versions announcements; do
    if [ -n "$(_psql "SELECT to_regclass('public.${t}');")" ]; then
        printf '  %s %s\n' "$(tag_done)" "${t}"
    else
        printf '  %s %s\n' "$(tag_missing)" "${t}"
        MISS=1
    fi
done
if [ "${MISS}" -eq 1 ]; then
    announce schema-core missing "有核心表缺失（应先执行 init.sh 第 3 步 drizzle push）" \
        "docker compose exec -T app npx drizzle-kit push"
else
    announce schema-core done "核心表齐备"
fi

# ---- 外键（数据一致性关键）--------------------------------------------------
echo
printf '%s== 外键约束 ==%s\n' "${C_BOLD}" "${C_RST}"
FK_COUNT=$(_psql "SELECT count(*) FROM pg_constraint WHERE contype='f';")
echo "  外键总数：${FK_COUNT:-0}"
# 抽样列出 orders 相关的引用关系
_psql "SELECT conrelid::regclass||' -> '||confrelid::regclass FROM pg_constraint WHERE contype='f' AND conrelid IN ('orders'::regclass,'card_keys'::regclass,'recharge_jobs'::regclass) ORDER BY 1;" \
  | sed 's/^/      /' | head -20
[ -n "${FK_COUNT}" ] && [ "${FK_COUNT}" -gt 0 ] \
  && announce fk-present done "外键已建立(${FK_COUNT} 个)" \
  || announce fk-present missing "外键为 0：请确认 schema 定义中 references 关系已生效"

# ---- 索引健康：查关键表索引数 + 幂等所用的部分唯一索引 -------------------------
echo
echo "== 关键表索引数 =="
for t in orders recharge_jobs card_keys coupon_redemptions; do
    n=$(_psql "SELECT count(*) FROM pg_indexes WHERE tablename='${t}';")
    printf '  %-18s %s\n' "${t}" "${n}"
done
echo
echo "== 幂等关键索引（部分唯一，保证充值/领卡并发不重复） =="
PART=$(_psql "SELECT indexname FROM pg_indexes WHERE indexdef ILIKE '%UNIQUE%WHERE%' ORDER BY 1;" | tr '\n' ' ')
if [ -n "${PART}" ]; then
    for n in ${PART}; do printf '  %s\n' "${n}"; done
    announce idx-part done "存在部分唯一索引：${PART}"
else
    announce idx-part missing "未发现任何部分唯一索引（项目靠它保证幂等，请让运营核对 schema.ts）"
fi

PK_ORDER=$(_psql "SELECT count(*) FROM pg_indexes WHERE tablename='orders' AND indexdef ILIKE '%UNIQUE%';")
echo "  orders 唯一索引数：${PK_ORDER}"

# ---- 自定义函数 / 存储过程 / 触发器 ----
echo
echo "== 自定义对象（存储函数/过程/触发器） =="
FNS=$(_psql "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND NOT p.proisinternal;")
TRG=$(_psql "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text NOT LIKE 'pi%';")
if [ -n "${FNS}" ]; then
    echo "  函数/过程:"
    echo "${FNS}" | sed 's/^/    /'
else
    echo "  函数/过程: （无自定义存储函数/过程 —— 本项目无存储过程依赖，业务逻辑在应用层，属正常）"
fi
if [ -n "${TRG}" ]; then
    echo "  触发器:"
    echo "${TRG}" | sed 's/^/    /'
else
    echo "  触发器: （无 —— 业务一致性由应用层事务+CAS 保证，属预期）"
fi
announce db-design done "数据库结构与健康核查完成（只读，未改动任何表）"