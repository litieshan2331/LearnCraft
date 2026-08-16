/**
 * 已生成前测题集展示页面路由。
 *
 * 组件：
 * - AssessmentPage：将动态题集 ID 传递给题集展示组件。
 */

import { AssessmentViewer } from "@/modules/assessment/presentation/components/assessment-viewer";

export default async function AssessmentPage({
  params,
}: Readonly<{ params: Promise<{ assessmentId: string }> }>) {
  const { assessmentId } = await params;
  return <AssessmentViewer assessmentId={assessmentId} />;
}
