#!/usr/bin/env bash
# ============================================================================
# ops.sh — haiou 运维统一入口（一个命令分发所有 sh + 断点/dry-run）
#
# 目标：把零散在 deploy/docker/、deploy/doctor/ 的各脚本收拢到一个入口，
#       同时支持"断点测试"——先 --dry-run 看要跑什么（不执行），再正式跑。
#
#   bash deploy/ops.sh list                      # 列出所有可用子命令
#   bash deploy/ops.sh backup                    # 立即备份
#   bash deploy/ops.sh doctor --only=ports       # 只跑端口安全体检（断点：先单跑一条）
#   bash deploy/ops.sh --dry-run backup          # 断点测试：只打印要跑的命令，不执行
#   bash deploy/ops.sh nginx-verify              # Nginx 校验
#
# 说明：**不物理搬动任何脚本**。deploy/docker/*.sh 与 deploy/doctor/*.sh 保持原位，
#     因为 4 个 systemd 定时器硬编码引用 /opt/haiou/deploy/docker/*.sh，移动会破坏已装 unit。
#     本脚本只做「按名分发」，是纯转发层，零系统副作用。
#
# 关联：deploy/运维总控.md（看懂跑什么 -> 跑哪条）。
# ============================================================================
set -euo pipefail

# ---- 定位项目根 + 待分发脚本目录 --------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DK="${SCRIPT_DIR}/docker"     # 宿主机脚本（被 systemd 定时调用）
DR="${SCRIPT_DIR}/doctor"      # 体检/初始化/状态套件
CH="${DR}/checks"              # 独立子检查

# ---- 参数解析：--dry-run（断点）可放在任意位置 ---------------------------------
DRY=0
CMD=""
CMD_ARGS=()
for a in "$@"; do
    case "${a}" in
        --dry-run|--dry*|-n) DRY=1 ;;
        --help|-h) CMD="help" ;;
        -*) CMD_ARGS+=( "${a}" ) ;;   # 其余 -xxx 透传给目标脚本
        *)
            if [ -z "${CMD}" ]; then CMD="${a}"; else CMD_ARGS+=( "${a}" ); fi
            ;;
    esac
done

# ---- 声明到脚本的映射（子命令 -> 实际脚本）--------------------------------------------
declare -A ROUTE=(
    # 备份/恢复/维护/日志（宿主机定时）
    [backup]="${DK}/backup.sh"
    [restore-check]="${DK}/restore-check.sh"
    [maintenance]="${DK}/maintenance.sh"
    [log-prune]="${DK}/log-prune.sh"
    [nginx-verify]="${DK}/nginx-verify.sh"
    [nginx-install]="${DK}/fix-crlf.sh"          # 附 --install
    [lf-fix]="${DK}/fix-crlf.sh"
    # 运维/体检/状态
    [status]="${DR}/status.sh"
    [logs]="${DR}/logs.sh"
    [doctor]="${DR}/haiou-doctor.sh"
    [init]="${DR}/init.sh"
    [secure-user]="${DR}/secure-user.sh"
    # 独立子检查（断点：可单独一条）
    [port]="${CH}/ports.sh"
    [ports]="${CH}/ports.sh"
    [connect]="${CH}/connect.sh"
    [db]="${CH}/db.sh"
    [admin]="${CH}/admin.sh"
    [cloudflare]="${CH}/cloudflare.sh"
)

DESC=(
  "backup          立即备份数据库（pg_dump -Fc + sha256）"
  "restore-check   立即恢复演练（还原到临时库核对后删）"
  "maintenance     跑一次维护：订单过期/充值推进/凭证抹除"
  "log-prune       按类别清理过期日志（DRY_RUN=1 可只看）"
  "nginx-verify    nginx 容器内 nginx -t 校验"
  "nginx-install   fix-crlf --install（LF化 + 装 systemd 定时器）"
  "status          运维面板（备份新鲜度/端口/磁盘）"
  "logs [类] [行数] 看日志（app|error|audit|payment）"
  "doctor [--only=] 全量体检（db/admin/connect/ports/cloudflare）"
  "ports           只跑端口安全体检"
  "connect         只跑连通性体检"
  "db|admin|cloudflare  单个子检查"
  "init            首次部署向导"
  "secure-user     建受限用户跑 docker（默认打印，--apply 执行）"
  "list|help       列出全部子命令 / 帮助"
)

# ---- 无命令 → 打印等价命令列表 ----------------------------------------------------
if [ -z "${CMD}" ] || [ "${CMD}" = "list" ] || [ "${CMD}" = "help" ]; then
    echo "用法：bash deploy/ops.sh <子命令> [参数]   （任意位置可加 --dry-run 只看不跑）"
    echo ""
    echo "子命令："
    printf '   %s\n' "${DESC[@]}" | sed 's/^/  /'
    exit 0
fi

# ---- 找到目标脚本 ----------------------------------------------------------------
# nginx-install 特例：等价于 fix-crlf --install
if [ "${CMD}" = "nginx-install" ]; then
    TARGET="${DK}/fix-crlf.sh"
    # 在原有透传参数前插入 --install（用独立数组，避免 "${arr[@]:-}" 展开出空元素）
    NEW_ARGS=( --install )
    [ "${#CMD_ARGS[@]}" -gt 0 ] && NEW_ARGS+=( "${CMD_ARGS[@]}" )
    CMD_ARGS=( "${NEW_ARGS[@]}" )
else
    TARGET="${ROUTE[${CMD}]:-}"
fi

if [ -z "${TARGET}" ]; then
    echo "未知子命令：${CMD}。用：bash deploy/ops.sh list"
    exit 1
fi

[ -f "${TARGET}" ] || { echo "找不到脚本：${TARGET}"; exit 1; }

# ---- 断点(dry-run) 只打印不执行 --------------------------------------------------------
if [ "${DRY}" -eq 1 ]; then
    echo "[ops] (dry-run/断点) 将执行："
    printf '   %s %s\n' "bash ${TARGET}" "${CMD_ARGS[*]}"
    echo "      （只打印，未运行。）"
    exit 0
fi

# ---- 真跑 -------------------------------------------------------------------------------
# 信息日志走 stderr，保证 stdout 只含子脚本的真实输出（可被管道/脚本安全消费，不污染）
printf '[ops] 运行：bash %s %s\n' "${TARGET}" "${CMD_ARGS[*]}" >&2
exec bash "${TARGET}" "${CMD_ARGS[@]}"