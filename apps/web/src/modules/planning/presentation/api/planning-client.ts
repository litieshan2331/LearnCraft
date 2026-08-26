/**
 * 学习计划与节点的同源 BFF 客户端。
 *
 * 导出：
 * - getLearningPlan：读取完整学习路线。
 * - getPlanNode：读取单个章节详情。
 * - PlanningApiError：向展示层提供稳定的 API 错误信息。
 */

export interface LearningPlanNode {
  id: string;
  plan_id: string;
  node_key: string;
  ordinal: number;
  title: string;
  node_brief: string;
  learning_objective: string;
  rationale: string | null;
  difficulty: number;
  estimated_minutes: number;
  completion_criteria: string[];
  status: string;
  content_status: string;
  prerequisite_node_ids: string[];
}

export interface LearningPlan {
  id: string;
  goal_id: string;
  version: number;
  title: string;
  summary: string | null;
  status: string;
  profile_version: number;
  schema_version: string;
  nodes: LearningPlanNode[];
  created_at: string;
  updated_at: string;
}

export interface PlanNode extends LearningPlanNode {
  goal_id: string;
  plan_title: string;
  plan_status: string;
}

export type PlanGenerationAgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface PlanGenerationAgentRun {
  id: string;
  run_type: "plan_generate" | string;
  status: PlanGenerationAgentRunStatus;
  plan_result?: {
    learning_plan_id: string;
    node_count: number;
  };
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
}
interface ApiErrorResponse {
  error?: {
    code?: string;
    message?: string;
    field_errors?: Array<{ field: string; message: string }>;
  };
}

export class PlanningApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly fieldErrors: Array<{ field: string; message: string }> = [],
  ) {
    super(message);
    this.name = "PlanningApiError";
  }
}

export function getLearningPlan(planId: string): Promise<LearningPlan> {
  return requestJson<LearningPlan>("/api/v1/learning-plans/" + planId);
}

export function getPlanNode(nodeId: string): Promise<PlanNode> {
  return requestJson<PlanNode>("/api/v1/plan-nodes/" + nodeId);
}

export function createPlanGenerationRun(
  goalId: string,
  idempotencyKey: string,
): Promise<PlanGenerationAgentRun> {
  return requestJson<PlanGenerationAgentRun>("/api/v1/learning-goals/" + goalId + "/plans", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({}),
  });
}

export function getPlanGenerationRun(agentRunId: string): Promise<PlanGenerationAgentRun> {
  return requestJson<PlanGenerationAgentRun>("/api/v1/agent-runs/" + agentRunId);
}
async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw await createApiError(response);
  }

  return response.json() as Promise<T>;
}

async function createApiError(response: Response): Promise<PlanningApiError> {
  const payload = await response.json().catch((): ApiErrorResponse => ({}));
  return new PlanningApiError(
    payload.error?.code ?? "REQUEST_FAILED",
    payload.error?.message ?? "学习计划暂时无法读取，请稍后重试。",
    payload.error?.field_errors ?? [],
  );
}