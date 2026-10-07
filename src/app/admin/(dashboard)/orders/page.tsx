import OrderManagement from "@/components/admin/orders";

// 支持深链：概览页的「去处理 / 去核对」会跳到 ?status=processing / ?status=pending，
// 由服务端把筛选条件读出来交给客户端首屏，省去一次无效的全量请求。
export default async function OrdersPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const query = await searchParams;
  return <OrderManagement initialQuery={query.q || ""} initialStatus={query.status || ""}/>;
}
