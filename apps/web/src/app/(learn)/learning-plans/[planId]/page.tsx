/**
 * 学习计划路线展示页面路由。
 *
 * 组件：
 * - LearningPlanPage：将动态计划 ID 传递给路线展示组件。
 */

import { LearningPlanView } from "@/modules/planning/presentation/components/learning-plan-view";

export default async function LearningPlanPage({
  params,
}: Readonly<{ params: Promise<{ planId: string }> }>) {
  const { planId } = await params;
  return <LearningPlanView planId={planId} />;
}