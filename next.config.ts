import type { NextConfig } from "next";
import os from "node:os";

// Next.js 16 默认只放行 localhost 访问开发服务器（防止 dev 资源被未授权读取）。
// 一旦用局域网 IP 访问（本机联调、同事设备调试），开发态资源与 HMR WebSocket 会被
// 跨源保护拦掉，表现为两条同源报错：HMR 连不上、CSS 预加载后没被使用（页面无样式）。
//
// 这里在开发模式下自动放行本机所有局域网 IPv4；也可用 NEXT_ALLOWED_DEV_ORIGINS 精确指定
// （逗号分隔，只写主机名，不带协议与端口——该配置只匹配 Origin 的主机名部分）。
// 生产模式下返回空数组，不产生任何影响。
function resolveDevOrigins(): string[] {
  const explicit = (process.env.NEXT_ALLOWED_DEV_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (explicit.length) return explicit;
  if (process.env.NODE_ENV !== "development") return [];
  const hosts = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === "IPv4" && !entry.internal) hosts.add(entry.address);
    }
  }
  return [...hosts];
}

// Applied to every route: no MIME sniffing, no framing, and no access to device APIs this
// site never uses (a compromised inline script then cannot silently reach the camera).
const baseline = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
];

// HSTS only in production. Over plain http browsers ignore it anyway, and emitting it in local
// development would pin localhost to https and break every other project on the same port.
// includeSubDomains is deliberately left out until every subdomain is known to serve https.
const transport = process.env.NODE_ENV === "production"
  ? [{ key: "Strict-Transport-Security", value: "max-age=31536000" }]
  : [];

const nextConfig: NextConfig = {
  // 关掉 Next.js 的开发指示器（页面左下角那个可展开的小面板）。
  //
  // 那是 Next.js 自带的开发工具，只在 npm run dev 时出现，**生产构建下根本不渲染**
  // ——所以它不会让访客看到英文界面，只在你自己本地开发时看到。
  //
  // 关掉它换来的是：开发时不再有"点开看编译错误/警告"的入口。
  // 代价不算大——tsc --noEmit 与 npm run lint 已经在 CI 位置覆盖了同样的检查，
  // 且这两者给出的错误信息更完整。构建失败时终端会直接打印，不会被这个面板
  // 独占。单纯为了不被英文面板干扰而留着它不划算。
  devIndicators: false,
  // 放行本机局域网 IP，保证用 IP 访问时 HMR 与样式资源都能正常加载。
  allowedDevOrigins: resolveDevOrigins(),
  // Do not advertise the framework in every response; it only helps fingerprinting.
  poweredByHeader: false,
  // gzip is done by the reverse proxy instead: Nginx runs multi-process and caches the
  // result, while Node's single thread is the scarcest resource on a small box.
  // WARNING: this assumes the proxy compresses. See deploy/docker-compose.nginx.yml (gzip on).
  // Never disable gzip there without switching this back to true.
  compress: false,
  async headers() {
    return [
      { source: "/:path*", headers: [...baseline, ...transport] },
      { source: "/admin/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, { key: "X-Robots-Tag", value: "noindex, nofollow" }] },
      // Reinforce the order-page guarantee at the header level, which wins over the meta tag.
      { source: "/orders/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },
};

export default nextConfig;
