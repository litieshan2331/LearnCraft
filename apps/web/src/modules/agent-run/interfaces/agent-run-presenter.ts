/**
 * AgentRun 对外状态快照的 HTTP Presenter。
 *
 * 导出：
 * - presentAgentRun：将领域层驼峰字段与 Date 转换为 OpenAPI 约定的 snake_case JSON 响应。
 */

import type { AgentRunSnapshot } from "../domain/agent-run";

export function presentAgentRun(agentRun: AgentRunSnapshot) {
  return {
    id: agentRun.id,
    run_type: agentRun.runType,
    status: agentRun.status,
    target_type: agentRun.targetType,
    target_id: agentRun.targetId,
    model_connection_id: agentRun.modelConnectionId,
    requested_model_id: agentRun.requestedModelId,
    retry_count: agentRun.retryCount,
    trace_id: agentRun.traceId,
    ...(agentRun.startedAt ? { started_at: agentRun.startedAt.toISOString() } : {}),
    ...(agentRun.finishedAt ? { finished_at: agentRun.finishedAt.toISOString() } : {}),
    ...(agentRun.assessmentResult ? {
      assessment_result: {
        assessment_id: agentRun.assessmentResult.assessmentId,
        question_count: agentRun.assessmentResult.questionCount,
      },
    } : {}),
    ...(agentRun.error ? { error: agentRun.error } : {}),
    created_at: agentRun.createdAt.toISOString(),
    updated_at: agentRun.updatedAt.toISOString(),
  };
}
