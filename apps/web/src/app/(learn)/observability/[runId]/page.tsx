/**
 * Agent 观测轨迹详情页面路由。
 *
 * 组件：ObservabilityRunDetailPage 负责摘要、历史轨迹和 SSE 断线续传。
 */

import { ObservabilityRunDetailPage } from "@/modules/observability/presentation/components/observability-pages";

export default async function ObservabilityDetailPage({ params }: Readonly<{ params: Promise<{ runId: string }> }>) {
  const { runId } = await params;
  return <ObservabilityRunDetailPage runId={runId} />;
}
