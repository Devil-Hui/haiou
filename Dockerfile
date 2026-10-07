# 多阶段构建：依赖层、构建层、运行层分开。运行镜像里只有生产依赖与编译产物——
# 构建缓存（约 63 MB）与开发依赖（typescript/eslint/drizzle-kit 等，约 70 MB）都进不来。
# 构建上下文固定为仓库根目录，下面所有 COPY 路径都是相对它的，不含任何盘符或绝对路径。
FROM node:22-alpine AS base
WORKDIR /app

# ---- 依赖层：完整依赖，供构建使用 ----
# 只拷清单文件：package.json / package-lock.json 没变时这一层直接命中缓存。
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- 生产依赖层：运行镜像只带这一份 ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
# npm 会把 next 的两个 swc 平台变体（gnu 与 musl）都装上；alpine 只加载 musl，
# gnu 变体是 93 MB 死重。sharp（@img）仅在用到 next/image 时才需要，本站零使用。
# 这里删的是运行镜像里的体积，不影响任何功能路径。
RUN npm ci --omit=dev \
 && rm -rf node_modules/@next/swc-linux-x64-gnu \
 && rm -rf node_modules/sharp node_modules/@img

# ---- 构建层 ----
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# 构建期 Next 会加载页面模块，数据库模块要求连接串可解析，这里给一个占位值。
# 真正的地址在运行时由 compose 通过 environment 注入，不写进镜像。
ARG DATABASE_URL=postgresql://haiou:haiou@db:5432/haiou
ENV DATABASE_URL=$DATABASE_URL
# .next/cache 是编译缓存（ISR / fetch 缓存），本站全部动态渲染、请求一律 no-store，
# 运行时用不到；留着只会让镜像白胖 63 MB。
RUN npm run build && rm -rf .next/cache

# ---- 运行层 ----
FROM base AS run
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
# next start 需要 package.json（读 scripts.start）与 next.config.ts。
COPY --chown=node:node package.json next.config.ts ./
#
# ---- 源码与脚本：运维任务要在容器内跑，缺了它们就只能"进不去也跑不了" --------
#
# 为什么必须拷进去（这是踩过的坑，不是可选项）：
#   scripts/maintenance.mjs（订单过期 / 充值推进 / 凭证抹除）、
#   scripts/reset-admin.mjs、create-admin.mjs 都只能在**连得到数据库的一侧**执行。
#   而 db 服务刻意**不映射宿主端口**（防 5432 暴露公网），宿主根本连不上库，
#   所以这些任务只能 `docker compose exec` 进 app 容器跑。
#   少了下面三行，容器里就没有 maintenance.mjs，定时任务必然失败——
#   且失败表现为"找不到文件"，很容易被误读成脚本写错。
#
# tsconfig.json 必须一起拷：tsx 靠它的 paths（"@/*": ["./src/*"]）解析别名，
# 少了它 `import { db } from "@/db"` 直接报 Cannot find package。
# tsx 本身在 dependencies（非 devDependencies），prod-deps 层已包含。
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node src ./src
COPY --chown=node:node tsconfig.json ./
# public/ 里的静态资源是**运行时**读取的，不是构建产物：
#   src/components/site-shell.tsx 用 next/image 引用 /images/logo.png（全站页头页脚），
#   public/images/alipay-qrcode.jpg 同理。next start 从 public/ 目录取文件，
#   少了这一行 logo 会全站 404（构建不报错，只在访问时才暴露）。
COPY --chown=node:node public ./public
#
# 日志目录：先建好并交给 node 用户。
# 注意：若用绑定挂载把宿主目录挂到 /app/logs，**宿主目录的属主会覆盖这里的设置**，
# 宿主侧必须先 `chown 1000:1000`（node 用户的 uid），否则日志写不进去——
# 而日志模块是"吞错降级"的，写失败不会报错，表现为日志静默消失（最坏的一种失败）。
RUN mkdir -p /app/logs && chown node:node /app/logs
# 不使用 root 运行：即便被攻破，拿到的也是无特权用户。
USER node
EXPOSE 3000
CMD ["npm", "run", "start"]
