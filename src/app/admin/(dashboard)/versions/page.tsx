import type { Metadata } from "next";
import { SystemVersions } from "@/components/admin/versions";

export const metadata: Metadata = { title: "系统更新" };

export default function Page() {
  return <SystemVersions/>;
}
