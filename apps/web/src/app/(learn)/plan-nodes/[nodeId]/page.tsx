/**
 * 学习章节详情页面路由。
 *
 * 组件：
 * - PlanNodePage：将动态章节 ID 传递给章节详情展示组件。
 */

import { PlanNodeView } from "@/modules/planning/presentation/components/plan-node-view";

export default async function PlanNodePage({
  params,
}: Readonly<{ params: Promise<{ nodeId: string }> }>) {
  const { nodeId } = await params;
  return <PlanNodeView nodeId={nodeId} />;
}
