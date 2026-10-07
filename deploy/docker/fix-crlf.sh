#!/usr/bin/env bash
# ============================================================================
# 换行符规范化（LF 化）+ 一键安装备份定时任务
#
# 解决的问题（实测，非推测）：
#   项目在 Windows 上开发，deploy/ 下的脚本与配置默认带 CRLF。
#   部署到 Linux 后：
#     · 带 \r 的 shebang → exec 直接失败（exit 255，no such file or directory），
#       内核按字面文件名找 "xxx.sh\r"。容器永远起不来/定时任务永远不跑。
#     · systemd unit 带 \r → Failed to parse，静默不生效（最坑的一类：
#       以为备份在跑，其实一次都没跑过）
#     · Nginx 配置带 \r → nginx -t 可能侥幸通过，但正则/日志被污染
#
# 用法：
#   bash deploy/docker/fix-crlf.sh              # 只做 LF 化+ 自检
#   bash deploy/docker/fix-crlf.sh --install    # LF 化 + 安装 systemd 定时任务
#
# 幂等：可重复执行，已是 LF 的文件不改动。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

log()  { printf '[fix-crlf] %s\n' "$*"; }
warn() { printf '[fix-crlf] ⚠️  %s\n' "$*" >&2; }
die()  { printf '[fix-crlf] 错误：%s\n' "$*" >&2; exit 1; }

# ---- CR 检测函数（关键实现，勿简化）---------------------------------------
# 为什么不用 `grep -q $'\r'` 或 `grep -c $'\r'`：
#   **本脚本自己可能就是 CRLF 文件**（在 Windows 上开发，未被 .gitattributes 规范化）。
#   实测确认：CRLF 版脚本里的 `$'\r'` 会被 bash 解析成含字面 CR 的两字符模式，
#   对任何文件都匹配不上 → 检测永远为假 → 脚本报告"所有文件已是 LF"而实际
#   一个字节都没改。这是最危险的一类 bug：**报成功但没干活**。
#
# 为什么不用 `grep -c $'\r'`：
#   在 Git Bash（Windows）上实测返回 0（假阴性）；同一次检查换命令又返回正确值，
#   行为不稳定，不可依赖。
#
# 采用 `tr -dc '\r' | wc -c`：'\r' 在 tr 的字符类里是被直接识别的转义，
# 不经过 bash 的 $'...' 二次解析，因此在 CRLF 脚本和 LF 脚本里行为一致。
# 实测：crlf.txt → 2，lf.txt → 0。
has_cr() {
    local f="$1"
    [ -f "${f}" ] || return 1
    [ "$(tr -dc '\r' < "${f}" 2>/dev/null | wc -c | tr -d ' ')" -gt 0 ]
}

INSTALL_TIMER=0
[ "${1:-}" = "--install" ] && INSTALL_TIMER=1

# ---- 第1 步：找出所有需要 LF 化的文件 ---------------------------------------
# 范围刻意收敛在 deploy/ ：只处理会被直接交给 Linux 内核/systemd/nginx 的文件。
# 不碰 src/ 与 *.md —— 业务代码里 CRLF 无害，src/ 若也含 CR 应由 .gitattributes
# 在提交时解决，而不是在这里做无差别改写。
TARGETS=()
while IFS= read -r -d '' f; do
    TARGETS+=("${f}")
done < <(find "${APP_ROOT}/deploy" \
              -type f \
              \( -name '*.sh' -o -name '*.service' -o -name '*.timer' \
                 -o -name '*.conf' -o -name '*.template' -o -name 'Dockerfile' \) \
              -not -path '*/node_modules/*' -print0)

[ "${#TARGETS[@]}" -gt 0 ] || die "在 ${APP_ROOT}/deploy 下没找到任何目标文件"

# ---- 第 2 步：LF 化------------------------------------------------------------
CHANGED=0
for f in "${TARGETS[@]}"; do
    if has_cr "${f}"; then
        # sed -i 的 \r 在替换文本里是字面 CR，删除即可；
        # 这里不用 dos2unix —— 目标机不一定装了，而且 coreutils 的 tr 依赖 locale。
        #
        # 二次确认：has_cr 判定为真才执行 sed，并在 sed 后复检。
        # "改了却没改成功"必须当场暴露，不能留到部署那天。
        sed -i 's/\r$//' "${f}"
        if has_cr "${f}"; then
            die "LF 化失败（sed 后仍含 CR）：${f#${APP_ROOT}/}"
        fi
        CHANGED=$((CHANGED + 1))
        log "已 LF 化：${f#${APP_ROOT}/}"
    fi
done

if [ "${CHANGED}" -eq 0 ]; then
    log "所有 ${#TARGETS[@]} 个文件已是 LF，无需改动（幂等 ✓）"
else
    log "共修正 ${CHANGED} 个文件的行尾符"
fi

# ---- 第 3 步：自检（这一步才是真有价值的部分）-------------------------------
# 只报告不修复的残留：这些文件 LF 化了但可能还有别的问题（如 shebang 缺失）。
FAILED=0
for f in "${TARGETS[@]}"; do
    if has_cr "${f}"; then
        warn "仍含 CR：${f#${APP_ROOT}/}"
        FAILED=$((FAILED + 1))
    fi
done

# ---- 第 3.5 步：补可执行位 ----------------------------------------------------
# systemd 的 ExecStart 指向 .sh 时没有 +x 会直接失败（"Permission denied"）。
for f in "${TARGETS[@]}"; do
    case "${f}" in
        *.sh) ;;
        *) continue ;;
    esac
    if [ ! -x "${f}" ]; then
        log "补可执行位：${f#${APP_ROOT}/}"
        chmod +x "${f}"
    fi
done

# ---- 第 3.6 步：shell 语法自检 -------------------------------------------------
# 只对 .sh 做 bash -n。语法错到部署时才炸，排查成本远高于现在花 10ms。
for f in "${TARGETS[@]}"; do
    case "${f}" in
        *.sh) ;;
        *) continue ;;
    esac
    if command -v bash >/dev/null 2>&1; then
        bash -n "${f}" 2>/dev/null || warn "语法错误：${f#${APP_ROOT}/}（执行 bash -n \"$f\" 查看详情）"
    fi
done

[ "${FAILED}" -eq 0 ] || die "仍有 ${FAILED} 个文件含 CR，请检查上面的 sed 是否被 filter 掉"
log "行尾符自检通过"

# ---- 第 4 步：安装 systemd 定时任务 -----------------------------------------
install_timers() {
    command -v systemctl >/dev/null 2>&1 || die "这台机器没有 systemctl，跳过定时任务安装"

    UNIT_DIR="${HAIOU_SYSTEMD_DIR:-/etc/systemd/system}"
    [ -d "${UNIT_DIR}" ] || die "找不到 ${UNIT_DIR}，请用 HAIOU_SYSTEMD_DIR 指定"

    # Docker 部署形态：备份/演练走容器内执行，unit 用 deploy/docker/systemd/ 下的 Docker 版。
    log "写入 systemd 单元到 ${UNIT_DIR}"
    for u in haiou-docker-backup.service haiou-docker-backup.timer \
             haiou-docker-restore-check.service haiou-docker-restore-check.timer \
             haiou-docker-maintenance.service haiou-docker-maintenance.timer \
             haiou-docker-log-prune.service haiou-docker-log-prune.timer; do
        src="${APP_ROOT}/deploy/docker/systemd/${u}"
        [ -f "${src}" ] || die "缺少单元文件：${src}"

        # 单元文件里的 /opt/haiou 是占位符，必须替换成实际部署路径。
        # 直接 cp 而不替换 = ExecStart 指向不存在的文件，
        # systemd 会报 "No such file or directory" 且 timer 一直不绿。
        sed "s#/opt/haiou#${APP_ROOT}#g" "${src}" > "${UNIT_DIR}/${u}"
        chmod 0644 "${UNIT_DIR}/${u}"
        log "  安装 ${u}（路径 → ${APP_ROOT}）"
    done

    # 安装后立刻验证路径正确性：ExecStart 指向的文件必须存在且可执行。
    # 这一步能在 enable 之前就抓出"路径写错"这类低级错误。
    for u in haiou-docker-backup.service haiou-docker-restore-check.service \
             haiou-docker-maintenance.service haiou-docker-log-prune.service; do
        exe="$(grep -E '^ExecStart=' "${UNIT_DIR}/${u}" | head -n1 | cut -d= -f2- || true)"
        [ -n "${exe}" ] || die "${u} 里没有 ExecStart"
        if [ ! -x "${exe}" ]; then
            die "${u} 的 ExecStart 不可执行：${exe}
  常见原因：脚本没有 +x 位。修复：chmod +x ${exe}"
        fi
    done

    # systemd 自身也校验一遍单元语法（不启动服务）
    systemd-analyze verify "${UNIT_DIR}/haiou-docker-backup.service" \
        > /dev/null 2>&1 || warn "systemd-analyze verify 有告警（不影响安装，请人工确认上面日志）"

    systemctl daemon-reload

    # 先 enable 再 start --now：让"机器当时关机"的补跑机制（Persistent=true）生效，
    # 否则历史积压的定时点不会被补。
    systemctl enable haiou-docker-backup.timer haiou-docker-restore-check.timer \
                     haiou-docker-maintenance.timer haiou-docker-log-prune.timer >/dev/null
    systemctl start  haiou-docker-backup.timer haiou-docker-restore-check.timer \
                     haiou-docker-maintenance.timer haiou-docker-log-prune.timer

    echo
    log "定时任务已启用："
    systemctl list-timers 'haiou-docker-*' --no-pager --all | sed 's/^/    /'
    echo
    log "立即试跑一次备份（验证脚本可用，不等今晚）："
    log "    systemctl start haiou-docker-backup.service"
    log "立即试跑一次维护任务（订单过期/充值推进/凭证抹除）："
    log "    systemctl start haiou-docker-maintenance.service"
    log "查看结果："
    log "    journalctl -u haiou-docker-backup.service -n 50 --no-pager"
    log "    journalctl -u haiou-docker-maintenance.service -n 50 --no-pager"
    echo
    log "取消定时：systemctl disable --now haiou-docker-backup.timer haiou-docker-restore-check.timer haiou-docker-maintenance.timer haiou-docker-log-prune.timer"
}

if [ "${INSTALL_TIMER}" -eq 1 ]; then
    install_timers
else
    echo
    log "未安装定时任务（加 --install 参数可一并安装）："
    log "    bash deploy/docker/fix-crlf.sh --install"
fi

# ---- nginx 配置改动提示 ------------------------------------------------------
# 本脚本的扫描范围含 deploy 下的 *.conf 与 *.template，也就是**nginx 配置也在内**
# （deploy/docker/nginx/nginx.conf 与各 templates/conf.d/*.template）。
# 修复 CRLF 只改磁盘上的源文件，容器并不会自动感知，所以必须显式提示，
# 否则运维会以为"跑完脚本就完事了"，而线上仍在跑旧配置。
if [ "${CHANGED}" -gt 0 ]; then
    if grep -q "conf\|template" <<<"${TARGETS[*]}"; then
        echo
        log "⚠️ 本次改动涉及 .conf / .template（含 nginx 配置），磁盘文件已改但容器不会自动感知："
        log "   1) 先验证语法：   bash deploy/docker/nginx-verify.sh --quick"
        log "   2) 再平滑重载：   bash deploy/docker/nginx-verify.sh --reload"
        log "   若 Nginx 是构建时 COPY 进镜像的，还需重建：docker compose ... build nginx && up -d nginx"
    fi
fi

echo
log "完成。"