/**
 * 单个学习目标详情页面路由。
 *
 * 组件：
 * - GoalDetailPage：将路由中的目标 ID 传递给详情展示组件。
 */

import { LearningGoalDetail } from "@/modules/profile/presentation/components/learning-goal-detail";

export default async function GoalDetailPage({
  params,
}: Readonly<{ params: Promise<{ goalId: string }> }>) {
  const { goalId } = await params;
  return <LearningGoalDetail goalId={goalId} />;
}
