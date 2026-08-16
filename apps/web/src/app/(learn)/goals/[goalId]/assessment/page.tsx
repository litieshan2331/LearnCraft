/**
 * 学习目标前测配置页面路由。
 *
 * 组件：
 * - AssessmentGenerationPage：将动态学习目标 ID 传递给前测生成流程。
 */

import { AssessmentGenerationFlow } from "@/modules/assessment/presentation/components/assessment-generation-flow";

export default async function AssessmentGenerationPage({
  params,
}: Readonly<{ params: Promise<{ goalId: string }> }>) {
  const { goalId } = await params;
  return <AssessmentGenerationFlow goalId={goalId} />;
}
