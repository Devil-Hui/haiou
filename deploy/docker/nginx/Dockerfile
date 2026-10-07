# 说明：原# syntax=docker/dockerfile:1 已注释掉——它需要在构建时拉取
# docker/dockerfile 前端镜像，国内网络常不可达，导致构建直接失败。
# 去掉后使用 Docker 内置语法，功能上无差异（只是不支持新版 frontend 特性）。
# 如需启用，请先确保能访问 registry-1.docker.io。
#
# Nginx 运行镜像（Alpine 系）。
#
# 为什么不用官方 nginx:alpine，而是从 alpine 自己装 nginx：
#
#  官方 nginx:*-alpine 镜像**不编译 brotli**（nginx -V 里没有 ngx_http_brotli_filter_module），
#  而 Alpine 官方仓库提供 brotli 的动态模块 nginx-mod-http-brotli。
#  动态模块必须与 nginx 主二进制**同版本**，所以两条路只能二选一：
#    A. 官方 nginx 镜像 + 自行编译 brotli（构建链重、构建慢、还要装编译工具链）
#    B. Alpine 官方 nginx + 官方 brotli 动态模块（apk 一行，版本天然对齐）
#  选 B。版本在构建时被 apk 钉死，不存在手工对齐的隐患。
#
# 代价：nginx 版本跟 Alpine 走（1.28.x），拿不到官方 mainline 的 1.29。
# 对本项目无影响——用到的都是稳定多年的模块。
#
# 基础镜像请用与 .env 里 NGINX_IMAGE_PREFIX 一致的仓库（国内走 daocloud 加速）。
ARG ALPINE_IMAGE=alpine:3.22

FROM ${ALPINE_IMAGE}

# 版本与仓库地址都可被 .env 覆盖：
#   docker compose build --build-arg ALPINE_IMAGE=docker.m.daocloud.io/library/alpine:3.22
# 版本策略见 .env.example 的「镜像版本策略」一节。
#
# nginx-mod-http-brotli 必须与 nginx 同一次 apk 事务安装：
# apk 会校验依赖版本，跨事务安装可能拉到不匹配的模块二进制。
RUN apk add --no-cache \
      nginx=1.28.3-r7 \
      nginx-mod-http-brotli=1.28.3-r7 \
      ca-certificates \
      tzdata \
      gettext \
      curl \
      bash \
 && update-ca-certificates

# 时区：容器默认 UTC，日志时间与排查对不上
ENV TZ=Asia/Shanghai

# 主配置以模板形式存放，启动时由 entrypoint.sh 渲染成nginx.conf。
# 原因见 entrypoint.sh 顶部注释（main 上下文指令不会被官方脚本渲染）。
COPY nginx.conf      /etc/nginx/nginx.conf.template
COPY entrypoint.sh   /entrypoint-haiou.sh

# conf.d 站点配置模板。官方 entrypoint 会把这里的 .template 渲染到 /etc/nginx/conf.d/
COPY templates/      /etc/nginx/templates/

# ---- 清除 CRLF（重要，勿删）------------------------------------------------
# 本项目在 Windows 上开发，文件入库常带CRLF。Linux 下 CRLF 不是"格式不美观"
# 而是**功能性故障**，实测结论：
#   ·带 \r 的 shebang → 执行直接失败：
#     `exec /entrypoint-haiou.sh: no such file or directory`，容器永远起不来
#     （内核找的是字面量文件名 "/entrypoint-haiou.sh\r"）
#   · 带 \r 的 Nginx 配置 → `nginx -t` 居然能过，但日志/正则里的 \r 会污染匹配，
#     属于更难排查的隐性故障
# 所以在镜像内统一收敛为 LF。这比在开发机上约定"记得存 LF"可靠得多——
# 约定会被某次 Windows 上的另存为打破，而这里是最后一道闸。
RUN find /etc/nginx/templates -type f -name '*.template' -exec sed -i 's/\r$//' {} + \
 && sed -i 's/\r$//' /etc/nginx/nginx.conf.template \
 && sed -i 's/\r$//' /entrypoint-haiou.sh \
 && chmod +x /entrypoint-haiou.sh \
 # 兜底自检：shebang 必须是干净的 LF。放在构建阶段失败，
 # 好过等docker compose up 之后才看到一个看不懂的 exec 错误。
 && if od -c /entrypoint-haiou.sh | grep -q '\\r'; then \
        echo 'FATAL: /entrypoint-haiou.sh 仍含 CR，sed 未生效'; exit 1; \
    fi

# 让envsubst 只替换我们指定的变量。
#
# 这一步很关键：官方镜像的 envsubst 脚本默认会把 **所有** ${VAR} 都替换掉，
# 而我们的配置里有大量 Nginx 运行时变量（$host、$remote_addr、$request_uri …）。
# 一旦被envsubst 清空，Nginx 会把 "$host" 当成未知变量，日志和转发全乱。
# NGINX_ENVSUBST_FILTER 限定只替换白名单前缀（ Haiou_NGINX_ / NGINX_ / SITESET_ ）。
ENV NGINX_ENVSUBST_FILTER="^(HAIOU_NGINX_|NGINX_|SITESET_)"

# 挂载点：
#   /etc/nginx/templates  模板（envsubst 源）
#   /etc/nginx/conf.d     生成结果（Nginx 实际加载）
#   /var/cache/nginx      缓存目录（proxy_cache / open_file_cache）
#   /var/log/nginx        访问与错误日志
# 日志与缓存都不写镜像层，容器重建不丢、也不撑大镜像。
VOLUME ["/var/cache/nginx", "/var/log/nginx"]

# 80/443：仅在 compose 里按需映射到宿主机，这里声明只为可读性
EXPOSE 80 443

# 健康检查用 nginx -t 探测配置有效性 + 本地探活。
# 不用 80 端口 curl：容器内 curl 走 loopback，不经过 server 块的域名匹配，
# 会命中默认 server，测不到真实站点的健康状态。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:9443/nginx-health || exit 1

STOPSIGNAL SIGQUIT

# 官方镜像的 entrypoint 会做两件事，我们都需要：
#   1. 遍历 /etc/nginx/templates/**.template 做 envsubst
#   2. 校验生成结果并在必要时启动
# 我们自己的 entrypoint 先渲染主配置并做证书 fail-fast 检查，再转交官方脚本。
ENTRYPOINT ["/entrypoint-haiou.sh"]
CMD ["nginx", "-g", "daemon off;"]