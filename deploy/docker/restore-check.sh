#!/usr/bin/env bash
# ============================================================================
# 备份恢复演练（Docker Compose 版）
#
# 为什么这个脚本必须存在：
# "备份文件存在、大小正常"和"能还原出可用的数据"是两件事。
# 磁盘损坏、pg_dump 中途出错、PostgreSQL 大版本升级、权限变更，
# 都会让备份悄悄变成废文件——而真到需要恢复那天才发现，就来不及了。
#
# **没跑过还原的备份不算备份。**
#
# 本脚本每月自动跑一次：把最新备份真正还原到临时库，逐表确认数据在，然后删掉临时库。
# 退出码非 0 = 备份不可用，需要立即处理。
#
# 手工执行：
#   bash deploy/docker/restore-check.sh
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${APP_ROOT}"

BACKUP_DIR="${BACKUP_DIR:-${APP_ROOT}/data/backups/db}"

# ---- 与 docker compose 读同一份 .env（若存在）--------------------------------
# 见 backup.sh 同段注释：宿主机 shell 不会自动加载 .env，这里与 compose
# 用同一取值口径，避免在改了 POSTGRES_USER/DB 后备份与演练对不上号。
ENV_FILE="${APP_ROOT}/.env"
if [ -f "${ENV_FILE}" ]; then
    _db_user="$(grep -E '^POSTGRES_USER=' "${ENV_FILE}" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
    _db_name="$(grep -E '^POSTGRES_DB=' "${ENV_FILE}" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
    [ -n "${_db_user}" ] && DB_USER="${_db_user}"
    [ -n "${_db_name}" ] && DB_NAME="${_db_name}"
fi
DB_NAME="${DB_NAME:-aura}"
DB_USER="${DB_USER:-aura}"
TEMP_DB="${DB_NAME}_restore_check"
COMPOSE_BASE="${COMPOSE:-docker compose -f docker-compose.yml -f deploy/docker-compose.nginx.yml}"

log() { printf '[restore-check] %s\n' "$*"; }
die() { printf '[restore-check] 失败：%s\n' "$*" >&2; exit 1; }

if ! ${COMPOSE_BASE} ps --status running --services 2>/dev/null | grep -qx db; then
    die "db 容器未运行，无法演练。先检查：${COMPOSE_BASE} ps"
fi

# ---- 选取最新备份 ------------------------------------------------------------
# 用 find + sort 按修改时间排序，不解析 ls 输出（文件名格式可能被人为改动）。
DUMP="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'aura-*.dump' -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -n1 | cut -d' ' -f2- || true)"

[ -n "${DUMP}" ] || die "${BACKUP_DIR} 下没有任何备份文件（备份任务可能从未成功执行过）"
log "演练使用备份：${DUMP}（$(du -h "${DUMP}" | cut -f1)）"

# ---- 校验和 ------------------------------------------------------------------
# 损坏的文件不必浪费一次还原。
if [ -f "${DUMP}.sha256" ]; then
    (cd "${BACKUP_DIR}" && sha256sum -c "$(basename "${DUMP}").sha256" >/dev/null) \
        || die "校验和不匹配，备份文件已损坏：${DUMP}"
    log "校验和通过"
else
    log "⚠️ 该备份没有 .sha256 文件，跳过校验和检查"
fi

# ---- 清理函数（无论成功失败都执行）------------------------------------------
cleanup() {
    ${COMPOSE_BASE} exec -T db dropdb -U "${DB_USER}" --if-exists "${TEMP_DB}" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

# ---- 真正还原 ----------------------------------------------------------------
# createdb -T template0：不带默认模板里的扩展，避免还原时与目标库扩展冲突。
log "创建临时库 ${TEMP_DB} 并还原（约需几十秒，取决于数据量）"
${COMPOSE_BASE} exec -T db createdb -U "${DB_USER}" -T template0 "${TEMP_DB}"

# ⚠️ 必须「复制进容器 + 按路径传参」，不能把 dump 灌到 stdin：
# pg_restore 的自定义格式需要 seekable 文件才能正确解析（实测
# `pg_restore --list < file` 退出码为 1）。真正需要灾难恢复时也必须这么走。
DB_CID="$(${COMPOSE_BASE} ps -q db 2>/dev/null || true)"
[ -n "${DB_CID}" ] || die "拿不到 db 容器 ID，无法执行还原"

RESTORE_FILE="/tmp/aura-restore-check-$$.dump"
docker cp "${DUMP}" "${DB_CID}:${RESTORE_FILE}" >/dev/null 2>&1 \
    || die "无法把备份复制进 db 容器（备份文件：${DUMP}）"

# --clean --if-exists：备份含 --clean --if-exists 语义时才能安全还原
if ! docker exec "${DB_CID}" pg_restore -U "${DB_USER}" -d "${TEMP_DB}" \
        --no-owner --no-privileges --clean --if-exists "${RESTORE_FILE}" \
        > /dev/null 2>&1; then
    docker exec "${DB_CID}" rm -f "${RESTORE_FILE}" >/dev/null 2>&1 || true
    die "pg_restore 还原失败，备份不可用"
fi
docker exec "${DB_CID}" rm -f "${RESTORE_FILE}" >/dev/null 2>&1 || true

# ---- 逐表确认数据真的回来了 --------------------------------------------------
# 只建了空表的还原同样不算成功，所以要数行数。
# 表名与 src/db/schema.ts 中 pgTable() 的字符串保持一致（snake_case）。
echo
log "逐表核对行数："
check_table() {
    local table="$1"
    local rows
    rows="$(${COMPOSE_BASE} exec -T db psql -U "${DB_USER}" -tAc \
            "select count(*) from \"${table}\"" -d "${TEMP_DB}" 2>/dev/null | tr -d '\r')"
    if [ -z "${rows}" ]; then
        die "表 ${table} 不存在或无法查询——备份内容与当前 schema 不匹配（可能数据库升级过）"
    fi
    printf '    %-22s %s 行\n' "${table}" "${rows}"
    echo "${rows}"
}

echo "--- 关键业务表（必须有数据）---"
PLANS_ROWS="$(check_table plans | tail -1)"
ADMINS_ROWS="$(check_table admins | tail -1)"

echo
echo "--- 其他表（可能为空，仅确认存在）---"
for t in orders payment_settings users card_keys coupons categories \
         recharge_events payment_transactions system_versions announcements; do
    ${COMPOSE_BASE} exec -T db psql -U "${DB_USER}" -tAc \
        "select count(*) from \"${t}\"" -d "${TEMP_DB}" >/dev/null 2>&1 \
        && printf '    %-22s 存在\n' "${t}" \
        || printf '    %-22s ⚠️ 缺失\n' "${t}"
done

# ---- 判定 --------------------------------------------------------------------
# admins 表必须有至少1 个管理员：没有它，备份还原出来也进不了后台，
# 等于没有可用副本。plans 为空同理（站点无内容）。
if [ "${ADMINS_ROWS:-0}" -lt 1 ]; then
    die "admins 表为空——还原后无法登录后台，该备份不可用于灾难恢复"
fi
# plans 之前只数行没判定：一个"空套餐库"的备份还原后站点什么都卖不了，
# 同样不可用。至少要有 1 个套餐（默认播种会写入）。
if [ -z "${PLANS_ROWS}" ] || [ "${PLANS_ROWS}" -lt 1 ]; then
    die "plans 表为空——还原后站点无可售套餐，该备份可能来自未完成初始化的库"
fi

echo
log "✓ 演练通过：备份可正常还原，且关键数据完整"
log "  临时库 ${TEMP_DB} 将在脚本退出时自动清理"
echo
log "  ══ 真正需要恢复时，按下面三步走 ══"
log "  1) 把备份复制进db 容器（pg_restore 必须读容器内的真实文件，不能用管道）："
log "     docker cp ${DUMP} \$(docker compose -f docker-compose.yml -f deploy/docker-compose.nginx.yml ps -q db):/tmp/restore.dump"
log "  2) 还原（--clean 会先删同对象，务必确认这是你要的库）："
log "     docker exec -it \$(docker compose -f docker-compose.yml -f deploy/docker-compose.nginx.yml ps -q db) \\"
log "       pg_restore -U ${DB_USER} -d ${DB_NAME} --clean --if-exists /tmp/restore.dump"
log "  3) 删掉容器内的临时文件："
log "     docker exec \$(docker compose -f docker-compose.yml -f deploy/docker-compose.nginx.yml ps -q db) rm -f /tmp/restore.dump"
echo
log "  完整步骤见 docs/应急恢复手册.md"