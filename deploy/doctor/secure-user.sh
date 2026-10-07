#!/usr/bin/env bash
# ============================================================================
# secure-user.sh — 专用受限用户 + 目录归属（可选，非破坏性）
#
# 解决"现在用 root 进服务器，能不能建一个普通用户来跑 docker"的问题。
#
# 【先说结论，方便你判断要不要做】--------------------------------------------
# · 个人开发、服务器 IP 不公开 → 风险确实低，这一步不是"必须"。
# · 但真正的风险不在"IP 是否公开"，而在：a) 若开了 SSH 口令登录，弱口令可被
#   全网爆破；b) root 权限一旦被漏洞拿到就无可挽回。docker group 里的用户
#   拥有近似 root 的能力,所以"用受限用户跑 docker"并不能把你从 docker 漏洞里
#   救出来,它的真实价值是:**日常不用 root 登录、把事故面缩到最小**。
# · 因此本脚本**默认只生成命令、不自动执行**破坏性步骤(改 SSH、删除 root 口令),
#   由你确认后再跑。只做无害的"创建用户 + 建目录 + 授权"。
#
# 用法（建议全在 root 下执行）：
#   bash deploy/doctor/secure-user.sh                            # 生成并提示
#   bash deploy/doctor/secure-user.sh --apply                     # 实际创建(见下)
#   bash deploy/doctor/secure-user.sh --print-only               # 只打印命令
#
# 说明：为了让导入的列子等条件，脚本默认只打印命令（DRY 默认开），
# 加 --apply 才真的 useradd/usermod/chown（这些属于系统级改动，副作用不可逆）。
# 注意：docker group 的成员在多数发行版下≈root 权限（能挂载宿主目录）。
# 创建的用户只跑本项目，不给 sudo 提权；若还需管理员权，请自行评估。
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

RUN_USER="${RUN_USER:-aura-srv}"          # 建议用名的普通用户
SHELL_BIN="${SHELL_BIN:-/bin/bash}"
APPLY=0
if [ "${1:-}" = "--apply" ]; then APPLY=1; fi

say()  { printf '  %s\n' "$*"; }
step() { printf '\n%s\n' "$1"; }
die()  { printf '错误：%s\n' "$1" >&2; exit 1; }

step "1) 是否已是用单独运行用户(非 root)?"
[ "$(id -u)" -eq 0 ] || die "当前非 root，无法创建系统用户。请用 root 执行本脚本，或手动执行下方命令。"

step "2) 创建受限用户 $RUN_USER(若无)"
CMD="id \"$RUN_USER\" 2>/dev/null || useradd -m -s \"${SHELL_BIN}\" \"$RUN_USER\""
if [ "$APPLY" -eq 1 ]; then
    eval "$CMD"
    say "已创建 $RUN_USER"
else
    say "将执行：$CMD"
fi

step "3) 把用户加入 docker 组(否则无法直接 docker 命令)"
CMD="id \"$RUN_USER\" | grep -q docker || usermod -aG docker \"$RUN_USER\""
if [ "$APPLY" -eq 1 ]; then
    eval "$CMD"
    say "已加入 docker 组"
else
    say "将执行：$CMD"
fi

step "4) 建立项目数据目录并收紧属主(重要：先建好文件夹)"
DATA_DIRS="data/postgres data/logs data/backups/db data/doctor"
if [ "$APPLY" -eq 1 ]; then
    for d in $DATA_DIRS; do
        mkdir -p "$APP_ROOT/$d" && chmod 0700 "$APP_ROOT/$d"
    done
    # 容器内 node(uid1000) 需要写 logs，其余非敏感目录给运行用户
    chown -R "$RUN_USER" "$APP_ROOT/data" 2>/dev/null || true
    chown 1000:1000 "$APP_ROOT/data/logs" 2>/dev/null || true
    say "已建立 data 子目录并收紧(0700)；logs 属主=1000:1000，其余数据目录鉴主=$RUN_USER"
else
    say "将创建并收紧：$DATA_DIRS (每条 chmod 0700)"
    say "将把 data/ 属主调整为：$RUN_USER；其中 data/logs 保持 1000:1000(容器写日志)"
fi

# 让容器内 node (uid=1000) 仍能写 logs —— 上面已处理；以下仅为解释性记录

step "5) 可选加固：关闭 SSH 口令登录，只用密钥(强烈建议，需你确认再执行)"
cat <<'EOF'
  danger 提示：只在你已能通过 SSH 密钥登录后执行，否则会被锁在门外！
  建议编辑 /etc/ssh/sshd_config：
      PasswordAuthentication no
      PermitRootLogin prohibit-password
  然后： systemctl restart sshd
  本脚本**不代跑**，避免误锁。
EOF

if [ "$APPLY" -ne 1 ]; then
    echo
    echo "以上为预告。确认后执行：bash deploy/doctor/secure.sh --apply"
    echo "仅当你的 SSH 已配密钥、且你明确想用非 root 运行时再做这步。"
fi