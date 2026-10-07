#!/usr/bin/env bash
# ============================================================================
# haiou 数据库备份（Docker Compose 版）
#
# Docker 部署下宿主机**没有** PG 可执行文件，必须进容器操作 pg_dump。
#
# 由 cron 或 systemd timer 调用，也可手工执行：
#   bash deploy/docker/backup.sh
#
# 环境变量（都有合理默认值，通常不用改）：
#   BACKUP_DIR  备份落盘目录，默认 ./data/backups/db
#   KEEP_DAYS   保留天数，默认 14
#   COMPOSE     compose 命令，默认 docker compose（+ 两份文件）
# ============================================================================
set -euo pipefail

# ---- 定位项目根 --------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${APP_ROOT}"

BACKUP_DIR="${BACKUP_DIR:-${APP_ROOT}/data/backups/db}"
KEEP_DAYS="${KEEP_DAYS:-14}"

# ---- 与 docker compose 读同一份 .env（若存在）--------------------------------
# docker compose 会自动加载项目根目录的 .env 来解析 ${POSTGRES_*}，但**宿主机上的
# 这个 shell 不会**。若运营在 .env 里把 POSTGRES_USER 改成了非默认值，而这里仍按
# 默认 haiou 去 pg_dump，备份会在「USER 名对不上」时失败——或更糟：一旦 docker 镜像
# 里恰好存在同名的简化认证，会备份到**错误的一个角色**。
# 这里只取 PG 相关键（不 export 密码，避免被子进程/日志带出去），与 compose 的
# 取值口径保持一致。注意：--env-file 的变量本身仍不会被 export，加减号需谨慎。
ENV_FILE="${APP_ROOT}/.env"
if [ -f "${ENV_FILE}" ]; then
    # shellcheck disable=SC1090
    # 缺键（grep 无匹配）时 pipeline 返回非零，会因 set -e 把脚本整体闷掉——
    # 加上 `|| true` 让缺键=空，由下方默认值兜底，而不是静默 abort（现实里
    # 某些机器 .env 是精简版，没有 POSTGRES_* 键，遇到就直接死了）。
    _db_user="$(grep -E '^POSTGRES_USER=' "${ENV_FILE}" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')" || true
    _db_name="$(grep -E '^POSTGRES_DB=' "${ENV_FILE}" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')" || true
    [ -n "${_db_user}" ] && DB_USER="${_db_user}"
    [ -n "${_db_name}" ] && DB_NAME="${_db_name}"
fi
DB_NAME="${DB_NAME:-haiou}"
DB_USER="${DB_USER:-haiou}"

# compose 命令：优先用带覆盖文件的方式（这样能正确解析 nginx 服务，
# 但备份只需要 db，所以即使 nginx 没起来也能用）。
COMPOSE_BASE="${COMPOSE:-docker compose -f docker-compose.yml -f deploy/docker-compose.nginx.yml}"

log() { printf '[backup] %s\n' "$*"; }
die() { printf '[backup] 错误：%s\n' "$*" >&2; exit 1; }

# ---- 前置检查 ----------------------------------------------------------------
# 容器没起来就备份 = 备份了个空，所以先确认 db 真的在跑。
if ! ${COMPOSE_BASE} ps --status running --services 2>/dev/null | grep -qx db; then
    die "db 容器未运行，无法备份。先检查：${COMPOSE_BASE} ps"
fi

# ---- 备份目录准备 + 友好可写自检（常说"该去哪建终于说清")-------------------
# 目录不可达/不可写属于最易被静默吞掉的故障。这里先尝试创建（放 if 里避免
# set -e 在 mkdir 失败时把脚本一路闷掉），再友好地给错误码 + 该在哪建。
if ! mkdir -p "${BACKUP_DIR}" 2>/dev/null; then
    printf '[backup] 错误 MF_001：备份目录创建失败：%s\n' "${BACKUP_DIR}" >&2
    printf '[backup]     请先创建并收紧权限：\n' >&2
    printf '[backup]         mkdir -p "%s" && chmod 0700 "%s"\n' "${BACKUP_DIR}" "${BACKUP_DIR}" >&2
    printf '[backup]     （若目录在只读挂载点上，请改 BACKUP_DIR 指向可写位置）\n' >&2
    printf '[backup] 本次备份中止，未生成任何文件。\n' >&2
    exit 1
fi
# 备份文件可能含用户邮箱、订单号，必须限制访问权限
chmod 0700 "${BACKUP_DIR}"

if [ ! -w "${BACKUP_DIR}" ]; then
    printf '[backup] 错误 QX_001：备份目录存在但不可写：%s\n' "${BACKUP_DIR}" >&2
    printf '[backup]     请检查属主：ls -ld "%s"\n' "${BACKUP_DIR}" >&2
    printf '[backup]     修正：chown -R <运行用户>:<用户组> "%s"（或 chmod u+w）\n' "${BACKUP_DIR}" >&2
    exit 1
fi

STAMP="$(date +%F-%H%M%S)"
FILE="${BACKUP_DIR}/haiou-${STAMP}.dump"

# ---- 执行备份 ----------------------------------------------------------------
# pg_dump -Fc：自定义格式，压缩且可选择性恢复（比纯 SQL 快得多）。
#
# 为什么不在宿主机直接 dump：需要 PG 客户端二进制，而容器里已经有了，
# 省去"宿主机 PG 版本与容器不匹配"这个经典坑。
#
# 用 --clean --if-exists 让备份可安全恢复到已有库（会先删同名对象）。
log "开始备份数据库 ${DB_NAME} → ${FILE}"
if ! ${COMPOSE_BASE} exec -T db pg_dump \
      -U "${DB_USER}" \
      -d "${DB_NAME}" \
      -Fc --clean --if-exists \
      > "${FILE}.tmp"; then
    # pg_dump 失败时可能留下半截文件，必须删掉——
    # 否则它会被"最近一份备份"的逻辑选中，演练时才暴露问题。
    rm -f "${FILE}.tmp"
    die "pg_dump 执行失败（未留下残缺文件）"
fi

# 先落盘为正式文件名，再对它做校验和与结构校验
# （顺序很重要：若先写 sha256 再 mv，.sha256 里记录的是 .tmp 的文件名，
#   且 docker cp 时文件还没 mv，会引用不到正式名——历史踩过这类顺序坑）
mv "${FILE}.tmp" "${FILE}"

# 校验和：备份文件损坏时能立刻发现，而不是等到真要恢复那天
sha256sum "${FILE}" > "${FILE}.sha256"

# ---- 结构校验 ---------------------------------------------------------------
# 立刻验证 dump 文件结构完整（只解析目录，不实际还原，很快）。
#
# ⚠️ 必须用「复制进容器 + 按路径传参」，**不能**把文件灌到 stdin：
# pg_restore 的自定义格式需要 seekable 文件才能解析目录，从管道读会失败。
# 实测确认 `pg_restore --list < file` 退出码为 1（假失败，会让每次备份都误报异常）。
# 真正的灾难恢复也必须用这个方式，照着做才不会在最急的时候踩坑。
DB_CID="$(${COMPOSE_BASE} ps -q db 2>/dev/null || true)"
[ -n "${DB_CID}" ] || die "拿不到 db 容器 ID，无法执行结构校验"

CHECK_FILE="/tmp/haiou-check-$$.dump"
if ! docker cp "${FILE}" "${DB_CID}:${CHECK_FILE}" >/dev/null 2>&1; then
    die "无法把备份复制进 db 容器以校验结构（备份文件已保留：${FILE}）"
fi

if ! docker exec "${DB_CID}" pg_restore --list "${CHECK_FILE}" >/dev/null 2>&1; then
    docker exec "${DB_CID}" rm -f "${CHECK_FILE}" >/dev/null 2>&1 || true
    die "备份文件结构校验失败（pg_restore --list 无法解析），已保留文件供人工检查：${FILE}"
fi
docker exec "${DB_CID}" rm -f "${CHECK_FILE}" >/dev/null 2>&1 || true
log "备份文件结构校验通过（目录可完整解析）"

SIZE="$(du -h "${FILE}" | cut -f1)"
log "备份完成：${FILE}（${SIZE}）"

# ---- 清理过期备份 ------------------------------------------------------------
# 用 -mtime "+${KEEP_DAYS}"：严格大于 N 天，避免刚生成的文件被误删。
DELETED="$(find "${BACKUP_DIR}" -type f -name 'haiou-*.dump*' -mtime "+${KEEP_DAYS}" -delete -print | wc -l)"
[ "${DELETED}" -gt 0 ] && log "已清理 ${DELETED} 个过期备份（保留 ${KEEP_DAYS} 天）"

# ---- 磁盘空间自检 ------------------------------------------------------------
# 备份目录和数据库在同一个盘上。盘满时 PostgreSQL 会拒绝写入，
# 表现为"数据库突然只读"，比备份失败更难排查。
# 超过 85% 就警告，让人去清理或扩盘。
USED_PCT="$(df "${BACKUP_DIR}" | tail -1 | awk '{gsub(/%/,"",$5); print $5}')"
if [ "${USED_PCT:-0}" -ge 85 ]; then
    printf '[backup] ⚠️ 警告：磁盘已用 %s%%（阈值 85%%）。\n' "${USED_PCT}" >&2
    printf '[backup]    盘满会导致 PostgreSQL 拒绝写入、数据库变成只读。\n' >&2
    printf '[backup]    请清理旧备份或扩盘。\n' >&2
fi

# ---- 最近备份信息（便于监控/面板联动）---------------------------------------
LATEST="$(find "${BACKUP_DIR}" -maxdepth 1 -name 'haiou-*.dump' -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2- || true)"
if [ -n "${LATEST}" ]; then
    log "最新备份：${LATEST}（$(date -r "${LATEST}" '+%F %T')）"
else
    die "备份目录内没有任何 .dump 文件，备份流程可能已失效"
fi

# ---- 离机转移（按需，OPS_OFFSITE_TRANSFER 配置后才执行）----------------------
# 用户关注点：①全量/定时转 ②转走后本地要不要清。
#   答复：用 rsync/rclone **增量**传输（--delete 会同步删除远端过期旧件，
#   但**不清本地**）。本地副本始终保留做 3-2-1 的第一份，远端是第二份；二者并存。
#   容器内没有备份文件——备份本来就落盘在宿主 data/backups/db，故"转走后清容器"
#   不适用，无需清理（若真要清容器/临时产物，那是部署内部的 /tmp，交给应用自己）。
#
# 配置示例（写入运行用户的 ~/.bashrc 或在调用前 export）：
#   export OPS_OFFSITE_TRANS="rsync -az --delete ${BACKUP_DIR}/ backup@你的另一台:/backup/haiou/"
#   export OPS_OFFSITE_TRANS="rclone copy ${BACKUP_DIR} remote:haiou-backups/db --include 'haiou-*.dump*'"
# ⚠️ 配了务必手工先跑一次确认文件真到远端，否则"以为备份了"最致命。
OTS=""
if [ -z "${OPS_OFFSITE_TRANS:-}" ] && [ -f "${ENV_FILE}" ]; then
    OTS="$(grep -E '^OPS_OFFSITE_TRANS=' "${ENV_FILE}" | tail -1 | cut -d= -f2- || true)"
fi
if [ -z "${OPS_OFFSITE_TRANS:-}" ] && [ -z "${OTS:-}" ]; then
    log "提示：离机副本未配置（OPS_OFFSITE_TRANS 未设）。同盘备份防不了磁盘故障；建议配置 rsync/rclone。"
    OFFSITE_STAT="offsite=off"
else
    TRANS="$( [ -n "${OPS_OFFSITE_TRANS:-}" ] && printf '%s' "${OPS_OFFSITE_TRANS}" || printf '%s' "${OTS}" )"
    log "执行离机转移：${TRANS}"
    if eval "${TRANS}" 2>/dev/null; then
        log "离机转移成功。本地副本保留未删（3-2-1 第一份），远端为第二份。"
        OFFSITE_STAT="offsite=ok"
    else
        log "离机转移失败。请检查远端可达性与凭据；本地备份早已保留，不影响本次备份本身。" >&2
        OFFSITE_STAT="offsite=fail"
    fi
fi

# ---- 口：写状态文件，供 status.sh / 运维面板 / 监控联动 ----------------------
STATE_DIR="${STATE_DIR:-${APP_ROOT}/data/doctor}"
mkdir -p "${STATE_DIR}"
cat > "${STATE_DIR}/backup.state" <<EOF
generated_ts=$(date +%s)
generated=$(date '+%F %T')
latest=${LATEST}
size=$(du -h "${LATEST}" 2>/dev/null | cut -f1)
${OFFSITE_STAT}
EOF
chmod 0600 "${STATE_DIR}/backup.state"
log "已写备份状态文件：${STATE_DIR}/backup.state"

log "备份流程完成（本地副本保留；离机${OFFSITE_STAT}）。"