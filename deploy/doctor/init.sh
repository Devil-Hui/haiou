#!/usr/bin/env bash
# ============================================================================
# aura 首启向导（init）
#
# 面向拿到一台新服务器后的一站式进场脚本。遵循「最小权限 + 幂等 + 分步确认」：
#   · 未配安全门先配安全门（第一步，也是你最先要做的两件事之一）；
#   · 未配数据库密码就随机生成并替换 .env（不覆盖已填的有效值）；
#   · 创建 data/logs 并修正属主（容器写日志的硬前提）；
#   · 校验 docker compose、起 db、建表、创建管理员、起 app。
#
# 用法：
#   bash deploy/doctor/init.sh [--force-password] [--admin <用户名>]
#   --force-password : 即使 .env 已有密码也重新随机生成（轮换）
#   -a/--admin       : 指定管理员用户名（否则交互提问）
#
# 幂等：重复执行只补齐缺失步骤，不会破坏已就绪项；每一步都会写状态。
# 与 `aura-doctor.sh` 共用同一份 state，跑完后可用它体检。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/engine.sh"

FORCE_PW=0
ADMIN_NAME=""
while [ $# -gt 0 ]; do
    case "$1" in
        --force|--force-password) FORCE_PW=1 ;;
        -a|--admin) shift; ADMIN_NAME="${1:-}" ;;
        *) doc_die "未知参数：$1" ;;
    esac
    shift
done

# ============================================================================
# 第 0 步：安全门（最前置的两件事之一）
# ============================================================================
echo
printf '%s===> [0/9] 安全门（shell 看门密码）%s\n' "${C_BOLD}" "${C_RST}"
pub_gate_present() { [ -f "${GATE_DIR}/gate.hash" ]; }

if pub_gate_present; then
    announce sg-gate done "安全门已配置（${GATE_DIR}/gate.hash 存在）"
else
    announce sg-gate missing "安全门未配置（本套件所有查看/运维命令的门禁）"
    if gate_init; then
        announce sg-gate done "安全门已启用"
    else
        doc_warn "安全门未就绪，但继续进场（建议马上补：bash ${DOCTOR_DIR}/aura-doctor.sh --gate-set）"
        announce sg-gate skip "安全门跳过（进场继续）"
    fi
fi

# ============================================================================
# 第 1 步：.env 密码与令牌（第一步 · 也是你要提前准备的 2/2）
# ============================================================================
echo
printf '%s== %s 1/2 数据库与管理员令牌 .env %s\n' "${C_BOLD}" "${C_RST}" "${C_RST}"
NEED_PW=1
if [ -f "${ENV_FILE}" ]; then
    if env_get "POSTGRES_PASSWORD" | grep -qE '^(请改成强密码|change_me|example|)$'; then
        doc_log ".env 存在但 POSTGRES_PASSWORD 仍是占位符，将重新生成"
    elif [ "${FORCE_PW}" -eq 1 ]; then
        doc_log "处理 --force-password，重新生成数据库密码"
    else
        NEED_PW=0
        doc_log "POSTGRES_PASSWORD 已是有效值，跳过"
    fi
else
    doc_log "未发现 .env：将基于 .env.example 生成（占位键用随机值替换）"
fi

if [ "${NEED_PW}" -eq 1 ]; then
    NEW_PW="$(rand_token 24)"
    env_set "POSTGRES_PASSWORD" "${NEW_PW}"
    # 同步 DATABASE_URL —— 若 .env 里明确写了（含旧密码），要一并更新。
    CUR_URL="$(env_get DATABASE_URL || true)"
    if [ -n "${CUR_URL}" ] && echo "${CUR_URL}" | grep -q '://'; then
        # 替换 user:password@host 中间段
        NEW_URL="$(printf '%s' "${CUR_URL}" | sed -E 's#(//[^:]+:)[^@]*@#\1'"${NEW_PW}"'@#')"
        env_set "DATABASE_URL" "${NEW_URL}"
        doc_log "已同步 DATABASE_URL 中的数据库密码"
    fi
    doc_log "已生成强随机数据库密码（24 hex 位）并写入 .env，权限 600"
    doc_log "建议将它另存到离线处（本脚本不回显密码，也不写入任何日志）："
    doc_log "    例如新建 ~/.aura-keys 存档信息，并 chmod 600。"
    announce db-password done "数据库密码已生成"
else
    announce db-password done "数据库密码已存在且非占位"
fi

# ADMIN_SETUP_TOKEN
TOK="$(env_get ADMIN_SETUP_TOKEN || true)"
if [ -z "${TOK}" ] || echo "${TOK}" | grep -qE '^(请改成|change)' ; then
    env_set ADMIN_SETUP_TOKEN "$(rand_token '32')"
    doc_log "已生成 ADMIN_SETUP_TOKEN（32 hex 位随机串，写 .env）"
    announce admin-token done "管理员初始化令牌已配置"
else
    announce admin-token done "ADMIN_SETUP_TOKEN 已配置"
fi

# 首次创建 .env（从 example 补齐时，把全部占位换成空，避免踩 compose 必填的坑）
if [ ! -f "${ENV_FILE}" ]; then
    doc_die ".env 仍不存在（上一段应已生成）。请手动 cp .env.example .env 后重跑。"
fi

# ============================================================================
# 第 1.5 步：先建好全部数据目录并锁定（容器写日志/备份的硬前提）
# ============================================================================
echo
printf '%s== %s 数据目录清单（init 阶段先建好）==%s\n' "${C_BOLD}" "${C_RST}"
# 固定相对路径，全部落在项目根的 data/ 下（随项目搬走、不进 git）。
ALL_DIRS="${APP_ROOT}/data/postgres ${APP_ROOT}/data/logs ${APP_ROOT}/data/backups/db ${APP_ROOT}/data/doctor"
for d in ${ALL_DIRS}; do
    if mkdir -p "${d}" 2>/dev/null; then
        chmod 0700 "${d}" 2>/dev/null || true
        doc_log "  已确保目录存在并 0700：${d#${APP_ROOT}/}"
    else
        printf '  %s %s 创建失败（错误码 MF_001）\n' "$(tag_missing)" "${d#${APP_ROOT}/}"
        doc_warn "请先手动创建并锁定：mkdir -p \"${d}\" && chmod 0700 \"${d}\" "
    fi
done
if [ "$(id -u)" -eq 0 ]; then
    UID_NEEDED=1000
    [ "$(stat -c %u "${APP_ROOT}/data/logs" 2>/dev/null)" = "${UID_NEEDED}" ] \
      || { chown "${UID_NEEDED}":"${UID_NEEDED}" "${APP_ROOT}/data/logs" && doc_log "已修正 data/logs 属主为 1000:1000（容器内 node uid）"; }
else
    # 非 root 下可能改不了属主（sudo chown 1000:1000 data/logs），尤其 logs
    doc_warn "非 root 下无法校验/修正 data/logs 属主，请手动执行：sudo chown 1000:1000 ${APP_ROOT}/data/logs"
fi

# ============================================================================
# 第 2 步：docker compose 校验 + 起 db
# ============================================================================
echo
printf '%s== %s 2/2 [startup] docker compose %s==\n' "${C_BOLD}" "${C_RST}"
if [ "${#COMPOSE[@]}" -eq 0 ]; then
    announce compose-cmd missing "docker compose 不可用（缺 docker 或插件）"
    doc_die "本机没有 docker compose，无法继续。请先安装 Docker 后重跑。"
fi
"${COMPOSE[@]}" config >/dev/null 2>&1 \
  && announce compose-valid done "docker compose 配置可解析" \
  || { announce compose-valid missing "docker compose config 校验失败（请先修 .env）"; "${COMPOSE[@]}" config; exit 1; }

doc_log "启动数据库……"
"${COMPOSE[@]}" up -d db
for i in $(seq 1 60); do
    if "${COMPOSE[@]}" exec -T db pg_isready -U "$(env_get POSTGRES_USER || echo aura)" -d "$(env_get POSTGRES_DB || echo aura)" >/dev/null 2>&1; then
        announce db-running done "数据库已就绪（pg_isready 通过）"; break
    fi
    [ "$i" = 60 ] && { announce db-running missing "数据库 60s 未就绪，查看日志：${COMPOSE[*]} logs db"; exit 1; }
    sleep 1
done

# ============================================================================
# 第 3 步：建表（drizzle push）——必须在 app 起来前做
# ============================================================================
echo
printf '%s== %s schema: drizzle push ==%s\n' "${C_BOLD}" "${C_RST}"
# 通过 db 容器直查表是否存在（比依赖 app 起来更稳）
load_env_pg || true
_psql() { "${COMPOSE[@]}" exec -T db psql -U "${PG_USER}" -d "${PG_DB}" -Atqc "$1" 2>/dev/null; }
if [ -n "$(_psql "SELECT to_regclass('public.plans');")" ]; then
    announce schema-pushed done "数据表已存在（plans 表可见）"
else
    "${COMPOSE[@]}" up -d --no-deps app 2>/dev/null || true
    if "${COMPOSE[@]}" exec -T app npx drizzle-kit push 2>/dev/null; then
        announce schema-pushed done "数据表已建（drizzle-kit push 成功）"
    else
        announce schema-pushed missing "drizzle-kit push 未通过（请看上方报错）"
    fi
fi

# ============================================================================
# 第 4 步：创建管理员
# ============================================================================
echo
printf '%s== %s [admin]==%s\n' "${C_BOLD}" "${C_RST}"
if [ -n "$(_psql "SELECT to_regclass('public.admins');")" ] \
   && [ -n "$(_psql "SELECT id FROM public.admins LIMIT 1;")" ]; then
    announce admin-created done "管理员已存在"
else
    doc_warn "未发现管理员。请在 app 容器内创建（交互、密码不回显）："
    doc_log "    ${COMPOSE[*]} exec -it app node_modules/.bin/tsx scripts/create-admin.mjs"
    doc_log "    或：npm run admin:create"
    doc_log "创建完成后请重跑 aura-doctor 验证。"
    announce admin-created wait "管理员待创建（见上方引导）" "docker compose -f docker-compose.yml -f deploy/docker-compose.nginx.yml exec -it app node_modules/.bin/tsx scripts/create-admin.mjs"
fi

# ============================================================================
# 第 5 步：启动 app（含生成 /admin-login 登录）
# ============================================================================
echo
printf '%s== %s 3/3 [app]==%s\n' "${C_BOLD}" "${C_RST}"
"${COMPOSE[@]}" up -d app
sleep 3
curl -fsS "http://127.0.0.1:3000/api/auth" >/dev/null 2>&1 \
  && announce app-up done "应用已响应 /api/auth" \
  || announce app-up wait "应用未在 3000 响应，稍后执行 deploy/doctor/status.sh"

echo
doc_log "进场脚本完成。下一步："
printf '  1. bash deploy/doctor/aura-doctor.sh       # 全量体检（展开式逐步反馈）\n'
printf '  2. bash deploy/docker/fix-crlf.sh --install # (若用 systemd) 装定时任务\n'
printf '  3. 配置安全门后即可用 status / tail-errors 查看状态\n'