import { logger } from "@/lib/core";

/**
 * 管理后台访问闸门。
 *
 * 分三层，缺一不可：
 *   1. **入口隐蔽** —— 登录页放在 /admin-login，而不是 /admin-login。
 *      前台商城不提供任何指向后台的链接，翻遍前端代码也找不到入口。
 *   2. **生产默认关闭** —— 生产环境必须显式设置 ADMIN_ACCESS=true 才放行。
 *      默认关闭意味着「忘记开」的后果是打不开（安全），
 *      而不是「忘记关」的后果是裸奔（危险）。
 *   3. **真实鉴权** —— 前两层都只是纵深防御的浅层；
 *      真正的防线是 currentAdmin() 的会话校验，任何一层被绕过也进不去。
 *
 * 为什么不做成「默认开放」：绝大多数事故的成因是「以为关了其实没关」。
 * 宁可上线时多改一个环境变量，也不要让漏改直接等于后台公开。
 *
 * 开启动作会记审计：谁在什么时候打开了后台，必须可追溯。
 */
export const ADMIN_ACCESS_ENV = "ADMIN_ACCESS";

export type AdminAccess = { allowed: boolean; reason: string };

/**
 * 「已放行」是否已在本进程记过。
 *
 * 这条审计此前写在 adminAccess() 内部，而这个函数从「页面加载时检查一次」
 * 变成了「每个后台 API 请求都检查一次」（闸门必须覆盖 /api/admin/* 与
 * /api/auth）。于是正常运营的后台会产生 120 条/分钟/人的审计噪音，
 * 把真正的资金类审计事件（订单状态变更、卡密补发）完全淹没。
 *
 * 改为每进程只记一次：进程重启意味着部署或配置可能变了，重新记一次是合理的，
 * 而同一个进程生命周期内「这个开关是开着的」是既定事实，不需要重复记录。
 */
let grantedLogged = false;

export function adminAccess(): AdminAccess {
  // 开发与测试环境始终放行。否则本地开发每次都要配环境变量，
  // 久而久之就会习惯性把它设成 true —— 那等于生产也会被打开。
  if (process.env.NODE_ENV !== "production") return { allowed: true, reason: "dev" };

  const raw = (process.env[ADMIN_ACCESS_ENV] || "").trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes") {
    if (!grantedLogged) {
      grantedLogged = true;
      logger.audit("admin.access_granted", { via: ADMIN_ACCESS_ENV });
    }
    return { allowed: true, reason: "explicitly_enabled" };
  }
  return {
    allowed: false,
    reason: `生产环境默认关闭。请在服务器环境变量中设置 ${ADMIN_ACCESS_ENV}=true 后重启服务。`,
  };
}
