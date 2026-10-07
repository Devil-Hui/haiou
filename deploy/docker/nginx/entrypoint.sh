#!/bin/sh
# ============================================================================
# 容器入口：渲染配置模板 → 校验 → 启动 Nginx
#
# ── 为什么全部自己实现，而不用官方 nginx 镜像的 docker-entrypoint.sh ─────────
# 本镜像基于 Alpine 官方 nginx 包（为了拿brotli 动态模块），
# 而不是 Docker Hub 的官方 nginx 镜像 —— 后者才有那个 entrypoint 脚本。
# Alpine 包里没有它，调用会直接 "not found"。
# 所以这里自己实现需要的全部逻辑，一共三步：渲染主配置、渲染 conf.d、exec Nginx。
#
# ── 渲染为什么必须用白名单模式 ────────────────────────────────────────────
# envsubst 不带参数时会替换**所有** ${VAR}。而我们的配置里
# 有大量 Nginx 运行时变量（$host、$remote_addr、$request_uri …），
# 一旦被清空，Nginx 会把 "$host" 当未知变量，日志全空、跳转失效。
# 所以显式列出要替换的变量名，其余一律不碰。
# ============================================================================
set -e

TEMPLATE_DIR="${TEMPLATE_DIR:-/etc/nginx/templates}"
MAIN_TEMPLATE="${MAIN_TEMPLATE:-/etc/nginx/nginx.conf.template}"
MAIN_CONF="${MAIN_CONF:-/etc/nginx/nginx.conf}"
CONF_D="${CONF_D:-/etc/nginx/conf.d}"

# ---- 1. 渲染主配置（worker 参数在此注入）-------------------------------------
#
# 【为什么默认值要在这里用shell 处理，而不能写 ${VAR:-default}】
# envsubst 只认纯 ${VAR} 形式，**不支持 shell 的 ${VAR:-default} 语法**。
# 若配置里写 worker_processes ${NGINX_WORKER_PROCESSES:-auto}，
# envsubst 会原样保留整串 → Nginx 报 "directive invalid value"。
# 所以：envsubst 只负责替换纯变量，未设置时替换成空串，
# 再由下面的 shell 用 sed 把空值补成默认值。
render_main_conf() {
    [ -f "${MAIN_TEMPLATE}" ] || { echo "[entrypoint] 错误：找不到 ${MAIN_TEMPLATE}" >&2; exit 1; }
    echo "[entrypoint] 渲染主配置：worker 参数"

    # 环境变量未注入时给兜底值，保证 .env 没填也能起得来（降级可用而非启动失败）。
    #
    # ⚠️ 必须 export：`: "${VAR:=default}"` 只设置当前 shell 的变量，
    # 不会导出到子进程；而 envsubst 是**子进程**，看不到未导出的变量，
    # 结果仍是替换成空串 → Nginx 报 "invalid number of arguments"。
    # 这个坑很隐蔽：worker_processes 若有 compose 传入就能过，
    # 唯独漏传的 rlimit_nofile 会失败，看起来像配置写错。
    export NGINX_WORKER_PROCESSES="${NGINX_WORKER_PROCESSES:-auto}"
    export NGINX_WORKER_CONNECTIONS="${NGINX_WORKER_CONNECTIONS:-2048}"
    export NGINX_WORKER_RLIMIT_NOFILE="${NGINX_WORKER_RLIMIT_NOFILE:-8192}"

    envsubst '${NGINX_WORKER_PROCESSES} ${NGINX_WORKER_CONNECTIONS} ${NGINX_WORKER_RLIMIT_NOFILE}' \
        < "${MAIN_TEMPLATE}" > "${MAIN_CONF}"
}

# ---- 2. 渲染 conf.d 站点配置 ------------------------------------------------
# 白名单列举所有站点配置里用到的变量。
#
# 漏一个的后果是该变量变成空字符串。例如漏掉 AURA_DOMAIN，
# server_name 会变成空 → 所有请求都落到 default_server → 全站444拒服。
render_site_confs() {
    [ -d "${TEMPLATE_DIR}/conf.d" ] || return 0
    echo "[entrypoint] 渲染站点配置：conf.d"
    mkdir -p "${CONF_D}"

    # 兜底值。必须在 envsubst 之前 export（原因同 render_main_conf 里的说明）。
    # AURA_DOMAIN 为空是最危险的失效模式：server_name 变空后所有请求都落到
    # default_server → 全站 444 拒服，而日志里看不出原因。
    export AURA_DOMAIN="${AURA_DOMAIN:-aura.example.com}"
    export NGINX_SSL_CERT="${NGINX_SSL_CERT:-/etc/nginx/certs/aura.crt}"
    export NGINX_SSL_KEY="${NGINX_SSL_KEY:-/etc/nginx/certs/aura.key}"
    export NGINX_SSL_TRUSTED_CERT="${NGINX_SSL_TRUSTED_CERT:-}"
    export NGINX_MAX_BODY_SIZE="${NGINX_MAX_BODY_SIZE:-256k}"
    export NGINX_CF_GUARD_PORT="${NGINX_CF_GUARD_PORT:-8443}"

    # OCSP 三件套（ssl_stapling / ssl_stapling_verify / ssl_trusted_certificate）
    # 只能一起启用：ssl_trusted_certificate 不接受空串，
    # 空值时 nginx -t 会报 "invalid number of arguments" 直接拒绝启动。
    # 用 Cloudflare Origin CA 时该 CA 无公共 OCSP responder，必须整组关闭。
    # 这里按变量是否有值生成整块，模板里用 ${NGINX_OCSP_BLOCK} 引用。
    if [ -n "${NGINX_SSL_TRUSTED_CERT}" ]; then
        NGINX_OCSP_BLOCK="ssl_stapling         on;
    ssl_stapling_verify  on;
    ssl_trusted_certificate  ${NGINX_SSL_TRUSTED_CERT};"
        export NGINX_OCSP_BLOCK
    else
        # 空串 → envsubst 替换成空 → 整组消失，配置里不留痕迹
        NGINX_OCSP_BLOCK=""
        export NGINX_OCSP_BLOCK
    fi

    # 清理旧的生成结果，避免改过模板后残留上一个版本的文件
    # （残留的 conf 会被 include 进来，且它的 server_name 仍生效——极难排查）
    rm -f "${CONF_D}"/*.conf
    for tpl in "${TEMPLATE_DIR}"/conf.d/*.template; do
        [ -e "${tpl}" ] || continue
        out="${CONF_D}/$(basename "${tpl}" .template)"
        envsubst '${AURA_DOMAIN} ${NGINX_SSL_CERT} ${NGINX_SSL_KEY} ${NGINX_SSL_TRUSTED_CERT} ${NGINX_OCSP_BLOCK} ${NGINX_MAX_BODY_SIZE} ${NGINX_CF_GUARD_PORT}' \
            < "${tpl}" > "${out}"
        echo "[entrypoint]  $(basename "${out}")"
    done
}

render_main_conf
render_site_confs

# ---- 3. 目录权限 ------------------------------------------------------------
# 缓存与日志目录以 nginx 用户可写。
# 我们用 volume 挂载覆盖了它们，宿主目录属主由 Docker 复制自镜像首次创建，
# 重建容器后可能变成 root —— 显式修一次，避免 reload 时报 permission denied。
for dir in /var/cache/nginx /var/log/nginx; do
    if [ -d "${dir}" ] && [ ! -w "${dir}" ]; then
        echo "[entrypoint]修复 ${dir} 属主"
        chown -R nginx:nginx "${dir}" 2>/dev/null || \
            echo "[entrypoint]警告：无法修改 ${dir} 属主。若日志报 permission denied 请手工 chown"
    fi
done

# ---- 4. 证书存在性检查（fail-fast）-------------------------------------------
# 缺证书时 Nginx 会启动失败并刷一屏看不懂的日志。这里提前给人话提示。
# 判断用「存在且非空」——空文件同样导致握手失败。
CERT="${NGINX_SSL_CERT:-/etc/nginx/certs/aura.crt}"
KEY="${NGINX_SSL_KEY:-/etc/nginx/certs/aura.key}"

if [ ! -s "${CERT}" ] || [ ! -s "${KEY}" ]; then
    cat >&2 <<EOF

════════════════════════════════════════════════════════════════════
[entrypoint] 错误：找不到 TLS 证书或私钥
  证书：${CERT}
  私钥：${KEY}

请先放置证书再启动：
  1) Cloudflare 控制台 → SSL/TLS → 源服务器 → 创建证书（Origin CA）
  2) 把生成的 cert / key 放到宿主机的 ./data/nginx/certs/
     （容器内对应路径 ${CERT} 与 ${KEY}）
  3) docker compose -f docker-compose.yml -f deploy/docker-compose.nginx.yml up -d nginx

只想本机调试不想配证书？可在 .env 里注释掉 443 相关的 server 块，
或临时用自签证书：openssl req -x509 -newkey rsa:2048 -nodes -days 365 \\
  -keyout data/nginx/certs/aura.key -out data/nginx/certs/aura.crt \\
  -subj '/CN=aura.example.com'
════════════════════════════════════════════════════════════════════

EOF
    exit 1
fi

# 私钥权限过宽时 Nginx 会拒绝加载（ssl_certificate_key 须为 0600/0640）。
# 从宿主机挂载进来的文件常带 0644，这里收紧。
KEY_MODE="$(stat -c '%a' "${KEY}" 2>/dev/null || echo 644)"
if [ "${KEY_MODE}" != "600" ] && [ "${KEY_MODE}" != "640" ]; then
    echo "[entrypoint]收紧私钥权限：${KEY_MODE} → 600"
    chmod 0600 "${KEY}" 2>/dev/null || \
        echo "[entrypoint]警告：无法修改私钥权限。若 Nginx 报 bad permissions，请手工 chmod 600 ${KEY}"
fi

# ---- 5. 校验配置后再启动 -----------------------------------------------------
# 提前跑一次 nginx -t：配置有错时启动会失败并重启循环，
# 而 compose 的 restart: unless-stopped 会一直重试，日志刷满且难看出根因。
echo "[entrypoint]校验配置……"
if ! nginx -t 2>&1; then
    echo "" >&2
    echo "[entrypoint] 配置校验失败，容器退出。请检查上面的错误行。" >&2
    echo "[entrypoint] 常见原因：envsubst 白名单漏了变量（表现为 server_name 为空）" >&2
    exit 1
fi

# ---- 6. 启动 -----------------------------------------------------------------
# exec 让Nginx 成为 PID 1，收到 docker stop 的 SIGTERM 时能优雅退出
# （worker_shutdown_timeout 生效，已有连接得以收尾）。
echo "[entrypoint]启动 Nginx"
exec "$@"