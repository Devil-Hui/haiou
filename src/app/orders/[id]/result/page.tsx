import OrderView from "@/components/order-view";

// 访客凭取卡密码从订单查询页跳过来时，**不再**用 ?pw= 把密码带进结果页。
//
// 此前：/orders/<id>/result?pw=<取卡密码>
// URL 会进浏览器历史、Nginx access.log、Referer 与买家的截图，而取卡密码是账号级
// 凭据（凭「购买邮箱 + 取卡密码」可查回全部历史订单并领卡）。
// 现在改由 sessionStorage 在当前标签页内交接（见 lib/client.ts 的 saveOrderPassword）。
export default async function ResultPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <OrderView id={id} view="result" />;
}
